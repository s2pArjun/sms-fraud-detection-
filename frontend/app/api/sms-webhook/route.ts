// frontend/app/api/sms-webhook/route.ts
// Same pattern as the WhatsApp fix — respond instantly, send result via REST API

export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const body = formData.get("Body") as string
    const from = formData.get("From") as string

    if (!body) {
      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

    // ── Respond to Twilio immediately ──
    const ackTwiml = `<?xml version="1.0"?>
<Response>
  <Message>🔍 Checking this message for fraud...</Message>
</Response>`

    // Fire analysis in background
    analyzeAndReplySms(body, from).catch(err =>
      console.error("SMS background analysis failed:", err)
    )

    return new Response(ackTwiml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    })
  } catch (error) {
    console.error("SMS webhook error:", error)
    return new Response(`<?xml version="1.0"?><Response/>`, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    })
  }
}

async function analyzeAndReplySms(body: string, from: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"

  let result: any = null
  try {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: body,
        senderPhone: from,
        detectionMethod: "both",
      }),
    })
    if (!response.ok) throw new Error(`Analyze API returned ${response.status}`)
    result = await response.json()
  } catch (error) {
    console.error("SMS analyze error:", error)
    return
  }

  const risk = result?.overall?.risk ?? "low"
  if (risk === "low") return // No reply for low risk

  const mlPrediction = result?.ml?.prediction ?? "unknown"
  const mlConfidence = result?.ml?.confidence
    ? `${Math.round(result.ml.confidence * 100)}%`
    : "?"

  let replyMessage = ""
  if (risk === "high") {
    replyMessage =
      `FRAUD ALERT: Likely scam. ML:${mlPrediction}(${mlConfidence}). ` +
      `Do NOT click links or share OTPs.`
  } else if (risk === "medium") {
    replyMessage =
      `CAUTION: Suspicious message. ML:${mlPrediction}(${mlConfidence}). ` +
      `Verify before acting.`
  }

  // Send via Twilio REST API
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN
  const twilioSmsFrom = process.env.TWILIO_SMS_FROM // your Twilio phone number e.g. "+14155238886"

  if (!twilioAccountSid || !twilioAuthToken || !twilioSmsFrom) {
    console.error("Missing Twilio env vars. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_FROM")
    return
  }

  const params = new URLSearchParams({
    From: twilioSmsFrom,
    To: from,
    Body: replyMessage,
  })

  const twilioRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64")}`,
      },
      body: params.toString(),
    }
  )

  if (!twilioRes.ok) {
    console.error(`Twilio SMS failed: ${twilioRes.status} — ${await twilioRes.text()}`)
  } else {
    console.log(`SMS fraud alert sent to ${from} (risk: ${risk})`)
  }
}
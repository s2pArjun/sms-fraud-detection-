// frontend/app/api/whatsapp-webhook/route.ts
// KEY FIX: Twilio webhooks timeout at 15s. Your 5-agent analysis takes 15s+.
// Solution: Reply instantly with "Analyzing...", then send result via Twilio REST API.

export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const body = formData.get("Body") as string
    const from = formData.get("From") as string
    const cleanPhone = from?.replace("whatsapp:", "") ?? ""

    if (!body) {
      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

    // ── IMMEDIATELY respond to Twilio (beats the 15s timeout) ──
    const ackTwiml = `<?xml version="1.0"?>
<Response>
  <Message>🔍 Analyzing this message for fraud indicators... you'll receive results shortly.</Message>
</Response>`

    // Fire analysis in background — do NOT await here
    analyzeAndReply(body, from, cleanPhone).catch(err =>
      console.error("Background analysis failed:", err)
    )

    return new Response(ackTwiml, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    })
  } catch (error) {
    console.error("WhatsApp webhook error:", error)
    return new Response(`<?xml version="1.0"?><Response/>`, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    })
  }
}

async function analyzeAndReply(body: string, from: string, cleanPhone: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"

  let result: any = null
  try {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: body,
        senderPhone: cleanPhone,
        detectionMethod: "both",
      }),
    })
    if (!response.ok) throw new Error(`Analyze API returned ${response.status}`)
    result = await response.json()
  } catch (error) {
    console.error("WhatsApp analyze error:", error)
    return
  }

  const risk = result?.overall?.risk ?? "low"
  if (risk === "low") return // No reply for low risk

  const mlPrediction = result?.ml?.prediction ?? "unknown"
  const mlConfidence = result?.ml?.confidence
    ? `${Math.round(result.ml.confidence * 100)}%`
    : "?"
  const explanation = result?.overall?.explanation ?? ""

  let replyMessage = ""
  if (risk === "high") {
    replyMessage =
      `🚨 *FRAUD ALERT*\n\n` +
      `This message appears to be a scam.\n` +
      `ML: ${mlPrediction.toUpperCase()} (${mlConfidence})\n\n` +
      `${explanation}\n\n` +
      `⛔ Do NOT click any links or share OTPs.`
  } else if (risk === "medium") {
    replyMessage =
      `⚠️ *CAUTION: Suspicious Message*\n\n` +
      `ML: ${mlPrediction.toUpperCase()} (${mlConfidence})\n\n` +
      `${explanation}\n\n` +
      `Please verify before taking any action.`
  }

  // Send via Twilio REST API (not TwiML — we already sent TwiML above)
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN
  const twilioWhatsAppFrom = process.env.TWILIO_WHATSAPP_FROM // e.g. "whatsapp:+14155238886"

  if (!twilioAccountSid || !twilioAuthToken || !twilioWhatsAppFrom) {
    console.error("Missing Twilio env vars for outbound message. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM")
    return
  }

  const twilioEndpoint = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`

  const params = new URLSearchParams({
    From: twilioWhatsAppFrom,
    To: from, // the original "whatsapp:+91..." format
    Body: replyMessage,
  })

  const twilioRes = await fetch(twilioEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString("base64")}`,
    },
    body: params.toString(),
  })

  if (!twilioRes.ok) {
    const errBody = await twilioRes.text()
    console.error(`Twilio outbound message failed: ${twilioRes.status} — ${errBody}`)
  } else {
    console.log(`WhatsApp fraud alert sent to ${from} (risk: ${risk})`)
  }
}
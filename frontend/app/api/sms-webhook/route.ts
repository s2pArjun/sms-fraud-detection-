// frontend/app/api/sms-webhook/route.ts

export async function POST(req: Request) {
  try {
    // Twilio sends form-data
    const formData = await req.formData()

    const body = formData.get("Body") as string

    // If no SMS body, return empty TwiML
    if (!body) {
      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

    // IMPORTANT:
    // For localhost + ngrok, this should stay localhost
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"

    let result: any = null

    try {
      // Call your analyze API
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: body,
          detectionMethod: "both",
        }),
      })

      // If analyze fails, silently return empty TwiML
      if (!response.ok) {
        throw new Error("Analyze API failed")
      }

      result = await response.json()
    } catch (error) {
      console.error("Analyze error:", error)

      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

    // Extract results
    const risk = result?.overall?.risk ?? "low"
    const mlPrediction = result?.ml?.prediction ?? "unknown"

    const mlConfidence = result?.ml?.confidence
      ? `${Math.round(result.ml.confidence * 100)}%`
      : "?"

    // Keep reply SHORT for Twilio
    let replyMessage = ""

    if (risk === "high") {
      replyMessage =
        `FRAUD ALERT: Likely scam. ML:${mlPrediction}(${mlConfidence}). ` +
        `Do NOT click links or share OTPs.`
    } else if (risk === "medium") {
      replyMessage =
        `CAUTION: Suspicious message. ML:${mlPrediction}(${mlConfidence}). ` +
        `Verify before acting.`
    } else {
      // Low risk = no SMS reply
      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

    // Escape XML special characters
    const safeMessage = replyMessage
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")

    // TwiML response
    const twiml = `<?xml version="1.0"?>
<Response>
  <Message>${safeMessage}</Message>
</Response>`

    return new Response(twiml, {
      status: 200,
      headers: {
        "Content-Type": "text/xml",
      },
    })
  } catch (error) {
    console.error("SMS webhook error:", error)

    // Never let Twilio fail
    return new Response(`<?xml version="1.0"?><Response/>`, {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    })
  }
}
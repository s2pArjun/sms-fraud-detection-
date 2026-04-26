// frontend/app/api/whatsapp-webhook/route.ts
// Twilio WhatsApp Sandbox Webhook
// Same pattern as sms-webhook but uses WhatsApp sender prefix

export async function POST(req: Request) {
  try {
    const formData = await req.formData()

    const body = formData.get("Body") as string
    const from = formData.get("From") as string
    // Twilio sends WhatsApp numbers as "whatsapp:+919876543210"
    // Strip the prefix for clean storage in Supabase
    const cleanPhone = from?.replace("whatsapp:", "") ?? ""

    if (!body) {
      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

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

      if (!response.ok) throw new Error("Analyze API failed")
      result = await response.json()
    } catch (error) {
      console.error("WhatsApp analyze error:", error)
      return new Response(`<?xml version="1.0"?><Response/>`, {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      })
    }

    const risk          = result?.overall?.risk ?? "low"
    const mlPrediction  = result?.ml?.prediction ?? "unknown"
    const mlConfidence  = result?.ml?.confidence
      ? `${Math.round(result.ml.confidence * 100)}%`
      : "?"
    const explanation   = result?.overall?.explanation ?? ""

    // WhatsApp supports longer messages than SMS so we can be more descriptive
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
    } else {
      // Low risk — no reply needed
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

    // TwiML response — Twilio automatically sends this as WhatsApp
    const twiml = `<?xml version="1.0"?>
<Response>
  <Message>${safeMessage}</Message>
</Response>`

    return new Response(twiml, {
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
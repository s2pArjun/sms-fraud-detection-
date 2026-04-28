// frontend/app/api/gmail-webhook/route.ts

import { NextResponse } from "next/server"
import { google } from "googleapis"

export const maxDuration = 60

function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return google.gmail({ version: "v1", auth })
}

function decodeBase64(encoded: string): string {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
  return Buffer.from(base64, "base64").toString("utf-8")
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
}

function extractBody(payload: any): string {
  if (!payload) return ""
  if (payload.body?.data) {
    const decoded = decodeBase64(payload.body.data)
    return payload.mimeType === "text/html" ? stripHtml(decoded) : decoded
  }
  if (payload.parts) {
    const plainPart = payload.parts.find((p: any) => p.mimeType === "text/plain")
    if (plainPart?.body?.data) return decodeBase64(plainPart.body.data)
    const htmlPart = payload.parts.find((p: any) => p.mimeType === "text/html")
    if (htmlPart?.body?.data) return stripHtml(decodeBase64(htmlPart.body.data))
    for (const part of payload.parts) {
      const text = extractBody(part)
      if (text) return text
    }
  }
  return ""
}

async function getOrCreateLabel(gmail: any, name: string): Promise<string> {
  const { data } = await gmail.users.labels.list({ userId: "me" })
  const existing = data.labels?.find((l: any) => l.name === name)
  if (existing) return existing.id
  const { data: created } = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  })
  return created.id
}

// Dedup: track recently processed Pub/Sub message IDs in memory
const recentlyProcessed = new Set<string>()

async function processEmail(pubsubMessageId: string, historyId: string) {
  if (recentlyProcessed.has(pubsubMessageId)) {
    console.log(`Skipping duplicate Pub/Sub message: ${pubsubMessageId}`)
    return
  }
  recentlyProcessed.add(pubsubMessageId)
  setTimeout(() => recentlyProcessed.delete(pubsubMessageId), 5 * 60 * 1000)

  try {
    const gmail = getGmailClient()

    const { data: listData } = await gmail.users.messages.list({
      userId: "me",
      maxResults: 1,
      labelIds: ["INBOX"],
      q: "is:unread",
    })

    const messages = listData.messages ?? []
    if (!messages.length) {
      console.log("No unread messages found")
      return
    }

    const messageId = messages[0].id!

    const { data: message } = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    })

    const headers = message.payload?.headers ?? []
    const subject = headers.find((h: any) => h.name === "Subject")?.value ?? "(no subject)"
    const from = headers.find((h: any) => h.name === "From")?.value ?? ""
    const fromEmail = from.match(/<([^>]+)>/)?.[1] ?? from

    const bodyText = extractBody(message.payload)
    const analysisText = `Subject: ${subject}\n\nFrom: ${from}\n\n${bodyText}`.slice(0, 4000)

    console.log(`Processing email from ${fromEmail}: "${subject.slice(0, 60)}"`)

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
    const resp = await fetch(`${baseUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: analysisText,
        senderPhone: fromEmail,
        detectionMethod: "agents-only",
      }),
    })

    if (!resp.ok) {
      console.error(`Analyze API returned ${resp.status}`)
      return
    }

    const result = await resp.json()
    const risk = result?.overall?.risk ?? "low"
    const explanation = result?.overall?.explanation ?? ""

    console.log(`Email risk: ${risk} — "${subject.slice(0, 50)}"`)

    if (risk === "high" || risk === "medium") {
      const labelName = risk === "high" ? "FRAUD_HIGH" : "FRAUD_MEDIUM"
      try {
        const labelId = await getOrCreateLabel(gmail, labelName)
        await gmail.users.messages.modify({
          userId: "me",
          id: messageId,
          requestBody: {
            addLabelIds: [labelId],
            removeLabelIds: risk === "high" ? ["INBOX"] : [],
          },
        })
        console.log(`Applied label ${labelName} to message ${messageId}`)
      } catch (e) {
        console.error("Label error:", e)
      }

      if (risk === "high" && process.env.GMAIL_ALERT_TO) {
        try {
          const emailBody = [
            `FRAUD ALERT - High Risk Email Detected`,
            ``,
            `From: ${from}`,
            `Subject: ${subject}`,
            ``,
            `Risk: HIGH`,
            `Reason: ${explanation}`,
            ``,
            `The email has been labelled FRAUD_HIGH and removed from your inbox.`,
          ].join("\n")

          const rawEmail = [
            `To: ${process.env.GMAIL_ALERT_TO}`,
            `Subject: [FRAUD ALERT] ${subject.slice(0, 80)}`,
            `Content-Type: text/plain; charset=utf-8`,
            ``,
            emailBody,
          ].join("\n")

          const encodedEmail = Buffer.from(rawEmail)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "")

          await gmail.users.messages.send({
            userId: "me",
            requestBody: { raw: encodedEmail },
          })
          console.log(`Alert email sent to ${process.env.GMAIL_ALERT_TO}`)
        } catch (e) {
          console.error("Alert email error:", e)
        }
      }
    }
  } catch (error) {
    console.error("processEmail error:", error)
  }
}

// Return 200 IMMEDIATELY, process in background
export async function POST(req: Request) {
  try {
    const pubsubBody = await req.json().catch(() => null)
    if (!pubsubBody?.message?.data) {
      return new Response("OK", { status: 200 })
    }

    const pubsubMessageId =
      pubsubBody.message.messageId ??
      pubsubBody.message.message_id ??
      "unknown"

    let decoded: any = {}
    try {
      decoded = JSON.parse(decodeBase64(pubsubBody.message.data))
    } catch {
      return new Response("OK", { status: 200 })
    }

    const historyId = decoded.historyId
    if (!historyId) {
      return new Response("OK", { status: 200 })
    }

    console.log(`Pub/Sub received: messageId=${pubsubMessageId}, historyId=${historyId}`)

    // Fire and forget — Pub/Sub gets its 200 immediately
    processEmail(pubsubMessageId, historyId).catch(console.error)

    return new Response("OK", { status: 200 })
  } catch (error) {
    console.error("Gmail webhook error:", error)
    return new Response("OK", { status: 200 })
  }
}

export async function GET() {
  return NextResponse.json({ status: "Gmail webhook endpoint is live" })
}
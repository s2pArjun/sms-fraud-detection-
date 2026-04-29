// frontend/app/api/gmail-webhook/route.ts

import { NextResponse } from "next/server"
import { google } from "googleapis"

export const maxDuration = 60

// ── Reject Pub/Sub messages older than 5 minutes ──────────────────────────
const MAX_MESSAGE_AGE_MS = 5 * 60 * 1000

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

const processedPubsubIds = new Set<string>()
const processedMessageIds = new Set<string>()

// ── Global analysis queue — only 1 email analyzed at a time ──
let analysisRunning = false
const analysisQueue: Array<() => Promise<void>> = []

async function enqueueAnalysis(fn: () => Promise<void>) {
  analysisQueue.push(fn)
  if (!analysisRunning) drainQueue()
}

async function drainQueue() {
  if (analysisRunning || analysisQueue.length === 0) return
  analysisRunning = true

  while (analysisQueue.length > 0) {
    const next = analysisQueue.shift()!
    await next().catch(console.error)

    // Wait 15s between emails to let Groq TPM window reset
    if (analysisQueue.length > 0) {
      await new Promise(r => setTimeout(r, 15000))
    }
  }

  analysisRunning = false
}


async function processEmail(pubsubMessageId: string, historyId: string) {
  if (processedPubsubIds.has(pubsubMessageId)) {
    console.log(`Dup Pub/Sub skipped: ${pubsubMessageId}`)
    return
  }
  processedPubsubIds.add(pubsubMessageId)
  setTimeout(() => processedPubsubIds.delete(pubsubMessageId), 10 * 60 * 1000)

  try {
    const gmail = getGmailClient()

    const { data: listData } = await gmail.users.messages.list({
      userId: "me",
      maxResults: 5,
      labelIds: ["INBOX"],
      q: "is:unread",
    })

    const messages = listData.messages ?? []
    if (!messages.length) return

    let messageId: string | null = null
    for (const msg of messages) {
      if (msg.id && !processedMessageIds.has(msg.id)) {
        messageId = msg.id
        break
      }
    }

    if (!messageId) {
      console.log("All recent messages already processed, skipping")
      return
    }

    processedMessageIds.add(messageId)
    setTimeout(() => processedMessageIds.delete(messageId!), 10 * 60 * 1000)

    const { data: message } = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    })

    const headers = message.payload?.headers ?? []
    const subject = headers.find((h: any) => h.name === "Subject")?.value ?? "(no subject)"
    const from = headers.find((h: any) => h.name === "From")?.value ?? ""
    const fromEmail = from.match(/<([^>]+)>/)?.[1] ?? from

    // ── LOOP PREVENTION ────────────────────────────────────────────────────
    if (/\[FRAUD[\s_]/i.test(subject)) {
      console.log(`Skipping fraud alert email: "${subject.slice(0, 60)}"`)
      return
    }

    const existingLabelIds = message.labelIds ?? []
    const { data: allLabels } = await gmail.users.labels.list({ userId: "me" })
    const fraudLabelIds = new Set(
      (allLabels.labels ?? [])
        .filter((l: any) => l.name === "FRAUD_HIGH" || l.name === "FRAUD_MEDIUM")
        .map((l: any) => l.id)
    )
    if (existingLabelIds.some((lid: string) => fraudLabelIds.has(lid))) {
      console.log(`Message ${messageId} already fraud-labeled, skipping`)
      return
    }
    // ───────────────────────────────────────────────────────────────────────

    const bodyText = extractBody(message.payload)

    // Trim body to stay under Groq free-tier 6000 TPM limit
    const trimmedBody = bodyText.slice(0, 800)
    const analysisText = `Subject: ${subject}\nFrom: ${from}\n\n${trimmedBody}`

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

    // ── Drop stale backlogged messages ─────────────────────────────────────
    const publishTime =
      pubsubBody.message.publishTime ??
      pubsubBody.message.publish_time
    if (publishTime) {
      const ageMs = Date.now() - new Date(publishTime).getTime()
      if (ageMs > MAX_MESSAGE_AGE_MS) {
        console.log(`Dropping stale message (${Math.round(ageMs / 1000)}s old): ${pubsubMessageId}`)
        return new Response("OK", { status: 200 })
      }
    }
    // ───────────────────────────────────────────────────────────────────────

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

    enqueueAnalysis(() => processEmail(pubsubMessageId, historyId))

    return new Response("OK", { status: 200 })
  } catch (error) {
    console.error("Gmail webhook error:", error)
    return new Response("OK", { status: 200 })
  }
}

export async function GET() {
  return NextResponse.json({ status: "Gmail webhook endpoint is live" })
}
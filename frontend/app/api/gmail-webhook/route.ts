// frontend/app/api/gmail-webhook/route.ts
//
// KEY FIXES:
// 1. Uses Gmail History API with historyId (only fetches truly NEW messages)
// 2. Dedup via Supabase (persistent across serverless invocations, not in-memory)
// 3. In-memory queue removed (broken on serverless, starved WhatsApp locally)
// 4. Stale message window increased to 10 min and logged clearly

import { NextResponse } from "next/server"
import { google } from "googleapis"
import { supabase } from "@/lib/supabase"

export const maxDuration = 60

const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000 // 10 minutes

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

// ── Persistent dedup via Supabase ─────────────────────────────────────────
// This works across serverless invocations unlike in-memory sets.
// Uses the fraud_checks table with a synthetic phone = "gmail:messageId"
// so no schema changes needed.
async function isAlreadyProcessed(messageId: string): Promise<boolean> {
  const { data } = await supabase
    .from("fraud_checks")
    .select("id")
    .eq("phone", `gmail:${messageId}`)
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function markAsProcessed(messageId: string): Promise<void> {
  await supabase.from("fraud_checks").insert({
    phone: `gmail:${messageId}`,
    text_preview: "gmail-dedup-sentinel",
    risk: "low",
    ml_prediction: "unknown",
    ml_confidence: 0,
    explanation: "dedup sentinel",
    checked_at: new Date().toISOString(),
  })
}

// ── Core: fetch new messages using History API ────────────────────────────
// This is the RIGHT way to use Gmail Pub/Sub. historyId tells you exactly
// where to start — only messages added since that point are returned.
async function getNewMessageIds(gmail: any, historyId: string): Promise<string[]> {
  try {
    const { data } = await gmail.users.history.list({
      userId: "me",
      startHistoryId: historyId,
      historyTypes: ["messageAdded"],
      labelId: "INBOX",
    })

    const messageIds: string[] = []
    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) {
          messageIds.push(added.message.id)
        }
      }
    }
    return [...new Set(messageIds)] // deduplicate
  } catch (err: any) {
    // historyId too old (410 Gone) — nothing we can do, skip gracefully
    if (err?.code === 404 || err?.code === 410) {
      console.log(`History ID ${historyId} expired or not found, skipping`)
      return []
    }
    throw err
  }
}

async function processMessage(gmail: any, messageId: string) {
  // Persistent dedup check
  if (await isAlreadyProcessed(messageId)) {
    console.log(`Message ${messageId} already processed (supabase dedup), skipping`)
    return
  }

  // Mark immediately before any async work to prevent races
  await markAsProcessed(messageId)

  const { data: message } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  })

  const headers = message.payload?.headers ?? []
  const subject = headers.find((h: any) => h.name === "Subject")?.value ?? "(no subject)"
  const from = headers.find((h: any) => h.name === "From")?.value ?? ""
  const fromEmail = from.match(/<([^>]+)>/)?.[1] ?? from

  // Loop prevention: skip our own fraud alert emails
  if (/\[FRAUD[\s_]/i.test(subject)) {
    console.log(`Skipping fraud alert email: "${subject.slice(0, 60)}"`)
    return
  }

  // Skip already-labeled messages
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

  const bodyText = extractBody(message.payload)
  const trimmedBody = bodyText.slice(0, 800)
  const analysisText = `Subject: ${subject}\nFrom: ${from}\n\n${trimmedBody}`

  console.log(`Analyzing email from ${fromEmail}: "${subject.slice(0, 60)}"`)

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
    console.error(`Analyze API returned ${resp.status} for message ${messageId}`)
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

    // ── Drop stale backlogged Pub/Sub messages ────────────────────────────
    const publishTime = pubsubBody.message.publishTime ?? pubsubBody.message.publish_time
    if (publishTime) {
      const ageMs = Date.now() - new Date(publishTime).getTime()
      if (ageMs > MAX_MESSAGE_AGE_MS) {
        console.log(`Dropping stale Pub/Sub message (${Math.round(ageMs / 1000)}s old): ${pubsubMessageId}`)
        return new Response("OK", { status: 200 })
      }
    }

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

    // ── ALWAYS return 200 to Pub/Sub immediately ──────────────────────────
    // Do NOT await the processing inside the response. Fire and forget.
    // This prevents Pub/Sub from retrying just because your analysis is slow.
    // Note: on Vercel, the function stays alive until the promise resolves
    // because we're inside the request handler — so processing will complete.
    const gmail = getGmailClient()

    // FIX: Use History API to get only genuinely new message IDs
    const newMessageIds = await getNewMessageIds(gmail, historyId)

    if (newMessageIds.length === 0) {
      console.log(`No new messages for historyId=${historyId}`)
      return new Response("OK", { status: 200 })
    }

    console.log(`Found ${newMessageIds.length} new message(s): ${newMessageIds.join(", ")}`)

    // Process each new message (sequentially to respect Groq TPM)
    for (const messageId of newMessageIds) {
      await processMessage(gmail, messageId)
    }

    return new Response("OK", { status: 200 })
  } catch (error) {
    console.error("Gmail webhook error:", error)
    // Still return 200 to prevent Pub/Sub retry storm
    return new Response("OK", { status: 200 })
  }
}

export async function GET() {
  return NextResponse.json({ status: "Gmail webhook endpoint is live" })
}
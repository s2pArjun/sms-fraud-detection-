// frontend/app/api/gmail-watch/route.ts
//
// Call POST /api/gmail-watch once to register Gmail push notifications.
// Gmail will push to your /api/gmail-webhook endpoint via Google Pub/Sub.
// Watch expires after 7 days — call this again to renew (or set up a cron job).
//
// Prerequisites (see GMAIL_SETUP.md):
//   - Google Cloud project with Gmail API + Pub/Sub enabled
//   - Pub/Sub topic created and your app URL added as a push subscriber
//   - OAuth2 refresh token in GOOGLE_REFRESH_TOKEN env var

import { NextResponse } from "next/server"
import { google } from "googleapis"

export const maxDuration = 30

function getGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )
  auth.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  })
  return google.gmail({ version: "v1", auth })
}

// POST /api/gmail-watch — register or renew Gmail watch
export async function POST() {
  try {
    const gmail = getGmailClient()

    const topicName = process.env.GOOGLE_PUBSUB_TOPIC
    if (!topicName) {
      return NextResponse.json(
        { error: "Missing GOOGLE_PUBSUB_TOPIC env var. Format: projects/YOUR_PROJECT_ID/topics/YOUR_TOPIC_NAME" },
        { status: 400 }
      )
    }

    const { data } = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName,
        labelIds: ["INBOX"],   // only watch inbox
        labelFilterAction: "include",
      },
    })

    const expiresAt = data.expiration
      ? new Date(parseInt(data.expiration)).toISOString()
      : "unknown"

    console.log(`Gmail watch registered. Expires: ${expiresAt}`)

    return NextResponse.json({
      success: true,
      historyId: data.historyId,
      expiration: data.expiration,
      expiresAt,
      message: `Gmail push notifications active until ${expiresAt}. Renew before expiry by calling POST /api/gmail-watch again.`,
    })
  } catch (error: any) {
    console.error("Gmail watch error:", error)
    return NextResponse.json(
      {
        error: error.message,
        hint: "Make sure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, and GOOGLE_PUBSUB_TOPIC are set correctly.",
      },
      { status: 500 }
    )
  }
}

// GET /api/gmail-watch — check current watch status
export async function GET() {
  try {
    const gmail = getGmailClient()

    // Fetch profile to confirm auth works
    const { data: profile } = await gmail.users.getProfile({ userId: "me" })

    return NextResponse.json({
      status: "authenticated",
      email: profile.emailAddress,
      messagesTotal: profile.messagesTotal,
      historyId: profile.historyId,
      note: "Auth is working. POST /api/gmail-watch to register push notifications.",
    })
  } catch (error: any) {
    return NextResponse.json(
      { status: "error", error: error.message },
      { status: 500 }
    )
  }
}
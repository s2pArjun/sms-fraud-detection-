// frontend/app/api/gmail-auth/route.ts
//
// One-time OAuth2 setup route.
// Step 1: Visit /api/gmail-auth          → redirects to Google consent screen
// Step 2: Google redirects back with ?code=...
//         Visit /api/gmail-auth?code=... → exchanges code for refresh token
//
// After getting the refresh token, add it to your .env.local as GOOGLE_REFRESH_TOKEN
// You only need to do this ONCE.

import { NextResponse } from "next/server"
import { google } from "googleapis"

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI // must be: https://your-app.vercel.app/api/gmail-auth
  )
}

// Step 1: Redirect to Google consent screen
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const code = searchParams.get("code")

  const oauth2Client = getOAuth2Client()

  // Step 2: Exchange authorization code for tokens
  if (code) {
    try {
      const { tokens } = await oauth2Client.getToken(code)
      
      // Display the refresh token — copy this to your env vars
      return NextResponse.json({
        message: "SUCCESS! Copy the refresh_token below to your .env.local as GOOGLE_REFRESH_TOKEN",
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        instructions: [
          "1. Copy the refresh_token value above",
          "2. Add to .env.local: GOOGLE_REFRESH_TOKEN=<value>",
          "3. Add to Vercel environment variables",
          "4. Run the Pub/Sub setup script to start watching your inbox",
        ],
      })
    } catch (error: any) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }

  // Step 1: Generate auth URL
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force to always return refresh_token
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
  })

  // Redirect to Google
  return NextResponse.redirect(authUrl)
}
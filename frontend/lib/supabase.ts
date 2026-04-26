// frontend/lib/supabase.ts
// Place at this exact path in your project

import { createClient } from "@supabase/supabase-js"

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase env vars. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local")
}

// Single shared client — safe to use in API routes (server-side only)
export const supabase = createClient(supabaseUrl, supabaseKey)

// ─── Types matching the DB table ────────────────────────────────────────────

export type FraudCheck = {
  id: string
  phone: string              // sender phone number e.g. "+919876543210"
  text_preview: string       // first 200 chars of the SMS
  risk: "low" | "medium" | "high"
  ml_prediction: string      // "ham" | "spam" | "smishing" etc.
  ml_confidence: number      // 0-1
  explanation: string        // decision engine explanation
  checked_at: string         // ISO timestamp
}
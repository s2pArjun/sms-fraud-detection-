// frontend/app/api/reputation/route.ts
// Place at this exact path in your project
//
// Usage:
//   GET /api/reputation?phone=+919876543210
//   GET /api/reputation?phone=+919876543210&limit=20

import { NextResponse } from "next/server"
import { generateText } from "ai"
import { groq } from "@ai-sdk/groq"
import { supabase, type FraudCheck } from "@/lib/supabase"

export const maxDuration = 30

const REPUTATION_MODEL = process.env.DECISION_MODEL || "llama-3.3-70b-versatile"

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const phone = searchParams.get("phone")?.trim()
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50"), 100)

  if (!phone) {
    return NextResponse.json({ error: "Missing ?phone= parameter" }, { status: 400 })
  }

  // ── 1. Fetch all past checks for this phone number ──────────────────────
  const { data, error } = await supabase
    .from("fraud_checks")
    .select("*")
    .eq("phone", phone)
    .order("checked_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Supabase fetch error:", error)
    return NextResponse.json({ error: "Database error", detail: error.message }, { status: 500 })
  }

  const checks = (data ?? []) as FraudCheck[]

  // ── 2. Compute quick stats ───────────────────────────────────────────────
  const total = checks.length
  const highCount = checks.filter(c => c.risk === "high").length
  const mediumCount = checks.filter(c => c.risk === "medium").length
  const lowCount = checks.filter(c => c.risk === "low").length
  const fraudRate = total > 0 ? Math.round((highCount / total) * 100) : 0

  // Aggregate reputation score 0-100 (higher = more suspicious)
  const reputationScore = total === 0
    ? null
    : Math.round((highCount * 1.0 + mediumCount * 0.4) / total * 100)

  // If no history at all, return early without calling LLM
  if (total === 0) {
    return NextResponse.json({
      phone,
      total_checks: 0,
      reputation_score: null,
      risk_breakdown: { high: 0, medium: 0, low: 0 },
      fraud_rate_pct: 0,
      summary: "No history found for this number. This is the first time we've seen it.",
      checks: [],
    })
  }

  // ── 3. Build context for the LLM ────────────────────────────────────────
  // Send the most recent 10 checks as examples (avoid overloading the prompt)
  const recentSample = checks.slice(0, 10).map(c => ({
    date: new Date(c.checked_at).toLocaleDateString("en-IN"),
    risk: c.risk,
    ml: c.ml_prediction,
    preview: c.text_preview.slice(0, 80),
  }))

  const prompt = `
You are a telecom fraud analyst reviewing the SMS history for phone number: ${phone}

STATS:
- Total messages analyzed: ${total}
- High risk: ${highCount} | Medium risk: ${mediumCount} | Low risk: ${lowCount}
- Fraud rate: ${fraudRate}%
- Reputation score: ${reputationScore}/100 (higher = more suspicious)

RECENT MESSAGE SAMPLES (up to 10 most recent):
${JSON.stringify(recentSample, null, 2)}

Write a 2-3 sentence analyst summary of this sender's risk pattern. 
Be direct and specific. Mention:
1. The overall risk level for this number
2. Any pattern you notice in the message types (e.g. consistently smishing, mix of spam and ham, etc.)
3. Your recommendation (block, monitor, or safe)

Output ONLY the summary text. No JSON, no headings, no bullet points.
`.trim()

  // ── 4. Call Groq for the LLM summary ────────────────────────────────────
  let summary = "Unable to generate summary."
  try {
    const { text } = await generateText({
      model: groq(REPUTATION_MODEL),
      prompt,
      temperature: 0.3,
    })
    summary = text.trim()
  } catch (err) {
    console.error("Groq summary error:", err)
    // Non-fatal — still return the stats even if LLM fails
    summary = `This number has ${total} checks on record with a ${fraudRate}% fraud rate.`
  }

  // ── 5. Return full reputation report ────────────────────────────────────
  return NextResponse.json({
    phone,
    total_checks: total,
    reputation_score: reputationScore,       // 0-100, higher = worse
    risk_breakdown: {
      high: highCount,
      medium: mediumCount,
      low: lowCount,
    },
    fraud_rate_pct: fraudRate,
    summary,                                  // LLM-generated risk pattern summary
    first_seen: checks[checks.length - 1]?.checked_at ?? null,
    last_seen: checks[0]?.checked_at ?? null,
    checks,                                   // Full raw history (newest first)
  })
}
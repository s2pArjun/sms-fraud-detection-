import { NextResponse } from "next/server"
import { generateText } from "ai"
import { groq } from "@ai-sdk/groq"
import { supabase, type FraudCheck } from "@/lib/supabase"
import type { AnalysisResult, AgentResult, DecisionResult } from "@/lib/types"
import { clamp01, extractUrls, safeJson } from "@/lib/utils-local"

export const maxDuration = 60

// ───────────── MODELS ─────────────
const AGENT_MODEL = process.env.AGENT_MODEL || "llama-3.1-8b-instant"
const DECISION_MODEL = process.env.DECISION_MODEL || "llama-3.3-70b-versatile"
const TRANSLATION_MODEL = process.env.TRANSLATION_MODEL || "llama-3.3-70b-versatile"

// ───────────── RATE LIMIT HELPER ─────────────
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

// ───────────── TYPES ─────────────
type AgentJSON = {
  suspicionScore: number
  score?: number
  classification?: string
  language?: string
  signals: string[]
  features: string[]
  rationale?: string
  confidence?: number
  mismatchExplanation?: string
}

// ───────────── SHARED OUTPUT SCHEMA ─────────────
const AGENT_OUTPUT_SCHEMA = `
Return a JSON object with:
{
  "classification": "benign" | "suspicious" | "unknown",
  "suspicionScore": number between 0 and 1,
  "confidence": number between 0 and 1,
  "language": string (optional),
  "mismatchExplanation": string (optional),
  "signals": string[],
  "features": string[],
  "rationale": string
}
Only return JSON. Do not include any other text.
`

// ───────────── AGENTS (5 TOTAL) ─────────────
const AGENTS = {
  content: {
    key: "content",
    name: "Content Analysis Agent",
    system: `You are the Content Analysis Agent. Detect fraud indicators in SMS content without using hardcoded rules.
Analyze semantics, intent, and psychological manipulation patterns (urgency, fear, authority pressure, rewards).
If an English translation is provided, analyze using the translation but consider transliteration or language-specific
cues from the original text. Indian languages to detect include: Hindi (hi), Bengali (bn), Punjabi (pa), Tamil (ta),
Telugu (te), Marathi (mr), Gujarati (gu), Kannada (kn), Malayalam (ml), Odia (or), Assamese (as).
If you detect a regional language, include it in 'language' and factor local norms into your analysis.
Use suspicionScore thresholds: >= 0.7 -> 'suspicious', <= 0.4 -> 'benign', otherwise 'unknown'.
If you choose a different classification, include a 'mismatchExplanation'.
${AGENT_OUTPUT_SCHEMA}`,
  },
  link: {
    key: "link",
    name: "Link Security Agent",
    system: `You are the Link Security Agent. Extract and analyze URLs for suspicious indicators, spoofed domains,
lookalikes, and risky redirects. Consider domain structure, TLD, path/query oddities.
If provided, use the English translation but also note transliteration, URL shortener clues or language-decoding
anomalies from the original message. If you detect a regional Indian language, include the code in 'language' and
call out local TLD or transliteration anomalies.
Use suspicionScore thresholds: >= 0.7 -> 'suspicious', <= 0.4 -> 'benign', otherwise 'unknown'.
If you choose a different classification, include a 'mismatchExplanation'.
${AGENT_OUTPUT_SCHEMA}`,
  },
  sender: {
    key: "sender",
    name: "Sender Verification Agent",
    system: `You are the Sender Verification Agent. Assess sender authenticity based on SMS text clues
(claimed brand, phone number patterns, reply-to behaviors) and potential spoofing or impersonation signals.
Use the translated English text for analysis when present; also consider transliteration, grammar, or linguistic
clues in the original text indicating impersonation. If you detect a regional language, include the code in 'language'
and consider sender-language consistency (e.g., local banks using local languages).
Use suspicionScore thresholds: >= 0.7 -> 'suspicious', <= 0.4 -> 'benign', otherwise 'unknown'.
If you choose a different classification, include a 'mismatchExplanation'.
${AGENT_OUTPUT_SCHEMA}`,
  },
  context: {
    key: "context",
    name: "Context Awareness Agent",
    system: `You are the Context Awareness Agent. Evaluate risk from timing, frequency, and expectedness context.
Consider if message is expected, recent frequency from sender, and timing anomalies (off-hours).
If provided, use the English translation for semantic cues, and note how detected language may affect expectedness
(e.g., Indian regional language used by local banks vs code-mix). If you detect a regional language, include the code
and comment if the sender's language usage is expected for the sender.
Use suspicionScore thresholds: >= 0.7 -> 'suspicious', <= 0.4 -> 'benign', otherwise 'unknown'.
If you choose a different classification, include a 'mismatchExplanation'.
${AGENT_OUTPUT_SCHEMA}`,
  },
  history: {
    key: "history",
    name: "History Agent",
    system: `You are the History Agent. You receive a summary of prior fraud checks for the same sender phone number,
along with the current SMS being evaluated. Your job is to assess how the sender's past behavior affects the risk
of the current message.

Guidelines:
- More high-risk prior messages -> raise suspicion significantly
- No prior history -> treat as neutral (do not over-penalize new senders)
- A mix of low and high risk history -> consider recency and pattern
- If history shows repeated low-risk messages but current SMS is unusual, flag the mismatch
- Cross-reference the current SMS content against past patterns if possible

Use suspicionScore thresholds: >= 0.7 -> 'suspicious', <= 0.4 -> 'benign', otherwise 'unknown'.
If you choose a different classification, include a 'mismatchExplanation'.
${AGENT_OUTPUT_SCHEMA}`,
  },
} as const

// ───────────── SUPABASE ─────────────
async function fetchHistory(phone: string): Promise<FraudCheck[]> {
  const { data } = await supabase
    .from("fraud_checks")
    .select("*")
    .eq("phone", phone)
    .order("checked_at", { ascending: false })
    .limit(10)
  return data ?? []
}

function buildHistorySummary(history: FraudCheck[]) {
  if (!history.length) return "No prior history for this sender."
  const high = history.filter(h => h.risk === "high").length
  const med  = history.filter(h => h.risk === "medium").length
  const low  = history.filter(h => h.risk === "low").length
  const latest = history[0]?.checked_at
    ? `Latest check: ${history[0].checked_at}`
    : ""
  return `Sender history (last ${history.length} checks): ${high} high-risk, ${med} medium-risk, ${low} low-risk. ${latest}`
}

// ───────────── TRANSLATION ─────────────
async function detectAndTranslate(text: string) {
  try {
    const res = await generateText({
      model: groq(TRANSLATION_MODEL),
      system: "You are a translation assistant. Return only JSON with 'language' and 'translation' fields. No markdown, no extra text.",
      prompt: `Detect the primary language of the following SMS and translate it to English if needed.
If already English, return language: "en" and the original text in translation.
Only return JSON. Example: {"language":"hi","translation":"This is the English translation"}

Text:
"""${text}"""`,
      temperature: 0,
    })

    const parsed = safeJson<{ language: string; translation: string }>(res.text)
    if (parsed?.translation) {
      return { language: parsed.language ?? "unknown", translated: parsed.translation }
    }
    return { language: "unknown", translated: text }
  } catch (e) {
    console.error("Translation failed:", e)
    return { language: "unknown", translated: text }
  }
}

// ───────────── ML ─────────────
async function callML(text: string, meta?: { original_text?: string; language?: string }) {
  try {
    const url = process.env.ML_SERVICE_URL!
    const payload: any = { text }
    if (meta?.original_text) payload.original_text = meta.original_text
    if (meta?.language)      payload.language       = meta.language

    const res = await fetch(`${url}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    return res.ok ? res.json() : null
  } catch {
    return null
  }
}

// ───────────── PARSE HELPER ─────────────
function parseAgentResult(key: keyof typeof AGENTS, res: { text: string }): AgentResult {
  const p = safeJson<AgentJSON>(res.text)

  const toStringArray = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return []
    return arr.map(item => {
      if (typeof item === "string") return item
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, any>
        if (obj.type === "entities" && Array.isArray(obj.entities)) {
          return obj.entities.map((e: any) =>
            typeof e === "string" ? e : `${e.text ?? ""} (${e.type ?? "entity"})`
          ).join(", ")
        }
        if (obj.type === "patterns" && Array.isArray(obj.patterns)) {
          return obj.patterns.map((p: any) =>
            typeof p === "string" ? p : `${p.text ?? ""}`
          ).join(", ")
        }
        const values = Object.values(obj).filter(v => typeof v === "string")
        if (values.length > 0) return values.join(": ")
      }
      return JSON.stringify(item)
    }).filter(Boolean)
  }

  return {
    key,
    name: AGENTS[key].name,
    score: clamp01(p?.suspicionScore ?? p?.score ?? p?.confidence ?? 0.5),
    classification: p?.classification as any,
    language: p?.language,
    signals: toStringArray(p?.signals),
    features: toStringArray(p?.features),
    rationale: typeof p?.rationale === "string" ? p.rationale : "",
    mismatchExplanation: typeof p?.mismatchExplanation === "string"
      ? p.mismatchExplanation
      : undefined,
  }
}

// ───────────── MAIN ─────────────
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const text             = (body?.text ?? "") as string
  const phone            = (body?.senderPhone ?? "") as string
  const receivedAt       = body?.receivedAt as string | undefined
  const priorFromSender  = body?.priorFromSender as number | undefined
  const expected         = body?.expected as boolean | undefined
  const detectionMethod  = (body?.detectionMethod ?? "both") as "ml-only" | "agents-only" | "both"

  if (!text || typeof text !== "string" || text.length > 8000) {
    return NextResponse.json({ error: "Provide SMS text (<= 8000 chars)" }, { status: 400 })
  }

  // ── 1. Translation + history in parallel ──
  const [tl, history] = await Promise.all([
    detectAndTranslate(text),
    phone ? fetchHistory(phone) : Promise.resolve([] as FraudCheck[]),
  ])

  const originalLanguage = tl.language
  const translatedText   = tl.translated
  const urls             = extractUrls(translatedText)
  const historySummary   = buildHistorySummary(history)

  // Shared SMS block sent to all agents
  const agentText = `TranslatedEnglish:
"""${translatedText}"""

OriginalText:
"""${text}"""`

  // ── 2. Run ML and/or agents ──
  let mlResult: any = null
  let agentResults: Record<string, any> | null = null

  if (detectionMethod === "ml-only" || detectionMethod === "both") {
    mlResult = await callML(translatedText, { original_text: text, language: originalLanguage })
  }

  if (detectionMethod === "agents-only" || detectionMethod === "both") {
    const historyPrompt = `${agentText}

Sender History Summary:
${historySummary}
`
    // ── Sequential agent calls with 1s delay between each ──
    // Groq free tier: 6000 TPM. Each agent uses ~1000-1300 tokens.
    // Running all 5 in parallel would request ~6500 tokens at once → 429.
    // Staggering them 1s apart keeps each request under the rolling TPM window.
    const cRes = await generateText({
      model: groq(AGENT_MODEL),
      system: AGENTS.content.system,
      prompt: agentText,
      temperature: 0.2,
    })
    await delay(1000)

    const lRes = await generateText({
      model: groq(AGENT_MODEL),
      system: AGENTS.link.system,
      prompt: `${agentText}\n\nExtracted URLs: ${JSON.stringify(urls)}`,
      temperature: 0.2,
    })
    await delay(1000)

    const sRes = await generateText({
      model: groq(AGENT_MODEL),
      system: AGENTS.sender.system,
      prompt: agentText,
      temperature: 0.2,
    })
    await delay(1000)

    const ctxRes = await generateText({
      model: groq(AGENT_MODEL),
      system: AGENTS.context.system,
      prompt: `${agentText}

Optional context:
- receivedAt: ${receivedAt ?? "unknown"}
- priorFromSender (7d): ${priorFromSender ?? "unknown"}
- expected: ${expected ?? "unknown"}`,
      temperature: 0.2,
    })
    await delay(1000)

    const hRes = await generateText({
      model: groq(AGENT_MODEL),
      system: AGENTS.history.system,
      prompt: historyPrompt,
      temperature: 0.2,
    })

    agentResults = {
      content: parseAgentResult("content", cRes),
      link:    parseAgentResult("link",    lRes),
      sender:  parseAgentResult("sender",  sRes),
      context: parseAgentResult("context", ctxRes),
      history: parseAgentResult("history", hRes),
    }
  }

  // ── 3. Decision engine ──
  const translationCaveat = originalLanguage && originalLanguage !== "en"
    ? "\nImportant: ML result is based on an English translation; downweight ML confidence for language-specific signals."
    : ""

  let decisionPrompt = `Note:
- Original language: ${originalLanguage}
- Translated English (preview): ${translatedText.slice(0, 200)}
${translationCaveat}
`

  if (detectionMethod !== "agents-only") {
    decisionPrompt += `
Traditional ML Prediction (SVM + TF-IDF, 93.97% accuracy):
${mlResult ? JSON.stringify({
  prediction:   mlResult.prediction,
  confidence:   mlResult.confidence,
  is_fraud:     mlResult.is_fraud,
  probabilities: mlResult.probabilities,
}) : "ML service unavailable"}
`
  }

  if (detectionMethod !== "ml-only" && agentResults) {
    decisionPrompt += `
Five LLM Agent Outputs:
- content: ${JSON.stringify(agentResults.content)}
- link:    ${JSON.stringify(agentResults.link)}
- sender:  ${JSON.stringify(agentResults.sender)}
- context: ${JSON.stringify(agentResults.context)}
- history: ${JSON.stringify(agentResults.history)}
`
  }

  decisionPrompt += `
Classify overall fraud risk. Return only JSON:
{"risk":"low"|"medium"|"high","confidence":0..1,"explanation":"brief user-facing explanation"}`

  const decisionRes = await generateText({
    model: groq(DECISION_MODEL),
    system: `You are the Decision Engine. Combine LLM agent outputs and/or traditional ML prediction to classify SMS fraud risk.
- ML (SVM+TF-IDF) is strong on statistical patterns; LLM agents reason contextually
- The history agent captures prior fraudster behavior for this sender — weigh it heavily when high-risk history is present
- When agents disagree, use mismatchExplanation and rationale to break ties
- When translation was used, prefer agent signals over ML
Return only strict JSON: {"risk":"low"|"medium"|"high","confidence":number,"explanation":string}`,
    prompt: decisionPrompt,
    temperature: 0.2,
  })

  const decision = safeJson<DecisionResult>(decisionRes.text) ?? {
    risk: "medium",
    confidence: 0.5,
    explanation: "Insufficient structured output; defaulted to medium risk.",
  }

  // ── 4. Save to Supabase ──
  if (phone) {
    const { error: dbError } = await supabase.from("fraud_checks").insert({
      phone,
      text_preview: text.slice(0, 200),
      risk: decision.risk,
      ml_prediction: mlResult?.prediction ?? "unknown",
      ml_confidence: mlResult?.confidence ?? 0,
      explanation: decision.explanation ?? "",
      checked_at: new Date().toISOString(),
    })
    if (dbError) {
      console.error("Supabase insert error:", dbError)
    }
  }

  // ── 5. Return ──
  const result: AnalysisResult = {
    input: {
      text,
      receivedAt,
      priorFromSender,
      expected,
      detectionMethod,
      originalLanguage,
      translatedText,
    },
    ml: mlResult
      ? {
          prediction:    mlResult.prediction,
          confidence:    mlResult.confidence,
          probabilities: mlResult.probabilities,
          is_fraud:      mlResult.is_fraud,
          available:     true,
        }
      : null,
    agents:  agentResults,
    overall: {
      risk:        decision.risk,
      confidence:  decision.confidence != null ? clamp01(decision.confidence) : undefined,
      explanation: decision.explanation ?? "",
    },
    urls,
    history: historySummary,
  }

  return NextResponse.json(result, { status: 200 })
}
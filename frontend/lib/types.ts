export type DetectionMethod = "ml-only" | "agents-only" | "both"

export type AgentKey = "content" | "link" | "sender" | "context" | "history"

export type AgentResult = {
  key: AgentKey
  name: string
  score: number // 0..1 — suspicion score (higher = more suspicious)
  classification?: "benign" | "suspicious" | "unknown"
  mismatchExplanation?: string
  language?: string
  signals: string[]
  features: string[]
  rationale?: string
}

export type DecisionResult = {
  risk: "low" | "medium" | "high"
  confidence?: number // 0..1
  explanation: string
}

export type MLResult = {
  prediction: string // 'ham', 'spam', 'smishing', etc.
  confidence: number // 0..1
  probabilities: Record<string, number>
  is_fraud: boolean
  available: boolean // whether ML service was reachable
}

export type AnalysisResult = {
  input: {
    text: string
    receivedAt?: string
    priorFromSender?: number
    expected?: boolean
    detectionMethod: DetectionMethod
    originalLanguage?: string // e.g., 'en', 'hi', 'te', etc.
    translatedText?: string // the English translation if the text was non-English
  }
  ml: MLResult | null // null when not using ML
  agents: {
    content: AgentResult
    link: AgentResult
    sender: AgentResult
    context: AgentResult
    history: AgentResult 
  } | null // null when not using agents
  overall: DecisionResult
  urls?: string[]
}

export type UserFeedbackPayload = {
  correct: boolean
  note?: string
  analysis: AnalysisResult
}

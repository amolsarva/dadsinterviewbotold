// lib/google.ts
import { GoogleGenerativeAI } from "@google/generative-ai"

export const DEFAULT_GOOGLE_MODEL = "gemini-2.5-flash-lite"

// Strip legacy "/models/*" prefixes
const LEGACY_PREFIX = /\/models\//i

// Handle old model names used in early Gemini versions
const LEGACY_MODEL_PATTERNS = [
  /gemini-1\./i,
  /gemini-1s/i,
  /gemini-pro/i,
  /text-bison/i,
  /chat-bison/i,
]

function normalizeModelCandidate(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== "string") return null

  const trimmed = candidate.trim()
  if (!trimmed) return null

  const withoutPrefix = trimmed.replace(LEGACY_PREFIX, "")
  const lower = withoutPrefix.toLowerCase()

  if (!withoutPrefix) return null

  // Old -> new mapping
  if (lower === "gemini-2.5-flash") {
    return "gemini-2.5-flash-lite"
  }

  if (LEGACY_MODEL_PATTERNS.some((pattern) => pattern.test(lower))) {
    return DEFAULT_GOOGLE_MODEL
  }

  return withoutPrefix
}

/**
 * Resolve the Google model name based on GOOGLE_MODEL or fall back to default.
 */
export function resolveGoogleModel(primaryModel: string | null | undefined): string {
  const normalized = normalizeModelCandidate(primaryModel)
  return normalized || DEFAULT_GOOGLE_MODEL
}

/**
 * Factory function creating a Gemini client bound to the correct model.
 * Used by ask-audio and intro routes.
 */
export function getGoogleClient(model: string) {
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY must be set for Google provider")
  }

  const genAI = new GoogleGenerativeAI(apiKey)
  return genAI.getGenerativeModel({ model })
}

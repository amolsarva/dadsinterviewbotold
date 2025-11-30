// lib/google.ts
// Minimal, dependency-free helper for normalizing GOOGLE_MODEL env strings.
// We keep this because various routes still import resolveGoogleModel,
// but the function no longer depends on @google/generative-ai.

export const DEFAULT_GOOGLE_MODEL = 'gemini-2.5-flash-lite'

// Strip legacy prefixes like `/models/...`
const LEGACY_PREFIX = /\/models\//i

// Match old Gemini model name formats that should be rewritten
const LEGACY_MODEL_PATTERNS = [
  /gemini-1\./i,
  /gemini-1s/i,
  /gemini-pro/i,
  /text-bison/i,
  /chat-bison/i,
]

function normalizeModelCandidate(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== 'string') return null

  const trimmed = candidate.trim()
  if (!trimmed) return null

  const withoutPrefix = trimmed.replace(LEGACY_PREFIX, '')
  const lower = withoutPrefix.toLowerCase()

  if (!withoutPrefix) return null

  // Special case: old "gemini-2.5-flash" → newer "gemini-2.5-flash-lite"
  if (lower === 'gemini-2.5-flash') {
    return 'gemini-2.5-flash-lite'
  }

  // If any legacy pattern matches, force the new default
  if (LEGACY_MODEL_PATTERNS.some(pattern => pattern.test(lower))) {
    return DEFAULT_GOOGLE_MODEL
  }

  return withoutPrefix
}

export function resolveGoogleModel(primaryModel: string | null | undefined): string {
  const normalized = normalizeModelCandidate(primaryModel)
  if (normalized) return normalized

  // If GOOGLE_MODEL is blank or missing, fall back to a safe default
  return DEFAULT_GOOGLE_MODEL
}

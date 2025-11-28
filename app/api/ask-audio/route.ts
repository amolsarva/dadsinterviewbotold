import { NextRequest, NextResponse } from 'next/server'
import { ensureSessionMemoryHydrated, getMemoryPrimer, getSessionMemorySnapshot } from '@/lib/data'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import {
  collectAskedQuestions,
  extractAskedQuestions,
  findLatestUserDetails,
  normalizeQuestion,
  pickFallbackQuestion,
} from '@/lib/question-memory'
import { detectCompletionIntent } from '@/lib/intents'
import { resolveGoogleModel } from '@/lib/google'
import {
  getAskFirstSessionGreeting,
  formatAskReturningWithHighlight,
  getAskReturningDefault,
  getAskProviderExceptionPrompt,
} from '@/lib/fallback-texts'

const SYSTEM_PROMPT = `You are the voice of DadsBot, a warm, curious biographer who helps families preserve their memories.
Core responsibilities:
- Listen closely to the newest user message. When audio is provided, transcribe it carefully into natural written English before responding.
- Keep the goal of building a living archive front and center, reassuring the user that you will remember their stories for them.
Conversation openings:
- If the memory prompt indicates no previous sessions and no turns yet in the current session, welcome the user to DadsBot, explain that you're here to help save their stories, and invite them to begin when they feel ready.
- Otherwise, remind the user that you are continuing their personal archive, explicitly mention that you're remembering what they've shared (reference a provided detail when available), and invite them to continue.
Guidelines:
- Start every reply with a concise acknowledgement or summary of what the user just shared.
- Never repeat or closely paraphrase the user's exact phrasing.
- Follow the user's lead and respond directly to any instruction, question, or aside before offering a new prompt.
- Be flexible; if the user hesitates, gently shift the angle instead of repeating yourself.
- Ask at most one short, specific, open-ended question (<= 20 words) only when the user seems ready to continue, and never repeat a question listed in the memory section.
- When you reference remembered material, clearly say you are remembering it for them.
- If the user indicates they are finished, set end_intent to true, respond warmly, and do not ask another question.
Formatting:
- Always respond with valid JSON matching {"reply":"...","transcript":"...","end_intent":true|false}. Do not include commentary, explanations, or code fences.
- The "transcript" field must contain the user's latest message in text form (use your own transcription when audio is supplied).
- Keep the spoken reply under 120 words, natural, and conversational.`

function safeJsonParse(input: string | null | undefined) {
  if (!input) return {}
  try {
    return JSON.parse(input)
  } catch {
    return {}
  }
}

function parseJsonFromText(raw: string | null | undefined) {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed.length) return null
  const withoutFence = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const attempts = [withoutFence]
  const firstBrace = withoutFence.indexOf('{')
  const lastBrace = withoutFence.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    attempts.push(withoutFence.slice(firstBrace, lastBrace + 1))
  }
  for (const attempt of attempts) {
    const candidate = attempt.trim()
    if (!candidate) continue
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  return null
}

type AskAudioBody = {
  audio?: string
  format?: string
  text?: string
  sessionId?: string
  turn?: number
}

type AskAudioResponse = {
  ok: boolean
  provider: string
  reply: string
  transcript: string
  end_intent: boolean
  debug?: {
    sessionId: string | null
    turn: number | null
    provider: string
    usedFallback: boolean
    reason?: string
    providerResponseSnippet?: string
    providerStatus?: number | null
    providerError?: string | null
    memory?: {
      hasPriorSessions: boolean
      hasCurrentConversation: boolean
      highlightDetail: string | null
      recentConversationPreview: string
      historyPreview: string
      questionPreview: string
      primerPreview: string
      primerHandle: string | null
      askedQuestionsPreview: string[]
    }
  }
}

type AskAudioDebug = NonNullable<AskAudioResponse['debug']>

type MemoryPrompt = {
  historyText: string
  questionText: string
  recentConversation: string
  askedQuestions: string[]
  highlightDetail?: string
  primerText: string
  primerHandle: string | null
  hasPriorSessions: boolean
  hasCurrentConversation: boolean
}

type DiagnosticLevel = 'log' | 'error'

const providerHypotheses = [
  'The provider query parameter may be missing or blank.',
  'The PROVIDER environment variable may not be configured.',
  'GOOGLE_API_KEY could be unset for the Google provider.',
  'GOOGLE_MODEL might be blank or unresolved.',
]

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function providerEnvSummary() {
  return {
    providerEnv: process.env.PROVIDER ?? null,
    googleApiKey: process.env.GOOGLE_API_KEY ? 'set' : 'missing',
    googleModel: process.env.GOOGLE_MODEL ?? null,
  }
}

function logDiagnostic(level: DiagnosticLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = {
    ...payload,
    envSummary: providerEnvSummary(),
  }
  const message = `[diagnostic] ${diagnosticsTimestamp()} ${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function softenQuestion(question: string | null | undefined): string {
  if (!question) return ''
  const trimmed = question.trim()
  if (!trimmed.length) return ''
  const withoutQuestion = trimmed.replace(/[?]+$/, '')
  const lowered = withoutQuestion.charAt(0).toLowerCase() + withoutQuestion.slice(1)
  return `If you'd like, you could share ${lowered}?`
}

async function buildMemoryPrompt(sessionId: string | undefined): Promise<MemoryPrompt> {
  if (!sessionId) {
    return {
      historyText: 'No session memory is available yet.',
      questionText: 'No prior questions are on record.',
      recentConversation: '',
      askedQuestions: [],
      primerText: '',
      primerHandle: null,
      highlightDetail: undefined,
      hasPriorSessions: false,
      hasCurrentConversation: false,
    }
  }

  const { current, sessions } = getSessionMemorySnapshot(sessionId)
  const askedQuestions = collectAskedQuestions(sessions)
  const highlightDetail = findLatestUserDetails(sessions, { limit: 1 })[0]
  const primerHandle = current?.user_handle ?? null
  const primer = await getMemoryPrimer(primerHandle)
  const primerText = primer.text ? primer.text.trim() : ''

  const historyLines: string[] = []
  const priorSessions = sessions.filter((session) => session.id !== sessionId)
  const hasPriorSessions = priorSessions.length > 0
  if (priorSessions.length) {
    historyLines.push('Highlights from previous sessions:')
    for (const session of priorSessions.slice(0, 4)) {
      const title = session.title ? session.title : `Session from ${new Date(session.created_at).toLocaleDateString()}`
      const recentDetail = findLatestUserDetails([session], { limit: 1 })[0]
      historyLines.push(`- ${title}${recentDetail ? ` → ${recentDetail}` : ''}`)
    }
  }

  const conversationLines: string[] = []
  const currentTurns = current?.turns ?? []
  const hasCurrentConversation = currentTurns.length > 0
  if (hasCurrentConversation) {
    conversationLines.push('Current session so far:')
    for (const turn of currentTurns.slice(-6)) {
      const roleLabel = turn.role === 'assistant' ? 'You' : 'User'
      conversationLines.push(`${roleLabel}: ${turn.text}`)
    }
  }

  const uniqueQuestions: string[] = []
  const seen = new Set<string>()
  for (const question of askedQuestions) {
    const normalized = normalizeQuestion(question)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    uniqueQuestions.push(question)
    if (uniqueQuestions.length >= 20) break
  }

  const questionLines = uniqueQuestions.length
    ? ['Avoid repeating these prior questions:', ...uniqueQuestions.map((question) => `- ${question}`)]
    : ['No prior questions are on record.']

  return {
    historyText: historyLines.length ? historyLines.join('\n') : 'No previous transcript details are available yet.',
    questionText: questionLines.join('\n'),
    recentConversation: conversationLines.join('\n'),
    askedQuestions,
    highlightDetail,
    primerText,
    primerHandle,
    hasPriorSessions,
    hasCurrentConversation,
  }
}

export async function POST(req: NextRequest) {
  primeNetlifyBlobContextFromHeaders(req.headers)
  const url = new URL(req.url)
  const providerQuery = url.searchParams.get('provider')
  const providerEnv = typeof process.env.PROVIDER === 'string' ? process.env.PROVIDER.trim() : ''
  const providerCandidate = providerQuery && providerQuery.trim().length ? providerQuery.trim() : providerEnv
  const provider = providerCandidate.trim()

  logDiagnostic('log', 'ask-audio:provider:resolve', {
    providerQuery: providerQuery ?? null,
    providerEnv: providerEnv || null,
    resolvedProvider: provider || null,
    hypotheses: providerHypotheses,
  })

  if (!provider) {
    const message = 'No provider was supplied. Set the provider query parameter or PROVIDER env variable.'
    logDiagnostic('error', 'ask-audio:provider:missing', { message })
    return NextResponse.json({ ok: false, error: 'missing_provider', message }, { status: 500 })
  }

  if (provider !== 'google') {
    const message = `Unsupported provider "${provider}". Configure PROVIDER=google and supply GOOGLE_API_KEY/GOOGLE_MODEL.`
    logDiagnostic('error', 'ask-audio:provider:unsupported', { message })
    return NextResponse.json({ ok: false, error: 'unsupported_provider', message }, { status: 500 })
  }

  const googleApiKey = process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.trim() : ''
  if (!googleApiKey) {
    const message = 'GOOGLE_API_KEY is required for the Google audio provider.'
    logDiagnostic('error', 'ask-audio:google:missing-api-key', { message })
    return NextResponse.json({ ok: false, error: 'missing_google_api_key', message }, { status: 500 })
  }

  let model: string
  try {
    model = resolveGoogleModel(process.env.GOOGLE_MODEL)
    logDiagnostic('log', 'ask-audio:google:model-resolved', { model })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to resolve Google model. Set GOOGLE_MODEL to a valid Gemini model.'
    logDiagnostic('error', 'ask-audio:google:model-resolution-failed', { message })
    return NextResponse.json({ ok: false, error: 'missing_google_model', message }, { status: 500 })
  }
  let requestTurn: number | null = null
  let requestSessionId: string | undefined
  let debugMemory: AskAudioDebug['memory'] | undefined
  try {
    const raw = await req.text().catch(() => '')
    const body: AskAudioBody = raw && raw.length ? safeJsonParse(raw) : {}
    const { audio, format = 'webm', text, sessionId } = body || {}
    requestTurn = typeof body?.turn === 'number' ? body.turn : null
    requestSessionId = typeof sessionId === 'string' && sessionId ? sessionId : undefined

    if (sessionId) {
      await ensureSessionMemoryHydrated().catch(() => undefined)
    }
    const memory = await buildMemoryPrompt(sessionId)
    debugMemory = {
      hasPriorSessions: memory.hasPriorSessions,
      hasCurrentConversation: memory.hasCurrentConversation,
      highlightDetail: memory.highlightDetail ?? null,
      recentConversationPreview: memory.recentConversation.slice(0, 400),
      historyPreview: memory.historyText.slice(0, 400),
      questionPreview: memory.questionText.slice(0, 400),
      primerPreview: memory.primerText.slice(0, 400),
      primerHandle: memory.primerHandle,
      askedQuestionsPreview: memory.askedQuestions.slice(0, 10),
    }
    const debugBase = {
      sessionId: requestSessionId ?? null,
      turn: requestTurn,
      provider,
      memory: debugMemory,
    }
    const fallbackQuestion = pickFallbackQuestion(memory.askedQuestions, memory.highlightDetail)
    const fallbackSuggestion = softenQuestion(fallbackQuestion)
    const baseFallbackReply = !memory.hasPriorSessions && !memory.hasCurrentConversation
      ? getAskFirstSessionGreeting()
      : memory.highlightDetail
      ? formatAskReturningWithHighlight(memory.highlightDetail)
      : getAskReturningDefault()
    const fallbackReply = fallbackSuggestion ? `${baseFallbackReply} ${fallbackSuggestion}`.trim() : baseFallbackReply

    const primerSnippet = memory.primerText ? memory.primerText.slice(0, 6000) : ''
    const parts: any[] = [{ text: SYSTEM_PROMPT }]
    if (primerSnippet) {
      parts.push({ text: `Memory primer:\n${primerSnippet}` })
    }
    parts.push({ text: memory.historyText })
    parts.push({ text: memory.questionText })
    if (memory.recentConversation) {
      parts.push({ text: memory.recentConversation })
    }
    if (memory.highlightDetail) {
      parts.push({ text: `Recent remembered detail: ${memory.highlightDetail}` })
    }
    if (audio) parts.push({ inlineData: { mimeType: `audio/${format}`, data: audio } })
    if (text) parts.push({ text })
    parts.push({ text: 'Respond only with JSON in the format {"reply":"...","transcript":"...","end_intent":false}.' })

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
      },
    )
    const json = await response.json().catch(() => ({}))
    const txt =
      json?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || '').filter(Boolean).join('\n') || ''
    const providerStatus = response.status
    const providerErrorMessage =
      typeof json?.error?.message === 'string'
        ? json.error.message
        : typeof json?.error === 'string'
        ? json.error
        : !response.ok
        ? response.statusText || 'Provider request failed'
        : null
    const providerResponseSnippet = (txt && txt.trim().length
      ? txt
      : JSON.stringify(json?.error || json) || '').slice(0, 400)

    const fallback: AskAudioResponse = {
      ok: true,
      provider,
      reply: fallbackReply,
      transcript: text || '',
      end_intent: detectCompletionIntent(text || '').shouldStop,
      debug: {
        ...debugBase,
        usedFallback: true,
        reason: 'fallback_guard',
        providerStatus,
        providerError: providerErrorMessage,
        providerResponseSnippet,
      },
    }

    const parsed = parseJsonFromText(txt)
    if (parsed && typeof parsed === 'object') {
      const rawReply =
        typeof (parsed as any).reply === 'string' && (parsed as any).reply.trim().length
          ? (parsed as any).reply.trim()
          : ''
      const transcriptText =
        typeof (parsed as any).transcript === 'string' && (parsed as any).transcript.trim().length
          ? (parsed as any).transcript
          : fallback.transcript || ''
      const completion = detectCompletionIntent(transcriptText || text || '')

      let candidateQuestion =
        typeof (parsed as any).question === 'string' && (parsed as any).question.trim().length
          ? (parsed as any).question.trim()
          : null

      if (!candidateQuestion && rawReply) {
        const questionsInReply = extractAskedQuestions(rawReply)
        if (questionsInReply.length) {
          candidateQuestion = questionsInReply[questionsInReply.length - 1]
        }
      }

      if (candidateQuestion) {
        const normalizedCandidate = normalizeQuestion(candidateQuestion)
        if (
          normalizedCandidate &&
          memory.askedQuestions.some((question) => normalizeQuestion(question) === normalizedCandidate)
        ) {
          candidateQuestion = fallbackQuestion
        }
      }

      let reply = rawReply
      if (candidateQuestion) {
        reply = reply && !reply.includes(candidateQuestion) ? `${reply} ${candidateQuestion}`.trim() : reply || candidateQuestion
      } else if (fallbackSuggestion) {
        reply = reply ? `${reply} ${fallbackSuggestion}`.trim() : fallbackSuggestion
      }

      if (!reply) {
        reply = fallbackReply
      }

      reply = reply.trim()

      const extractedQuestions = extractAskedQuestions(reply)
      const normalizedFinalQuestion = extractedQuestions.length
        ? normalizeQuestion(extractedQuestions[extractedQuestions.length - 1])
        : ''
      if (
        normalizedFinalQuestion &&
        memory.askedQuestions.some((question) => normalizeQuestion(question) === normalizedFinalQuestion)
      ) {
        reply = reply.includes(fallbackQuestion) ? reply : `${reply} ${fallbackQuestion}`.trim()
      }
      logDiagnostic('log', 'ask-audio:provider:success', {
        providerStatus,
        providerError: providerErrorMessage,
        usedParsedResponse: true,
      })
      return NextResponse.json({
        ok: true,
        provider,
        reply,
        transcript: transcriptText,
        end_intent: Boolean((parsed as any).end_intent) || completion.shouldStop,
        debug: {
          ...debugBase,
          usedFallback: false,
          providerResponseSnippet,
          providerStatus,
          providerError: providerErrorMessage,
        },
      })
    }

    const normalized = normalizeQuestion(txt)
    if (normalized && memory.askedQuestions.some((question) => normalizeQuestion(question) === normalized)) {
      logDiagnostic('error', 'ask-audio:google:duplicate-question', {
        normalizedQuestion: normalized,
      })
      return NextResponse.json(fallback)
    }
    const completion = detectCompletionIntent(txt || text || '')
    const fallbackReason = !response.ok
      ? 'provider_error'
      : txt.trim().length
      ? 'unstructured_response'
      : 'empty_response'
    logDiagnostic('error', 'ask-audio:google:fallback', {
      reason: fallbackReason,
      providerStatus,
      providerError: providerErrorMessage,
    })
    return NextResponse.json({
      ...fallback,
      reply: txt || fallback.reply,
      transcript: txt || fallback.transcript || '',
      end_intent: fallback.end_intent || completion.shouldStop,
      debug: {
        ...debugBase,
        usedFallback: true,
        reason: fallbackReason,
        providerResponseSnippet,
        providerStatus,
        providerError: providerErrorMessage,
      },
    })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error during ask-audio provider execution.'
      logDiagnostic('error', 'ask-audio:provider:exception', { message })
      return NextResponse.json<AskAudioResponse>({
        ok: true,
        provider,
        reply: getAskProviderExceptionPrompt(),
        transcript: '',
        end_intent: false,
        debug: {
          sessionId: requestSessionId ?? null,
          turn: requestTurn,
          provider,
          usedFallback: true,
          reason: 'exception',
          memory: debugMemory,
        },
      })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { ensureSessionMemoryHydrated, getMemoryPrimer, getSessionMemorySnapshot } from '@/lib/data'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { collectAskedQuestions, findLatestUserDetails, normalizeQuestion, pickFallbackQuestion } from '@/lib/question-memory'
import {
  formatIntroGreeting,
  formatIntroReminder,
  getIntroInvitation,
  getIntroQuestion,
} from '@/lib/fallback-texts'
import { resolveGoogleModel } from '@/lib/google'

const INTRO_SYSTEM_PROMPT = `You are the opening voice of DadsBot, a warm, curious biographer.
Mission:
- Introduce the recording session, state that you're here to help preserve the user's stories, and reassure them you will remember what they share.
- If the history is empty, deliver a unique welcome that explains the goal and invites them to begin when they feel ready.
- If history is present, greet them as a returning storyteller, mention that you're remembering their previous sessions (reference one or two provided details when available), and invite them to continue.
Instructions:
- Keep the spoken message under 120 words, conversational, and encouraging.
- Ask exactly one new, specific, open-ended question (<= 22 words) that does not repeat any question from the history section.
- Summarize or acknowledge relevant remembered details naturally, without repeating the user's exact phrasing.
- Respond only with JSON shaped as {"message":"<spoken message>","question":"<the follow-up question>"}. No commentary or code fences.`

type DiagnosticLevel = 'log' | 'error'

const introHypotheses = [
  'GOOGLE_API_KEY may be unset for intro generation.',
  'GOOGLE_MODEL might be missing or blank.',
  'Session memory could be incomplete, leading to fallback copy.',
]

function introTimestamp() {
  return new Date().toISOString()
}

function introEnvSummary() {
  return {
    googleApiKey: process.env.GOOGLE_API_KEY ? 'set' : 'missing',
    googleModel: process.env.GOOGLE_MODEL ?? null,
  }
}

function logIntro(level: DiagnosticLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = {
    ...payload,
    envSummary: introEnvSummary(),
  }
  const message = `[diagnostic] ${introTimestamp()} ${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function buildFallbackIntro(options: {
  titles: string[]
  details: string[]
  question: string
  hasHistory: boolean
}): string {
  const { titles, details, question, hasHistory } = options
  const introPrefix = formatIntroGreeting({ hasHistory, titles })
  const reminder = formatIntroReminder(details)
  const invitation = getIntroInvitation(hasHistory)
  const closingQuestion = getIntroQuestion(hasHistory, question)
  return `${introPrefix} ${reminder} ${invitation} ${closingQuestion}`.trim()
}

function buildHistorySummary(
  titles: string[],
  details: string[],
  askedQuestions: string[],
): { historyText: string; questionText: string } {
  const historyLines: string[] = []
  if (titles.length) {
    historyLines.push('Session titles remembered:')
    for (const title of titles.slice(0, 5)) {
      historyLines.push(`- ${title}`)
    }
  }
  if (details.length) {
    historyLines.push('Recent user details:')
    for (const detail of details.slice(0, 5)) {
      historyLines.push(`- ${detail}`)
    }
  }
  const historyText = historyLines.join('\n') || 'No previous transcript details are available yet.'

  const uniqueQuestions: string[] = []
  const seen = new Set<string>()
  for (const question of askedQuestions) {
    const normalized = normalizeQuestion(question)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    uniqueQuestions.push(question)
    if (uniqueQuestions.length >= 12) break
  }

  const questionLines = uniqueQuestions.length
    ? ['Avoid repeating these prior questions:', ...uniqueQuestions.map((question) => `- ${question}`)]
    : ['No prior questions are on record.']

  return { historyText, questionText: questionLines.join('\n') }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  primeNetlifyBlobContextFromHeaders(req.headers)
  const sessionId = params.id
  logIntro('log', 'session-intro:request:start', { sessionId, hypotheses: introHypotheses })
  await ensureSessionMemoryHydrated().catch(() => undefined)
  const { current, sessions } = getSessionMemorySnapshot(sessionId)
  if (!current) {
    return NextResponse.json({ ok: false, error: 'session_not_found' }, { status: 404 })
  }

  const previousSessions = sessions.filter((session) => session.id !== sessionId)
  const titles = previousSessions
    .map((session) => session.title)
    .filter((title): title is string => Boolean(title && title.trim().length))
    .slice(0, 5)
  const details = findLatestUserDetails(sessions, { excludeSessionId: sessionId, limit: 3 })
  const askedQuestions = collectAskedQuestions(sessions)
  const fallbackQuestion = pickFallbackQuestion(askedQuestions, details[0])
  const fallbackMessage = buildFallbackIntro({
    titles,
    details,
    question: fallbackQuestion,
    hasHistory: previousSessions.length > 0,
  })
  const primer = await getMemoryPrimer(current.user_handle ?? null).catch(() => ({ text: '' }))
  const primerText = primer && typeof primer === 'object' && 'text' in primer && primer.text ? String(primer.text) : ''

  const debug = {
    hasPriorSessions: previousSessions.length > 0,
    sessionCount: sessions.length,
    rememberedTitles: titles,
    rememberedDetails: details,
    askedQuestionsPreview: askedQuestions.slice(0, 10),
    primerPreview: primerText.slice(0, 400),
    primerHandle: current.user_handle ?? null,
    fallbackQuestion,
  }

  const googleApiKey = process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.trim() : ''
  if (!googleApiKey) {
    const message = 'GOOGLE_API_KEY is required for intro generation.'
    logIntro('error', 'session-intro:google:missing-api-key', { sessionId, message })
    return NextResponse.json({ ok: false, error: 'missing_google_api_key', message }, { status: 500 })
  }

  let model: string
  try {
    model = resolveGoogleModel(process.env.GOOGLE_MODEL)
    logIntro('log', 'session-intro:google:model-resolved', { sessionId, model })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to resolve Google model. Set GOOGLE_MODEL to a supported Gemini model.'
    logIntro('error', 'session-intro:google:model-resolution-failed', { sessionId, message })
    return NextResponse.json({ ok: false, error: 'missing_google_model', message }, { status: 500 })
  }

  try {
    const { historyText, questionText } = buildHistorySummary(titles, details, askedQuestions)
    const parts: any[] = [{ text: INTRO_SYSTEM_PROMPT }]
    if (primerText.trim().length) {
      parts.push({ text: `Memory primer:\n${primerText.slice(0, 6000)}` })
    }
    parts.push({ text: historyText })
    parts.push({ text: questionText })
    parts.push({ text: 'Respond only with JSON in the format {"message":"...","question":"..."}.' })

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

    let message = ''
    try {
      const cleaned = txt.trim().replace(/^```(json)?/i, '').replace(/```$/i, '')
      const parsed = JSON.parse(cleaned)
      if (parsed && typeof parsed.message === 'string') {
        message = parsed.message.trim()
        if (parsed.question && typeof parsed.question === 'string') {
          const normalized = normalizeQuestion(parsed.question)
          if (normalized && askedQuestions.some((question) => normalizeQuestion(question) === normalized)) {
            message = `${message} ${fallbackQuestion}`.trim()
          }
        }
      }
    } catch {
      message = txt.trim()
    }

    if (!message || !message.includes('?')) {
      message = `${message ? `${message} ` : ''}${fallbackQuestion}`.trim()
    }

    if (!message) {
      logIntro('error', 'session-intro:google:fallback-empty', {
        sessionId,
        providerStatus,
        providerError: providerErrorMessage,
        providerResponseSnippet,
      })
      return NextResponse.json({ ok: true, message: fallbackMessage, fallback: true, debug })
    }

    logIntro('log', 'session-intro:google:success', {
      sessionId,
      providerStatus,
      providerError: providerErrorMessage,
    })
    return NextResponse.json({ ok: true, message, fallback: false, debug })
  } catch (error: any) {
    const reason = typeof error?.message === 'string' ? error.message : 'intro_failed'
    logIntro('error', 'session-intro:provider:exception', { sessionId, reason })
    return NextResponse.json({ ok: true, message: fallbackMessage, fallback: true, reason, debug })
  }
}

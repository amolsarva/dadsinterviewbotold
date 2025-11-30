import { NextResponse } from 'next/server'
import { jsonErrorResponse } from '@/lib/api-error'
import { resolveGoogleModel } from '@/lib/google'

export const runtime = 'nodejs'

type DiagnosticLevel = 'log' | 'error'

const hypotheses = [
  'GOOGLE_API_KEY may be unset in the diagnostics environment.',
  'GOOGLE_DIAGNOSTICS_MODEL or GOOGLE_MODEL might be blank.',
  'The Google API response could contain errors or empty candidates.',
]

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    googleApiKey: process.env.GOOGLE_API_KEY ? 'set' : 'missing',
    model: process.env.GOOGLE_MODEL ?? null,
  }
}

function log(level: DiagnosticLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = {
    ...payload,
    envSummary: envSummary(),
  }
  const message = `[diagnostic] ${diagnosticsTimestamp()} diagnostics:google:${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function extractReplyText(payload: any): string {
  if (!payload) return ''
  try {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
    for (const candidate of candidates) {
      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
      const text = parts
        .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .filter((value: string) => Boolean(value && value.trim().length))
        .join('\n')
      if (text.trim().length) {
        return text.trim()
      }
    }
  } catch {}
  return ''
}

export async function GET() {
  log('log', 'request:start', { hypotheses })

  const googleApiKey = process.env.GOOGLE_API_KEY ? process.env.GOOGLE_API_KEY.trim() : ''
  if (!googleApiKey) {
    const message = 'GOOGLE_API_KEY is required for diagnostics.'
    log('error', 'request:missing-api-key', { message })
    return NextResponse.json({ ok: false, error: 'missing_google_api_key', message }, { status: 500 })
  }

  let model: string
  try {
    model = resolveGoogleModel(process.env.GOOGLE_MODEL)
    log('log', 'model:resolved', { model, note: 'AmolsLegacyCLEANUP: diagnostics mirror production GOOGLE_MODEL only.' })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unable to resolve Google diagnostics model. Configure GOOGLE_MODEL explicitly.'
    log('error', 'model:resolution-failed', { message })
    return NextResponse.json({ ok: false, error: 'missing_google_model', message }, { status: 500 })
  }

  const prompt = 'Reply with a short confirmation that the Google diagnostics check succeeded.'

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
        cache: 'no-store',
      },
    )

    const json = await response.json().catch(() => ({}))
    const reply = extractReplyText(json)
    const providerStatus = response.status
    const providerErrorMessage =
      typeof json?.error?.message === 'string'
        ? json.error.message
        : typeof json?.error === 'string'
        ? json.error
        : !response.ok
        ? response.statusText || 'Provider request failed'
        : null
    const providerResponseSnippet = reply ? reply.slice(0, 400) : JSON.stringify(json?.error || json || {})

    if (!response.ok) {
      const message =
        typeof json?.error?.message === 'string'
          ? json.error.message
          : typeof json?.error === 'string'
          ? json.error
          : response.statusText || 'Request failed'

      log('error', 'request:provider-error', {
        status: response.status,
        message,
        providerResponseSnippet,
      })
      return NextResponse.json(
        {
          ok: false,
          status: response.status,
          message,
          model: { name: model },
        },
        { status: response.status >= 400 ? response.status : 502 },
      )
    }

    log('log', 'request:success', {
      status: providerStatus,
      providerError: providerErrorMessage,
    })
    return NextResponse.json({
      ok: true,
      status: providerStatus,
      model: { name: model },
      reply,
    })
  } catch (error) {
    log('error', 'request:exception', {
      error: error instanceof Error ? { name: error.name, message: error.message } : { message: 'unknown_error' },
    })
    return jsonErrorResponse(error, 'Google diagnostics failed')
  }
}

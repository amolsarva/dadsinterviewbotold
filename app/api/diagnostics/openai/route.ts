import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { jsonErrorResponse } from '@/lib/api-error'

export const runtime = 'nodejs'

type DiagnosticLevel = 'log' | 'error'

const hypotheses = [
  'OPENAI_API_KEY may be unset for diagnostics.',
  'OPENAI_MODEL could be missing or blank.',
  'The OpenAI API might return an error payload or empty choices.',
]

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    model: process.env.OPENAI_MODEL ?? 'default:gpt-4o-mini',
  }
}

function log(level: DiagnosticLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = {
    ...payload,
    envSummary: envSummary(),
  }
  const message = `[diagnostic] ${diagnosticsTimestamp()} diagnostics:openai:${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function extractErrorMessage(error: any): string {
  if (!error) return 'openai_diagnostics_failed'
  if (typeof error?.error?.message === 'string') return error.error.message
  if (typeof error?.response?.data?.error?.message === 'string') return error.response.data.error.message
  if (typeof error?.response?.data?.error === 'string') return error.response.data.error
  if (typeof error?.message === 'string') return error.message
  return 'openai_diagnostics_failed'
}

function extractStatus(error: any): number {
  if (!error) return 500
  if (typeof error?.status === 'number') return error.status
  if (typeof error?.response?.status === 'number') return error.response.status
  return 500
}

export async function GET() {
  log('log', 'request:start', { hypotheses })

  const openaiApiKey = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.trim() : ''
  if (!openaiApiKey) {
    const message = 'OPENAI_API_KEY is required for diagnostics.'
    log('error', 'request:missing-api-key', { message })
    return NextResponse.json({ ok: false, error: 'missing_openai_api_key', message }, { status: 500 })
  }

  const diagnosticsModel = process.env.OPENAI_MODEL ? process.env.OPENAI_MODEL.trim() : ''
  if (!diagnosticsModel) {
    const message =
      'OPENAI_MODEL must be configured so diagnostics and production share a single source of truth. Defaults are refused.'
    log('error', 'request:missing-model', { message, note: 'AmolsLegacyCLEANUP: removed diagnostics-only model env.' })
    return NextResponse.json({ ok: false, error: 'missing_openai_model', message }, { status: 500 })
  }

  const client = new OpenAI({ apiKey: openaiApiKey })
  const model = diagnosticsModel

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are verifying connectivity for diagnostics.' },
        { role: 'user', content: 'Reply with a brief confirmation that OpenAI connectivity works.' },
      ],
      max_tokens: 60,
    })

    const reply = completion.choices?.[0]?.message?.content?.trim() || ''

    log('log', 'request:success', {
      model,
      replyLength: reply.length,
    })
    return NextResponse.json({
      ok: true,
      status: 200,
      model: { id: completion.model || model },
      reply,
    })
  } catch (error) {
    const status = extractStatus(error)
    const message = extractErrorMessage(error)
    log('error', 'request:exception', {
      status,
      message,
    })
    return jsonErrorResponse(error, message, status >= 400 ? status : 502, {
      status,
      error: message,
    })
  }
}

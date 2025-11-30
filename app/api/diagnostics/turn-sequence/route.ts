import { NextResponse } from 'next/server'
import { jsonErrorResponse } from '@/lib/api-error'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { describeTurnEnv } from '@/lib/turn-service'
import { diagnosticEnvSummary } from '@/lib/data'
import { assertSupabaseEnv } from '@/utils/blob-env'

export const runtime = 'nodejs'

type StepResult = { id: string; status: number; ok: boolean; message?: string }

type SerializedError = { name?: string; message?: string; stack?: string; value?: unknown }

const SAMPLE_AUDIO_BASE64 = Buffer.from('diagnostic turn sequence audio payload').toString('base64')

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error))
    } catch (parseError) {
      return { message: 'Unserializable error payload', value: parseError }
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  return { message: 'Unknown error', value: error }
}

function envSnapshot() {
  return { turn: describeTurnEnv(), deployment: diagnosticEnvSummary() }
}

function logDiagnostic(level: 'log' | 'error', step: string, payload?: Record<string, unknown>) {
  const entry = { step, env: envSnapshot(), ...(payload || {}) }
  const message = `[diagnostic] ${diagnosticsTimestamp()} diagnostics:turn-sequence ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function ensureRequiredEnv() {
  try {
    assertSupabaseEnv({ note: 'turn-sequence-diagnostics' })
  } catch (error) {
    logDiagnostic('error', 'env:missing-supabase', { error: serializeError(error) })
    throw error
  }

  logDiagnostic('log', 'env:supabase:validated', envSnapshot())

  if (!process.env.SUPABASE_TURNS_TABLE) {
    const message = 'SUPABASE_TURNS_TABLE is required for turn diagnostics; no default is assumed.'
    logDiagnostic('error', 'env:missing-turns-table', { message, env: envSnapshot() })
    throw new Error(message)
  }

  logDiagnostic('log', 'env:turns-table:validated', { turnsTable: process.env.SUPABASE_TURNS_TABLE })
}

async function postJson(url: string, label: string, body: Record<string, unknown>) {
  logDiagnostic('log', `${label}:request`, { url, bodyKeys: Object.keys(body) })

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    logDiagnostic('error', `${label}:network-error`, { url, error: serializeError(error) })
    throw Object.assign(new Error(`${label} network failure`), { diagnosticStage: label })
  }

  const rawText = await res.text()
  let parsed: any = null
  try {
    parsed = rawText ? JSON.parse(rawText) : null
  } catch (error) {
    logDiagnostic('error', `${label}:parse`, {
      url,
      status: res.status,
      raw: rawText.slice(0, 500),
      error: serializeError(error),
    })
    const parseError = new Error(`${label} did not return JSON`)
    ;(parseError as any).diagnosticStage = label
    throw parseError
  }

  if (!res.ok) {
    logDiagnostic('error', `${label}:response`, {
      url,
      status: res.status,
      ok: res.ok,
      bodySnippet: rawText.slice(0, 500),
      parsed,
    })
    const responseError = new Error(`${label} failed with status ${res.status}`)
    ;(responseError as any).diagnosticStage = label
    ;(responseError as any).diagnosticResponse = {
      status: res.status,
      ok: res.ok,
      bodySnippet: rawText.slice(0, 500),
      parsed,
    }
    throw responseError
  }

  logDiagnostic('log', `${label}:response`, { url, status: res.status, ok: res.ok })
  return { res, data: parsed }
}

export async function POST(request: Request) {
  const steps: StepResult[] = []
  try {
    ensureRequiredEnv()
    try {
      primeNetlifyBlobContextFromHeaders(request.headers)
    } catch (error) {
      logDiagnostic('error', 'prime-context:failed', { error: serializeError(error) })
      throw error
    }

    const origin = new URL(request.url).origin
    const startUrl = `${origin}/api/session/start`
    const saveTurnUrl = `${origin}/api/save-turn`
    let sessionId: string | null = null

    const start = await postJson(startUrl, 'session-start', {
      emailsEnabled: false,
      userHandle: 'diagnostic-turn-sequence',
    })
    sessionId = typeof start.data?.id === 'string' ? start.data.id : null
    steps.push({ id: 'session_start', status: start.res.status, ok: start.res.ok, message: start.data?.error })
    if (!sessionId) {
      throw new Error('Session start did not return an id')
    }

    const saveTurn = await postJson(saveTurnUrl, 'save-turn', {
      sessionId,
      turn: 1,
      wav: SAMPLE_AUDIO_BASE64,
      mime: 'audio/webm',
      duration_ms: 500,
      reply_text: 'This is a diagnostic reply.',
      transcript: 'This is a diagnostic transcript.',
      provider: 'diagnostic',
      assistant_wav: SAMPLE_AUDIO_BASE64,
      assistant_mime: 'audio/mpeg',
      assistant_duration_ms: 400,
    })
    const turnId = saveTurn.data?.turn?.id || saveTurn.data?.turnId || null
    steps.push({
      id: 'save_turn',
      status: saveTurn.res.status,
      ok: saveTurn.res.ok,
      message: saveTurn.data?.error,
    })

    const turnUrl = `${origin}/api/session/${sessionId}/turn`

    const userTurn = await postJson(turnUrl, 'append-user-turn', {
      role: 'user',
      text: 'Diagnostic turn user text',
    })
    steps.push({
      id: 'append_user_turn',
      status: userTurn.res.status,
      ok: userTurn.res.ok,
      message: userTurn.data?.error,
    })

    const assistantTurn = await postJson(turnUrl, 'append-assistant-turn', {
      role: 'assistant',
      text: 'Diagnostic turn assistant text',
    })
    steps.push({
      id: 'append_assistant_turn',
      status: assistantTurn.res.status,
      ok: assistantTurn.res.ok,
      message: assistantTurn.data?.error,
    })

    const ok = steps.every((step) => step.ok)
    logDiagnostic('log', 'completed', { ok, sessionId, turnId })

    return NextResponse.json({
      ok,
      sessionId,
      turnId,
      steps,
      env: envSnapshot(),
    })
  } catch (error) {
    const stage = (error as any)?.diagnosticStage || 'turn-sequence'
    const serializedError = serializeError(error)
    logDiagnostic('error', 'failed', { stage, error: serializedError, steps })
    return jsonErrorResponse(error, 'turn_sequence_failed', 500, {
      stage,
      steps,
      error: serializedError,
    })
  }
}

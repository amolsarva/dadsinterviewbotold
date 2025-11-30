import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { jsonErrorResponse } from '@/lib/api-error'
import { assertTurnsTableConfigured, describeTurnEnv, saveTurn, uploadAudio, uploadTurnManifest } from '@/lib/turn-service'

const ROUTE_NAME = 'app/api/save-turn'

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error))
    } catch {
      return { ...error }
    }
  }
  if (typeof error === 'string') {
    return { message: error }
  }
  return { message: 'Unknown error', value: error }
}

function logRouteEvent(level: 'log' | 'error', event: string, payload?: Record<string, unknown>) {
  const timestamp = new Date().toISOString()
  const entry = { route: ROUTE_NAME, env: describeTurnEnv(), ...(payload ?? {}) }
  const message = `[diagnostic] ${timestamp} ${event} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

const schema = z.object({
  sessionId: z.string().min(1),
  turn: z.union([z.number().int(), z.string()]),
  wav: z.string().min(1),
  mime: z.string().default('audio/webm'),
  duration_ms: z.union([z.number(), z.string()]).default(0),
  reply_text: z.string().default(''),
  transcript: z.string().default(''),
  provider: z.string().default('google'),
  assistant_wav: z.string().optional(),
  assistant_mime: z.string().default('audio/mpeg'),
  assistant_duration_ms: z.union([z.number(), z.string()]).default(0),
})

export async function POST(req: NextRequest) {
  logRouteEvent('log', 'save-turn:request:start', {
    url: req.url,
  })
  try {
    const table = await assertTurnsTableConfigured()
    logRouteEvent('log', 'save-turn:turn-table:ready', { turnsTable: table })
  } catch (error) {
    logRouteEvent('error', 'save-turn:turn-table:missing', {
      url: req.url,
      error: serializeError(error),
    })
    return jsonErrorResponse(error, 'Supabase turn table unavailable', 400, {
      reason: 'missing_turns_table',
    })
  }
  try {
    primeNetlifyBlobContextFromHeaders(req.headers)
  } catch (error) {
    logRouteEvent('error', 'save-turn:prime-context:failed', {
      url: req.url,
      error: serializeError(error),
    })
    throw error
  }
  try {
    const body = await req.json()
    logRouteEvent('log', 'save-turn:request:body-parsed', {
      keys: body && typeof body === 'object' ? Object.keys(body) : null,
    })
    const parsed = schema.parse(body)
    logRouteEvent('log', 'save-turn:request:validated', {
      sessionId: parsed.sessionId,
      turn: parsed.turn,
      hasAssistantAudio: Boolean(parsed.assistant_wav),
    })

    const turnNumber = typeof parsed.turn === 'string' ? Number(parsed.turn) : parsed.turn
    if (!Number.isFinite(turnNumber) || turnNumber <= 0) {
      throw new Error('Invalid turn number')
    }

    const mime = parsed.mime || 'audio/webm'
    const userAudio = await uploadAudio({
      sessionId: parsed.sessionId,
      turn: turnNumber,
      role: 'user',
      base64: parsed.wav,
      mime,
      label: 'user',
    })

    let assistantAudioUrl: string | null = null
    if (parsed.assistant_wav) {
      const assistantUpload = await uploadAudio({
        sessionId: parsed.sessionId,
        turn: turnNumber,
        role: 'assistant',
        base64: parsed.assistant_wav,
        mime: parsed.assistant_mime || 'audio/mpeg',
        label: 'assistant',
      })
      assistantAudioUrl = assistantUpload.url
    }

    const manifestBody = {
      sessionId: parsed.sessionId,
      turn: turnNumber,
      createdAt: new Date().toISOString(),
      durationMs: Number(parsed.duration_ms) || 0,
      userAudioUrl: userAudio.url,
      transcript: parsed.transcript,
      assistantReply: parsed.reply_text,
      provider: parsed.provider,
      endIntent: false,
      assistantAudioUrl,
      assistantAudioDurationMs: Number(parsed.assistant_duration_ms) || 0,
    }

    const manifest = await uploadTurnManifest({ sessionId: parsed.sessionId, turn: turnNumber, manifest: manifestBody })

    const turnRecord = await saveTurn({
      sessionId: parsed.sessionId,
      turn: turnNumber,
      transcript: parsed.transcript,
      assistantReply: parsed.reply_text,
      provider: parsed.provider,
      manifestUrl: manifest.url,
      userAudioUrl: userAudio.url,
      assistantAudioUrl,
      durationMs: Number(parsed.duration_ms) || 0,
      assistantDurationMs: Number(parsed.assistant_duration_ms) || 0,
    })

    const responsePayload = { ok: true, userAudioUrl: userAudio.url, manifestUrl: manifest.url, turn: turnRecord }
    logRouteEvent('log', 'save-turn:success', {
      sessionId: parsed.sessionId,
      turn: turnNumber,
      userAudioUrl: userAudio.url || null,
      manifestUrl: manifest.url || null,
      assistantAudioUrl,
      turnId: turnRecord?.id || null,
    })
    return NextResponse.json(responsePayload)
  } catch (error) {
    logRouteEvent('error', 'save-turn:failed', {
      url: req.url,
      error: serializeError(error),
    })
    return jsonErrorResponse(error, 'Failed to save turn', 400, {
      reason: 'save_turn_failed',
    })
  }
}

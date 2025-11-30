import { NextResponse } from 'next/server'
import { appendTurn, createSession, finalizeSession } from '@/lib/data'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { listFoxes } from '@/lib/foxes'
import { jsonErrorResponse } from '@/lib/api-error'
import { resolveDefaultNotifyEmailServer } from '@/lib/default-notify-email.server'
import { describeTurnEnv, saveTurn, uploadAudio, uploadTurnManifest } from '@/lib/turn-service'
import { describeDatabaseMetaEnv, getCachedConversationTurnsTable } from '@/db/meta'

export const runtime = 'nodejs'

type Stage =
  | 'create_session'
  | 'append_user_turn'
  | 'append_assistant_turn'
  | 'upload_user_audio'
  | 'upload_turn_manifest'
  | 'save_turn_record'
  | 'finalize_session'

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function envSnapshot() {
  return { turn: resolveTurnEnv(), db: describeDatabaseMetaEnv() }
}

function logDiagnostic(level: 'log' | 'error', event: string, payload?: Record<string, unknown>) {
  const entry = { event, env: envSnapshot(), ...(payload ?? {}) }
  const message = `[diagnostic] ${diagnosticsTimestamp()} diagnostics:e2e ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function resolveTurnEnv() {
  try {
    return describeTurnEnv()
  } catch (error) {
    const serialized = error instanceof Error ? { name: error.name, message: error.message } : { message: 'unknown error' }
    logDiagnostic('error', 'env:resolve:error', { error: serialized })
    throw error
  }
}

function wrapStage<T>(stage: Stage, task: () => Promise<T>): Promise<T> {
  logDiagnostic('log', `${stage}:start`, { stage })
  return task()
    .then((result) => {
      logDiagnostic('log', `${stage}:success`, { stage })
      return result
    })
    .catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err))
      logDiagnostic('error', `${stage}:error`, {
        stage,
        error: { name: error.name, message: error.message, stack: error.stack },
      })
      ;(error as any).diagnosticStage = stage
      throw error
    })
}

export async function POST(request: Request) {
  try {
    logDiagnostic('log', 'request:start', { url: request.url })
    try {
      primeNetlifyBlobContextFromHeaders(request.headers)
      logDiagnostic('log', 'prime-context:success', { url: request.url })
    } catch (error) {
      logDiagnostic('error', 'prime-context:failed', {
        url: request.url,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { error },
      })
      throw error
    }
    const session = await wrapStage('create_session', () =>
      createSession({ email_to: resolveDefaultNotifyEmailServer() })
    )

    await wrapStage('append_user_turn', () =>
      appendTurn(session.id, { role: 'user', text: 'Hello world' } as any)
    )

    await wrapStage('append_assistant_turn', () =>
      appendTurn(session.id, { role: 'assistant', text: 'Tell me more about that.' } as any)
    )

    const diagnosticAudio = Buffer.from('diagnostic e2e audio payload').toString('base64')
    const audioUpload = await wrapStage('upload_user_audio', () =>
      uploadAudio({
        sessionId: session.id,
        turn: 1,
        role: 'user',
        base64: diagnosticAudio,
        mime: 'audio/webm',
        label: 'e2e-user',
      })
    )

    const manifest = await wrapStage('upload_turn_manifest', () =>
      uploadTurnManifest({
        sessionId: session.id,
        turn: 1,
        manifest: {
          sessionId: session.id,
          turn: 1,
          createdAt: new Date().toISOString(),
          transcript: 'Diagnostic e2e test transcript',
          durationMs: 0,
          userAudioUrl: audioUpload.url,
          assistantReply: 'Tell me more about that.',
          provider: 'diagnostic',
        },
      })
    )

    const turnRecord = await wrapStage('save_turn_record', () =>
      saveTurn({
        sessionId: session.id,
        turn: 1,
        transcript: 'Diagnostic e2e test transcript',
        assistantReply: 'Tell me more about that.',
        provider: 'diagnostic',
        manifestUrl: manifest.url,
        userAudioUrl: audioUpload.url,
        durationMs: 0,
      })
    )

    const result = await wrapStage('finalize_session', () =>
      finalizeSession(session.id, { clientDurationMs: 1500 })
    )

    const responsePayload = { ok: true, sessionId: session.id, result, turnId: turnRecord.id, foxes: listFoxes() }
    logDiagnostic('log', 'request:success', { sessionId: session.id, turnId: turnRecord.id })
    return NextResponse.json(responsePayload)
  } catch (error) {
    const blobDetails =
      error && typeof error === 'object'
        ? (error as any).blobDetails ||
          ((error as any).cause && typeof (error as any).cause === 'object'
            ? (error as any).cause.blobDetails
            : undefined)
        : undefined
    const causeMessage =
      error && typeof error === 'object' && (error as any).cause && typeof (error as any).cause === 'object'
        ? (error as any).cause.message
        : undefined
    const stage =
      error && typeof error === 'object' && typeof (error as any).diagnosticStage === 'string'
        ? (error as any).diagnosticStage
        : 'unknown'
    const fallbackMessage =
      error && typeof error === 'object' && typeof (error as any).message === 'string' && (error as any).message.trim().length
        ? (error as any).message
        : 'e2e_failed'
    logDiagnostic('error', 'request:error', {
      stage,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: 'unknown error', value: error },
    })
    return jsonErrorResponse(error, fallbackMessage, 500, {
      stage,
      details: blobDetails,
      cause: causeMessage,
      foxes: listFoxes(),
      turnsTable: getCachedConversationTurnsTable(),
    })
  }
}


import { NextResponse } from 'next/server'
import { createSession, appendTurn, finalizeSession } from '@/lib/data'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { listFoxes } from '@/lib/foxes'
import { jsonErrorResponse } from '@/lib/api-error'
import { resolveDefaultNotifyEmailServer } from '@/lib/default-notify-email.server'
import { saveTurn, uploadAudio, uploadTurnManifest } from '@/lib/turn-service'

export const runtime = 'nodejs'

type Stage =
  | 'create_session'
  | 'append_user_turn'
  | 'append_assistant_turn'
  | 'upload_user_audio'
  | 'upload_turn_manifest'
  | 'save_turn_record'
  | 'finalize_session'

function wrapStage<T>(stage: Stage, task: () => Promise<T>): Promise<T> {
  return task().catch(err => {
    const error = err instanceof Error ? err : new Error(String(err))
    ;(error as any).diagnosticStage = stage
    throw error
  })
}

export async function POST(request: Request) {
  try {
    primeNetlifyBlobContextFromHeaders(request.headers)
    const session = await wrapStage('create_session', () =>
      createSession({ email_to: resolveDefaultNotifyEmailServer() })
    )

    await wrapStage('append_user_turn', () =>
      appendTurn(session.id, { role: 'user', text: 'Hello world' } as any)
    )

    await wrapStage('append_assistant_turn', () =>
      appendTurn(session.id, { role: 'assistant', text: 'Tell me more about that.' } as any)
    )

    const diagnosticAudio = Buffer.from('diagnostic smoke audio payload').toString('base64')
    const audioUpload = await wrapStage('upload_user_audio', () =>
      uploadAudio({
        sessionId: session.id,
        turn: 1,
        role: 'user',
        base64: diagnosticAudio,
        mime: 'audio/webm',
        label: 'smoke-user',
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
          transcript: 'Diagnostic smoke test transcript',
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
        transcript: 'Diagnostic smoke test transcript',
        assistantReply: 'Tell me more about that.',
        provider: 'diagnostic',
        manifestUrl: manifest.url,
        userAudioUrl: audioUpload.url,
        durationMs: 0,
      })
    )

    const result = await wrapStage('finalize_session', () =>
      finalizeSession(session.id, { clientDurationMs: 5000 })
    )

    if ('skipped' in result && result.skipped) {
      return NextResponse.json({ ok: true, sessionId: session.id, skipped: true, foxes: listFoxes() })
    }

    return NextResponse.json({
      ok: true,
      sessionId: session.id,
      artifacts: result.session.artifacts,
      emailed: result.emailed,
      turnId: turnRecord.id,
      foxes: listFoxes(),
    })
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
        : 'smoke_failed'
    return jsonErrorResponse(error, fallbackMessage, 500, {
      stage,
      details: blobDetails,
      cause: causeMessage,
      foxes: listFoxes(),
    })
  }
}

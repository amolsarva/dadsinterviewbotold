import { NextRequest, NextResponse } from 'next/server'

import { getBlobToken, listBlobs, primeNetlifyBlobContextFromHeaders, putBlobFromBuffer } from '@/lib/blob'
import { sendSummaryEmail } from '@/lib/email'
import { getSession, mergeSessionArtifacts, rememberSessionManifest } from '@/lib/data'
import { flagFox, listFoxes } from '@/lib/foxes'
import { resolveDefaultNotifyEmailServer } from '@/lib/default-notify-email.server'

import { z } from 'zod'

function summarizeLink(value: string | null | undefined, label: string, missing = 'unavailable') {
  if (!value) return `${label}: ${missing}`
  if (value.startsWith('data:')) return `${label}: [inline]`
  return `${label}: ${value}`
}

type TurnSummary = {
  turn: number
  audio: string | null
  assistantAudio: string | null
  assistantAudioDurationMs: number
  manifest: string
  transcript: string
  assistantReply: string
  durationMs: number
  createdAt: string | null
  provider?: string
}

const schema = z.object({
  sessionId: z.string().min(1),
  email: z.string().email().optional(),
  sessionAudioUrl: z.string().min(1).optional(),
  sessionAudioDurationMs: z.number().nonnegative().optional(),
  emailsEnabled: z.boolean().optional(),
})

export async function POST(req: NextRequest) {
  primeNetlifyBlobContextFromHeaders(req.headers)
  try {
    const body = await req.json()
    const { sessionId, email, sessionAudioUrl, sessionAudioDurationMs, emailsEnabled } = schema.parse(body)

    const token = getBlobToken()

    let turnBlobs: Awaited<ReturnType<typeof listBlobs>>['blobs'] = []
    let manifestListFailed = false

    if (token) {
      try {
        const prefix = `sessions/${sessionId}/`
        const listed = await listBlobs({ prefix, limit: 2000 })
        turnBlobs = listed.blobs.filter((b) => /turn-\d+\.json$/.test(b.pathname))
        turnBlobs.sort((a, b) => a.pathname.localeCompare(b.pathname))
      } catch (err) {
        console.warn('Failed to list blob turns', err)
        manifestListFailed = true
      }
    }

    const turns: TurnSummary[] = []
    let totalDuration = 0
    let startedAt: string | null = null
    let endedAt: string | null = null
    let missingTranscripts = 0
    let inlineAssistantAudio = 0

    if (turnBlobs.length) {
      for (const blob of turnBlobs) {
        try {
          const resp = await fetch(blob.downloadUrl || blob.url)
          const json = await resp.json()
          const turnNumber = Number(json.turn) || 0
          const transcript = typeof json.transcript === 'string' ? json.transcript : ''
          const assistantReply = typeof json.assistantReply === 'string' ? json.assistantReply : ''
          const assistantAudioUrl =
            typeof json.assistantAudioUrl === 'string' ? json.assistantAudioUrl : null
          const assistantAudioDurationMs = Number(json.assistantAudioDurationMs) || 0
          const createdRaw = json.createdAt || blob.uploadedAt || null
          const created =
            typeof createdRaw === 'string'
              ? createdRaw
              : createdRaw instanceof Date
              ? createdRaw.toISOString()
              : null
          if (created) {
            if (!startedAt || created < startedAt) startedAt = created
            if (!endedAt || created > endedAt) endedAt = created
          }
          const duration = Number(json.durationMs) || 0
          totalDuration += duration
          if (!transcript) missingTranscripts += 1
          if (assistantAudioUrl && assistantAudioUrl.startsWith('data:')) inlineAssistantAudio += 1
          turns.push({
            turn: turnNumber,
            audio: json.userAudioUrl || null,
            assistantAudio: assistantAudioUrl,
            assistantAudioDurationMs,
            manifest: blob.downloadUrl || blob.url,
            transcript,
            assistantReply,
            durationMs: duration,
            createdAt: created,
            provider: typeof json.provider === 'string' ? json.provider : undefined,
          })
        } catch (err) {
          console.warn('Failed to parse turn manifest', err)
          // Skip malformed turn entries but continue processing others
        }
      }
    }

    if (!turns.length) {
      const inMemory = await getSession(sessionId)
      if (!turnBlobs.length) {
        const level = manifestListFailed ? 'error' : 'warn'
        flagFox({
          id: 'theory-3-missing-turn-manifests',
          theory: 3,
          level,
          message: 'No turn manifests were available during session finalization.',
          details: { sessionId, manifestListFailed, hadInMemory: !!inMemory },
        })
      }
      if (inMemory?.turns?.length) {
        let currentTurn = 0
        for (const entry of inMemory.turns) {
          if (entry.role === 'user') {
            currentTurn += 1
            turns.push({
              turn: currentTurn,
              audio: entry.audio_blob_url || null,
              assistantAudio: null,
              assistantAudioDurationMs: 0,
              manifest: '',
              transcript: entry.text,
              assistantReply: '',
              durationMs: 0,
              createdAt: inMemory.created_at,
            })
          } else if (entry.role === 'assistant') {
            const target = turns.find((t) => t.turn === currentTurn)
            if (target) {
              target.assistantReply = entry.text
            } else {
              turns.push({
                turn: currentTurn,
                audio: null,
                assistantAudio: null,
                assistantAudioDurationMs: 0,
                manifest: '',
                transcript: '',
                assistantReply: entry.text,
                durationMs: 0,
                createdAt: inMemory.created_at,
              })
            }
          }
        }
        totalDuration = inMemory.duration_ms || 0
        startedAt = inMemory.created_at
        endedAt = inMemory.created_at
      }
    }

    turns.sort((a, b) => a.turn - b.turn)

    if (missingTranscripts > 0) {
      flagFox({
        id: 'theory-3-turn-missing-transcript',
        theory: 3,
        level: 'warn',
        message: 'One or more turn manifests were missing transcripts.',
        details: { sessionId, missingTranscripts },
      })
    }

    if (inlineAssistantAudio > 0) {
      flagFox({
        id: 'theory-5-inline-assistant-audio',
        theory: 5,
        level: 'warn',
        message: 'Assistant audio manifests referenced inline data URLs.',
        details: { sessionId, inlineAssistantAudio },
      })
    }

    const conversationLines: {
      role: 'user' | 'assistant'
      text: string
      turn: number
      audio?: string | null
    }[] = []
    for (const entry of turns) {
      if (entry.transcript) {
        conversationLines.push({ role: 'user', text: entry.transcript, turn: entry.turn, audio: entry.audio })
      }
      if (entry.assistantReply) {
        conversationLines.push({
          role: 'assistant',
          text: entry.assistantReply,
          turn: entry.turn,
          audio: entry.assistantAudio || undefined,
        })
      }
    }

    const transcriptText = conversationLines
      .filter((line) => line.text)
      .map((line) => `${line.role === 'user' ? 'User' : 'Assistant'} (turn ${line.turn}): ${line.text}`)
      .join('\n')

    const transcriptJson = {
      sessionId,
      createdAt: startedAt,
      turns: conversationLines.map((line) => ({
        role: line.role,
        turn: line.turn,
        text: line.text,
        audio: line.audio || null,
      })),
    }

    const transcriptTxtUpload = await putBlobFromBuffer(
      `sessions/${sessionId}/transcript-${sessionId}.txt`,
      Buffer.from(transcriptText, 'utf8'),

      'text/plain; charset=utf-8',

    )
    const transcriptTxtUrl = transcriptTxtUpload.downloadUrl || transcriptTxtUpload.url
    const transcriptJsonUpload = await putBlobFromBuffer(
      `sessions/${sessionId}/transcript-${sessionId}.json`,
      Buffer.from(JSON.stringify(transcriptJson, null, 2), 'utf8'),

      'application/json',

    )
    const transcriptJsonUrl = transcriptJsonUpload.downloadUrl || transcriptJsonUpload.url

    const manifest = {
      sessionId,
      email: email || resolveDefaultNotifyEmailServer() || null,
      startedAt,
      endedAt,
      totals: { turns: turns.length, durationMs: totalDuration },
      turns: turns.map((t) => ({
        turn: t.turn,
        audio: t.audio,
        assistantAudio: t.assistantAudio,
        assistantAudioDurationMs: t.assistantAudioDurationMs,
        manifest: t.manifest,
        transcript: t.transcript,
        assistantReply: t.assistantReply,
        durationMs: t.durationMs,
        createdAt: t.createdAt,
        provider: t.provider,
      })),
      artifacts: {
        transcript_txt: transcriptTxtUrl,
        transcript_json: transcriptJsonUrl,
        session_manifest: '',
        manifest: '',
        session_audio: sessionAudioUrl || null,
      },
    }

    const manifestUpload = await putBlobFromBuffer(
      `sessions/${sessionId}/session-${sessionId}.json`,
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
      'application/json',

      { access: 'public' },
    )
    const manifestUrl = manifestUpload.downloadUrl || manifestUpload.url
    manifest.artifacts.session_manifest = manifestUrl
    manifest.artifacts.manifest = manifestUrl

    rememberSessionManifest(
      {
        ...manifest,
        artifacts: {
          ...manifest.artifacts,
          session_manifest: manifestUrl,
          manifest: manifestUrl,
          session_audio: sessionAudioUrl || null,
        },
      },
      sessionId,
      startedAt || endedAt || new Date().toISOString(),
      manifestUrl,
    )

    await mergeSessionArtifacts(sessionId, {
      artifacts: {
        session_manifest: manifestUrl,
        manifest: manifestUrl,
        transcript_txt: transcriptTxtUrl,
        transcript_json: transcriptJsonUrl,
        session_audio: sessionAudioUrl || undefined,
      },
      totalTurns: turns.length,
      durationMs: sessionAudioDurationMs ?? totalDuration,

      status: 'completed',
    })

    let emailStatus: Awaited<ReturnType<typeof sendSummaryEmail>> | { skipped: true }
    emailStatus = { skipped: true }

    const allowEmails = emailsEnabled !== false
    const targetEmail = allowEmails ? email || resolveDefaultNotifyEmailServer() : ''
    if (!allowEmails) {
      emailStatus = { skipped: true }
    } else if (!targetEmail) {
      flagFox({
        id: 'theory-4-email-missing-target',
        theory: 4,
        level: 'warn',
        message: 'No target email configured; summary email skipped.',
        details: { sessionId },
      })
    }
    if (targetEmail) {
      const lines = turns
        .map((t) =>
          [
            `Turn ${t.turn}: ${t.transcript || '[no transcript]'}`,
            `Assistant: ${t.assistantReply || '[no reply]'}`,
            summarizeLink(t.audio, 'Audio'),
            summarizeLink(t.assistantAudio, 'Assistant audio'),
            summarizeLink(t.manifest, 'Manifest'),
          ].join('\n'),
        )
        .join('\n\n')
      const bodyParts = [
        'Your session is finalized. Here are your links.',
        summarizeLink(manifestUrl, 'Session manifest'),
        summarizeLink(transcriptTxtUrl, 'Transcript (txt)'),
        summarizeLink(transcriptJsonUrl, 'Transcript (json)'),
        summarizeLink(sessionAudioUrl || null, 'Session audio', 'pending'),
      ]
      if (lines) {
        bodyParts.push('', lines)
      }
      const bodyText = bodyParts.filter((part) => typeof part === 'string' && part.length).join('\n')
      try {
        emailStatus = await sendSummaryEmail(targetEmail, 'DadsBot - Session Summary', bodyText)
      } catch (e: any) {
        emailStatus = { ok: false, provider: 'unknown', error: e?.message || 'send_failed' }
        flagFox({
          id: 'theory-4-email-send-failed-api',
          theory: 4,
          level: 'error',
          message: 'Summary email send failed in finalize-session API.',
          details: { sessionId, error: e?.message || 'send_failed' },
        })
      }
    }

    if ('ok' in emailStatus && emailStatus.ok) {
      await mergeSessionArtifacts(sessionId, { status: 'emailed' })
    } else if ('skipped' in emailStatus && emailStatus.skipped) {
      await mergeSessionArtifacts(sessionId, { status: 'completed' })
    } else {
      await mergeSessionArtifacts(sessionId, { status: 'error' })

      flagFox({
        id: 'theory-4-email-status-error-api',
        theory: 4,
        level: 'warn',
        message: 'Session marked error in finalize-session API because email failed.',
        details: { sessionId, emailStatus },
      })
    }

    if (sessionAudioUrl && sessionAudioUrl.startsWith('data:')) {
      flagFox({
        id: 'theory-5-inline-session-audio',
        theory: 5,
        level: 'warn',
        message: 'Session audio uploaded as inline data URL.',
        details: { sessionId },
      })

    }

    return NextResponse.json({
      ok: true,
      manifestUrl,
      totalTurns: turns.length,
      totalDurationMs: sessionAudioDurationMs ?? totalDuration,
      artifacts: {
        transcript_txt: transcriptTxtUrl,
        transcript_json: transcriptJsonUrl,
        session_audio: sessionAudioUrl || null,
      },
      sessionAudioUrl: sessionAudioUrl || null,
      sessionAudioDurationMs: sessionAudioDurationMs ?? null,
      emailStatus,
      foxes: listFoxes(),
    })
  } catch (e: any) {
    flagFox({
      id: 'theory-3-finalize-exception',
      theory: 3,
      level: 'error',
      message: 'Finalize session API threw an exception.',
      details: { error: e?.message || 'finalize_failed' },
    })
    return NextResponse.json({ ok: false, error: e?.message || 'finalize_failed', foxes: listFoxes() }, { status: 400 })
  }
}

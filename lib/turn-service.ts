// turn-service.ts — safe, minimal, no introspection

import { putBlobFromBuffer } from './blob'
import { getConversationTurnsTable } from '@/db/meta'
import { describeSupabaseEnvSnapshot, getSupabaseClient, logBlobDiagnostic, snapshotSupabaseEnv } from '@/utils/blob-env'
import { type ConversationTurnInsert, type ConversationTurnRow } from '@/types/turns'

type DiagnosticLevel = 'log' | 'error'

type UploadAudioParams = {
  sessionId: string
  turn: number
  role: 'user' | 'assistant'
  base64: string
  mime: string
  label?: string
}

type UploadAudioResult = {
  url: string
  path: string
  bytes: number
  mime: string
  label: string
}

type SaveTurnParams = {
  sessionId: string
  turn: number
  transcript: string
  assistantReply?: string | null
  provider?: string | null
  manifestUrl?: string | null
  userAudioUrl?: string | null
  assistantAudioUrl?: string | null
  durationMs?: number | null
  assistantDurationMs?: number | null
}

type SaveTurnResult = ConversationTurnRow

const nowISO = () => new Date().toISOString()

function logTurnDiagnostic(level: DiagnosticLevel, step: string, payload?: Record<string, unknown>) {
  const env = describeSupabaseEnvSnapshot(snapshotSupabaseEnv())
  const table = getCachedTableName()
  const entry = { env, table, ...(payload ?? {}) }
  const message = `[diagnostic] ${nowISO()} turn-service:${step} ${JSON.stringify(entry)}`
  level === 'error' ? console.error(message) : console.log(message)
}

function getCachedTableName() {
  try {
    return getConversationTurnsTable()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown turns table error'
    console.error(`[diagnostic] ${nowISO()} turn-service:table-resolve-error ${JSON.stringify({ error: message })}`)
    throw error
  }
}

/**
 * Simple, safe table assertion.
 *
 * This avoids ANY introspection, ANY metadata RPC, ANY schema calls.
 * It performs a single safe query:
 *   SELECT * FROM <table> LIMIT 1;
 * which is guaranteed not to trigger Supabase schema validation errors.
 */
export async function assertTurnsTableConfigured(): Promise<string> {
  const table = getCachedTableName()
  const client = getSupabaseClient()

  const { error } = await client.from(table).select('id').limit(1)

  if (error) {
    logTurnDiagnostic('error', 'turns-table:unavailable', { table, error: error.message })
    throw new Error(`Turns table '${table}' is not available: ${error.message}`)
  }

  logTurnDiagnostic('log', 'turns-table:ok', { table })
  return table
}

/**
 * Upload audio file for a turn.
 */
export async function uploadAudio(params: UploadAudioParams): Promise<UploadAudioResult> {
  const { sessionId, turn, role, base64, mime, label = 'audio' } = params
  const payload = base64?.trim() ?? ''
  if (!payload.length) {
    throw new Error('Audio payload is empty')
  }

  const buffer = Buffer.from(payload, 'base64')
  if (!buffer.byteLength) {
    throw new Error('Audio payload decoded to zero bytes')
  }
  const ext = mime.split('/')[1]?.split(';')[0] || 'webm'
  const path = `sessions/${sessionId}/${role}-${String(turn).padStart(4, '0')}.${ext}`

  logTurnDiagnostic('log', 'uploadAudio:start', { path, mime, bytes: buffer.byteLength, label })

  const blob = await putBlobFromBuffer(path, buffer, mime, { access: 'public' })
  const url = blob.downloadUrl || blob.url

  if (!url) {
    const message = 'Upload succeeded but no URL was returned.'
    logTurnDiagnostic('error', 'uploadAudio:url-missing', { path })
    throw new Error(message)
  }

  logTurnDiagnostic('log', 'uploadAudio:success', { path, url })
  return { url, path, bytes: buffer.byteLength, mime, label }
}

/**
 * Upload manifest file for a turn.
 */
export async function uploadTurnManifest({
  sessionId,
  turn,
  manifest,
}: {
  sessionId: string
  turn: number
  manifest: Record<string, unknown>
}) {
  const manifestPath = `sessions/${sessionId}/turn-${String(turn).padStart(4, '0')}.json`
  const body = JSON.stringify(manifest, null, 2)

  logTurnDiagnostic('log', 'uploadManifest:start', { manifestPath, bytes: body.length })

  const blob = await putBlobFromBuffer(
    manifestPath,
    Buffer.from(body, 'utf8'),
    'application/json',
    { access: 'public' }
  )

  const url = blob.downloadUrl || blob.url
  if (!url) {
    logTurnDiagnostic('error', 'uploadManifest:url-missing', { manifestPath })
    throw new Error('Manifest upload returned no URL.')
  }

  logTurnDiagnostic('log', 'uploadManifest:success', { manifestPath, url })
  return { url, path: manifestPath }
}

/**
 * Pass-through transcription logic.
 */
export async function transcribeAudio({
  transcript,
  note,
}: {
  transcript?: string
  note?: string
}) {
  logTurnDiagnostic('log', 'transcribeAudio:start', { note: note || null })

  if (transcript && transcript.trim().length) {
    return { transcript: transcript.trim(), source: 'provided' as const }
  }

  const message = 'transcribeAudio requires a transcription backend; none configured.'
  logTurnDiagnostic('error', 'transcribeAudio:missing-backend', { message })
  throw new Error(message)
}

/**
 * Save turn row to Supabase.
 */
export async function saveTurn(params: SaveTurnParams): Promise<SaveTurnResult> {
  const table = await assertTurnsTableConfigured()
  const client = getSupabaseClient()

  const payload: ConversationTurnInsert = {
    session_id: params.sessionId,
    turn: params.turn,
    transcript: params.transcript,
    assistant_reply: params.assistantReply ?? null,
    provider: params.provider ?? null,
    manifest_url: params.manifestUrl ?? null,
    user_audio_url: params.userAudioUrl ?? null,
    assistant_audio_url: params.assistantAudioUrl ?? null,
    duration_ms: params.durationMs ?? null,
    assistant_duration_ms: params.assistantDurationMs ?? null,
  }

  logTurnDiagnostic('log', 'saveTurn:start', { table, payload })

  const { data, error, status } = await client
    .from(table)
    .insert(payload)
    .select('*')
    .single()

  if (error || !data) {
    const message = error?.message || 'Supabase insert returned no data'
    logTurnDiagnostic('error', 'saveTurn:failure', { table, status, error: message })
    throw new Error(message)
  }

  logTurnDiagnostic('log', 'saveTurn:success', { table, status, id: data.id })
  return data as SaveTurnResult
}

/**
 * Expose env summary for diagnostics; no schema or metadata access.
 */
export function describeTurnEnv() {
  const summary = {
    supabaseUrl: process.env.SUPABASE_URL ? 'set' : 'missing',
    supabaseBucket: process.env.SUPABASE_STORAGE_BUCKET || null,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : null,
    supabaseTurnsTable: process.env.SUPABASE_TURNS_TABLE || null,
  }

  logBlobDiagnostic('log', 'turn-env-summary', summary)
  return summary
}

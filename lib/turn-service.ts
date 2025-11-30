import { putBlobFromBuffer } from './blob'
import { getSupabaseClient, logBlobDiagnostic } from '@/utils/blob-env'

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

type SaveTurnResult = {
  id: string
  session_id: string
  turn: number
  transcript: string
  assistant_reply: string | null
  provider: string | null
  manifest_url: string | null
  user_audio_url: string | null
  assistant_audio_url: string | null
  duration_ms: number | null
  assistant_duration_ms: number | null
  created_at?: string
}

const diagnosticsTimestamp = () => new Date().toISOString()

function envSummary() {
  return {
    supabaseUrl: process.env.SUPABASE_URL ? 'set' : 'missing',
    supabaseBucket: process.env.SUPABASE_STORAGE_BUCKET || null,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
      ? `${process.env.SUPABASE_SERVICE_ROLE_KEY.length} chars`
      : null,
    supabaseTurnsTable: process.env.SUPABASE_TURNS_TABLE || null,
  }
}

function logTurnDiagnostic(level: DiagnosticLevel, step: string, payload?: Record<string, unknown>) {
  const entry = { env: envSummary(), ...(payload ?? {}) }
  const message = `[diagnostic] ${diagnosticsTimestamp()} ${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function resolveTurnsTable() {
  const serverTable = typeof process.env.SUPABASE_TURNS_TABLE === 'string'
    ? process.env.SUPABASE_TURNS_TABLE.trim()
    : ''
  const publicTable = typeof process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE === 'string'
    ? process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE.trim()
    : ''

  if (serverTable) {
    logTurnDiagnostic('log', 'saveTurn:table:resolved', {
      source: 'SUPABASE_TURNS_TABLE',
      table: serverTable,
    })
    return serverTable
  }

  if (publicTable) {
    logTurnDiagnostic('log', 'saveTurn:table:resolved', {
      source: 'NEXT_PUBLIC_SUPABASE_TURNS_TABLE',
      table: publicTable,
      note: 'Using public env var for server-side Supabase writes; ensure parity across environments.',
    })
    return publicTable
  }

  const message = 'SUPABASE_TURNS_TABLE is required to save turns; no default is assumed.'
  logTurnDiagnostic('error', 'saveTurn:table:missing', { message })
  throw new Error(message)
}

export function assertTurnsTableConfigured() {
  const table = resolveTurnsTable()
  logTurnDiagnostic('log', 'saveTurn:table:asserted', { table })
  return table
}

export async function uploadAudio(params: UploadAudioParams): Promise<UploadAudioResult> {
  const { sessionId, turn, role, base64, mime, label = 'audio' } = params
  const timestamp = diagnosticsTimestamp()
  const buffer = Buffer.from(base64, 'base64')
  const ext = mime.split('/')[1]?.split(';')[0] || 'webm'
  const path = `sessions/${sessionId}/${role}-${String(turn).padStart(4, '0')}.${ext}`

  logTurnDiagnostic('log', 'uploadAudio:start', { timestamp, path, mime, bytes: buffer.byteLength, label })
  const blob = await putBlobFromBuffer(path, buffer, mime, { access: 'public' })
  const url = blob.downloadUrl || blob.url
  if (!url) {
    const message = 'Upload succeeded but no URL was returned.'
    logTurnDiagnostic('error', 'uploadAudio:url-missing', { path, mime, bytes: buffer.byteLength, label })
    throw new Error(message)
  }
  logTurnDiagnostic('log', 'uploadAudio:success', { path, mime, bytes: buffer.byteLength, url, label })
  return { url, path, bytes: buffer.byteLength, mime, label }
}

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
  const blob = await putBlobFromBuffer(manifestPath, Buffer.from(body, 'utf8'), 'application/json', {
    access: 'public',
  })
  const url = blob.downloadUrl || blob.url
  if (!url) {
    const message = 'Manifest upload returned no URL.'
    logTurnDiagnostic('error', 'uploadManifest:url-missing', { manifestPath })
    throw new Error(message)
  }
  logTurnDiagnostic('log', 'uploadManifest:success', { manifestPath, url })
  return { url, path: manifestPath }
}

export async function transcribeAudio({
  transcript,
  note,
}: {
  transcript?: string
  note?: string
}) {
  logTurnDiagnostic('log', 'transcribeAudio:start', { note: note || null })
  if (transcript && transcript.trim().length) {
    logTurnDiagnostic('log', 'transcribeAudio:passthrough', { note: 'provided transcript used' })
    return { transcript: transcript.trim(), source: 'provided' as const }
  }
  const message = 'transcribeAudio requires an audio transcription backend; none configured.'
  logTurnDiagnostic('error', 'transcribeAudio:missing-backend', { message })
  throw new Error(message)
}

export async function saveTurn(params: SaveTurnParams): Promise<SaveTurnResult> {
  const table = resolveTurnsTable()
  const client = getSupabaseClient()
  const payload = {
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
  const { data, error, status } = await client.from(table).insert(payload).select('*').single()
  if (error || !data) {
    const message = error?.message || 'Supabase insert returned no data'
    logTurnDiagnostic('error', 'saveTurn:failure', { table, status, error: message })
    throw new Error(message)
  }
  logTurnDiagnostic('log', 'saveTurn:success', { table, status, id: data.id })
  return data as SaveTurnResult
}

export function describeTurnEnv() {
  const summary = envSummary()
  logBlobDiagnostic('log', 'turn-env-summary', summary)
  return summary
}

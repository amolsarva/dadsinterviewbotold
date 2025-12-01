import { createClient, SupabaseClient } from '@supabase/supabase-js'

export type SessionTurnRecord = {
  id: string
  role: 'user' | 'assistant'
  text: string
  audio_blob_url?: string | null
}

export type SessionRecord = {
  id: string
  created_at: string
  title?: string
  email_to: string
  user_handle?: string | null
  status: 'in_progress' | 'completed' | 'emailed' | 'error'
  duration_ms: number
  total_turns: number
  artifacts?: Record<string, string | null | undefined>
  turns?: SessionTurnRecord[]
}

function resolveSessionsTableName(): string {
  const raw = process.env.SUPABASE_SESSIONS_TABLE
  const table = typeof raw === 'string' ? raw.trim() : ''

  if (!table) {
    const message = 'SUPABASE_SESSIONS_TABLE must be set to the Supabase table that stores session metadata.'
    log('error', 'env-missing', { message, name: 'SUPABASE_SESSIONS_TABLE' })
    throw new Error(message)
  }

  return table
}

export const SESSIONS_TABLE = resolveSessionsTableName()

function nowISO() {
  return new Date().toISOString()
}

function envSummary() {
  const tableEnv = typeof process.env.SUPABASE_SESSIONS_TABLE === 'string' ? process.env.SUPABASE_SESSIONS_TABLE.trim() : ''
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'unknown',
    SUPABASE_URL: process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL.length} chars` : 'missing',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
      ? `${process.env.SUPABASE_SERVICE_ROLE_KEY.length} chars`
      : 'missing',
    SUPABASE_SESSIONS_TABLE: tableEnv || '(missing)',
  }
}

function withSessionsTableHint(message: string) {
  const hint =
    'Set SUPABASE_SESSIONS_TABLE to the correct Supabase table and ensure it exists with id, email_to, status, and duration_ms columns.'
  const schemaErrorPattern = /(schema cache|does not exist|missing relation)/i
  if (schemaErrorPattern.test(message)) {
    return `${message} | ${hint}`
  }
  return `${message} | Table: ${SESSIONS_TABLE} | ${hint}`
}

function log(level: 'log' | 'error', step: string, payload: Record<string, unknown> = {}) {
  const entry = { ...payload, env: envSummary() }
  const serialized = `[diagnostic] ${nowISO()} session-store:${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(serialized)
  } else {
    console.log(serialized)
  }
}

function assertEnv(name: string): string {
  const raw = process.env[name]
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) {
    const message = `${name} is required for Supabase session storage.`
    log('error', 'env-missing', { message, name })
    throw new Error(message)
  }
  return value
}

let cachedClient: SupabaseClient | null = null

export function getSupabaseSessionClient(): SupabaseClient {
  if (cachedClient) return cachedClient

  const url = assertEnv('SUPABASE_URL')
  const serviceKey = assertEnv('SUPABASE_SERVICE_ROLE_KEY')

  cachedClient = createClient(url, serviceKey)
  log('log', 'client:created', { table: SESSIONS_TABLE })
  return cachedClient
}

export async function upsertSessionRecord(record: SessionRecord): Promise<SessionRecord> {
  const supabase = getSupabaseSessionClient()
  log('log', 'upsert:start', { sessionId: record.id, table: SESSIONS_TABLE })

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .upsert(record)
    .select()
    .eq('id', record.id)
    .maybeSingle()

  if (error || !data) {
    const message = withSessionsTableHint(error?.message || 'Supabase upsert failed without error payload.')
    log('error', 'upsert:failure', { sessionId: record.id, table: SESSIONS_TABLE, error: message })
    throw new Error(message)
  }

  log('log', 'upsert:success', { sessionId: data.id, table: SESSIONS_TABLE })
  return data as SessionRecord
}

export async function fetchSessionRecord(id: string): Promise<SessionRecord | null> {
  const supabase = getSupabaseSessionClient()
  log('log', 'fetch:start', { sessionId: id, table: SESSIONS_TABLE })

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    const message = withSessionsTableHint(error.message)
    log('error', 'fetch:failure', { sessionId: id, table: SESSIONS_TABLE, error: message })
    throw new Error(message)
  }

  if (!data) {
    log('log', 'fetch:missing', { sessionId: id, table: SESSIONS_TABLE })
    return null
  }

  log('log', 'fetch:success', { sessionId: data.id, table: SESSIONS_TABLE })
  return data as SessionRecord
}

export async function fetchAllSessions(): Promise<SessionRecord[]> {
  const supabase = getSupabaseSessionClient()
  log('log', 'list:start', { table: SESSIONS_TABLE })

  const { data, error } = await supabase
    .from(SESSIONS_TABLE)
    .select('*')
    .order('created_at', { ascending: true })

  if (error) {
    const message = withSessionsTableHint(error.message)
    log('error', 'list:failure', { table: SESSIONS_TABLE, error: message })
    throw new Error(message)
  }

  const sessions = (data as SessionRecord[]) || []
  log('log', 'list:success', { table: SESSIONS_TABLE, count: sessions.length })
  return sessions
}

export async function deleteSessionRecord(id: string): Promise<void> {
  const supabase = getSupabaseSessionClient()
  log('log', 'delete:start', { sessionId: id, table: SESSIONS_TABLE })

  const { error } = await supabase.from(SESSIONS_TABLE).delete().eq('id', id)
  if (error) {
    const message = withSessionsTableHint(error.message)
    log('error', 'delete:failure', { sessionId: id, table: SESSIONS_TABLE, error: message })
    throw new Error(message)
  }

  log('log', 'delete:success', { sessionId: id, table: SESSIONS_TABLE })
}

export async function sessionDbHealth() {
  const supabase = getSupabaseSessionClient()
  log('log', 'health:start', { table: SESSIONS_TABLE })

  const { error } = await supabase.from(SESSIONS_TABLE).select('id', { head: true }).limit(1)

  if (error) {
    const message = withSessionsTableHint(`Supabase sessions table unavailable: ${error.message}`)
    log('error', 'health:failure', { table: SESSIONS_TABLE, error: message })
    return { ok: false, mode: 'supabase', table: SESSIONS_TABLE, error: message }
  }

  log('log', 'health:success', { table: SESSIONS_TABLE })
  return { ok: true, mode: 'supabase', table: SESSIONS_TABLE }
}

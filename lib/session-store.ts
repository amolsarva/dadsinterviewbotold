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

let cachedSessionsTable: string | null = null

function resolveSessionsTableName(step: string): string {
  const raw = process.env.SUPABASE_SESSIONS_TABLE
  const table = typeof raw === 'string' ? raw.trim() : ''

  if (!table) {
    const message = 'SUPABASE_SESSIONS_TABLE must be set to the Supabase table that stores session metadata.'
    log('error', 'env-missing', { message, name: 'SUPABASE_SESSIONS_TABLE', step })
    throw new Error(message)
  }

  if (!cachedSessionsTable || cachedSessionsTable !== table) {
    cachedSessionsTable = table
  }

  return table
}

export function sessionsTableName(step: string): string {
  return resolveSessionsTableName(step)
}

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

function withSessionsTableHint(step: string, message: string) {
  const table = cachedSessionsTable || '(unresolved)'
  const hint =
    'Set SUPABASE_SESSIONS_TABLE to the correct Supabase table and ensure it exists with id, email_to, status, and duration_ms columns.'
  const schemaErrorPattern = /(schema cache|does not exist|missing relation)/i
  const missingTurnsColumnPattern = /'turns' column/i
  if (missingTurnsColumnPattern.test(message)) {
    return `${message} | Sessions table does not persist a "turns" column; sanitize payloads before writing or add a JSON column intentionally.`
  }
  if (schemaErrorPattern.test(message)) {
    return `${message} | ${hint}`
  }
  return `${message} | Table: ${table} | Step: ${step} | ${hint}`
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

function sanitizeSessionPayload(record: SessionRecord, table: string): Omit<SessionRecord, 'turns'> {
  const { turns, ...rest } = record
  if (Array.isArray(turns) && turns.length) {
    log('log', 'upsert:sanitize', {
      sessionId: record.id,
      table,
      removedTurnCount: turns.length,
    })
  }
  return rest
}

let cachedClient: SupabaseClient | null = null

export function getSupabaseSessionClient(): SupabaseClient {
  const table = sessionsTableName('client:create')
  if (cachedClient) return cachedClient

  const url = assertEnv('SUPABASE_URL')
  const serviceKey = assertEnv('SUPABASE_SERVICE_ROLE_KEY')

  cachedClient = createClient(url, serviceKey)
  log('log', 'client:created', { table })
  return cachedClient
}

export async function upsertSessionRecord(record: SessionRecord): Promise<SessionRecord> {
  const supabase = getSupabaseSessionClient()
  const table = sessionsTableName('upsert:start')
  const sanitizedRecord = sanitizeSessionPayload(record, table)
  log('log', 'upsert:start', {
    sessionId: record.id,
    table,
    turnsIncluded: Array.isArray(record.turns) ? record.turns.length : 0,
  })

  const { data, error } = await supabase
    .from(table)
    .upsert(sanitizedRecord)
    .select()
    .eq('id', record.id)
    .maybeSingle()

  if (error || !data) {
    const message = withSessionsTableHint('upsert:failure', error?.message || 'Supabase upsert failed without error payload.')
    log('error', 'upsert:failure', { sessionId: record.id, table, error: message })
    throw new Error(message)
  }

  log('log', 'upsert:success', { sessionId: data.id, table })
  return data as SessionRecord
}

export async function fetchSessionRecord(id: string): Promise<SessionRecord | null> {
  const supabase = getSupabaseSessionClient()
  const table = sessionsTableName('fetch:start')
  log('log', 'fetch:start', { sessionId: id, table })

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) {
    const message = withSessionsTableHint('fetch:failure', error.message)
    log('error', 'fetch:failure', { sessionId: id, table, error: message })
    throw new Error(message)
  }

  if (!data) {
    log('log', 'fetch:missing', { sessionId: id, table })
    return null
  }

  log('log', 'fetch:success', { sessionId: data.id, table })
  return data as SessionRecord
}

export async function fetchAllSessions(): Promise<SessionRecord[]> {
  const supabase = getSupabaseSessionClient()
  const table = sessionsTableName('list:start')
  log('log', 'list:start', { table })

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .order('created_at', { ascending: true })

  if (error) {
    const message = withSessionsTableHint('list:failure', error.message)
    log('error', 'list:failure', { table, error: message })
    throw new Error(message)
  }

  const sessions = (data as SessionRecord[]) || []
  log('log', 'list:success', { table, count: sessions.length })
  return sessions
}

export async function deleteSessionRecord(id: string): Promise<void> {
  const supabase = getSupabaseSessionClient()
  const table = sessionsTableName('delete:start')
  log('log', 'delete:start', { sessionId: id, table })

  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) {
    const message = withSessionsTableHint('delete:failure', error.message)
    log('error', 'delete:failure', { sessionId: id, table, error: message })
    throw new Error(message)
  }

  log('log', 'delete:success', { sessionId: id, table })
}

export async function sessionDbHealth() {
  const supabase = getSupabaseSessionClient()
  const table = sessionsTableName('health:start')
  log('log', 'health:start', { table })

  const { error } = await supabase.from(table).select('id', { head: true }).limit(1)

  if (error) {
    const message = withSessionsTableHint('health:failure', `Supabase sessions table unavailable: ${error.message}`)
    log('error', 'health:failure', { table, error: message })
    return { ok: false, mode: 'supabase', table, error: message }
  }

  log('log', 'health:success', { table })
  return { ok: true, mode: 'supabase', table }
}

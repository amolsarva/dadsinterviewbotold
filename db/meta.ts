import { assertSupabaseEnv, describeSupabaseEnvSnapshot, logBlobDiagnostic, snapshotSupabaseEnv } from '@/utils/blob-env'

const REQUIRED_TABLE_ENV = 'SUPABASE_TURNS_TABLE'
const REQUIRED_PUBLIC_TABLE_ENV = 'NEXT_PUBLIC_SUPABASE_TURNS_TABLE'

let cachedTurnsTable: string | null = null

function nowISO() {
  return new Date().toISOString()
}

function logMeta(level: 'log' | 'error', step: string, payload?: Record<string, unknown>) {
  const entry = {
    timestamp: nowISO(),
    step,
    env: describeDatabaseMetaEnv(),
    ...(payload ?? {}),
  }
  const serialized = `[diagnostic] ${nowISO()} db-meta ${JSON.stringify(entry)}`
  level === 'error' ? console.error(serialized) : console.log(serialized)
}

function requireEnvVar(name: string): string {
  const raw = process.env[name]
  const value = typeof raw === 'string' ? raw.trim() : ''

  if (!value) {
    const message = `${name} is required but missing or blank. Define ${name} in your environment.`
    logMeta('error', 'env-missing', { name, message })
    throw new Error(message)
  }

  return value
}

function assertTurnsTableName(): string {
  const table = requireEnvVar(REQUIRED_TABLE_ENV)
  const publicTable = process.env[REQUIRED_PUBLIC_TABLE_ENV]?.trim()

  if (publicTable && publicTable !== table) {
    const message = `${REQUIRED_PUBLIC_TABLE_ENV} must match ${REQUIRED_TABLE_ENV}; expected '${table}', received '${publicTable}'.`
    logMeta('error', 'env-mismatch', { message })
    throw new Error(message)
  }

  return table
}

export function getConversationTurnsTable(): string {
  if (cachedTurnsTable) return cachedTurnsTable

  const snapshot = snapshotSupabaseEnv()
  assertSupabaseEnv({ snapshot, note: 'Resolving Supabase turns table without discovery' })

  const table = assertTurnsTableName()
  cachedTurnsTable = table

  logMeta('log', 'turns-table:resolved', { table })
  return table
}

export function getCachedConversationTurnsTable(): string | null {
  return cachedTurnsTable
}

export function describeDatabaseMetaEnv() {
  const snapshot = snapshotSupabaseEnv()
  const details = {
    ...describeSupabaseEnvSnapshot(snapshot),
    SUPABASE_TURNS_TABLE: process.env.SUPABASE_TURNS_TABLE?.trim() || null,
    NEXT_PUBLIC_SUPABASE_TURNS_TABLE: process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE?.trim() || null,
    SUPABASE_SESSIONS_TABLE: process.env.SUPABASE_SESSIONS_TABLE?.trim() || null,
  }
  logBlobDiagnostic('log', 'db-meta:env', details)
  return details
}

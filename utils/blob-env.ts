import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const REQUIRED_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'] as const

export type SupabaseEnvSnapshot = Record<(typeof REQUIRED_KEYS)[number], string | undefined>

export type BlobEnvAssertionOptions = {
  note?: string
  snapshot?: SupabaseEnvSnapshot
}

export function logBlobDiagnostic(level: 'log' | 'error', event: string, payload?: Record<string, unknown>) {
  const timestamp = new Date().toISOString()
  const env = describeSupabaseEnvSnapshot()
  const enriched = payload ? { ...payload, env } : { env }
  if (level === 'error') {
    console.error('[diagnostic]', timestamp, event, enriched)
  } else {
    console.log('[diagnostic]', timestamp, event, enriched)
  }
}

export function snapshotSupabaseEnv(): SupabaseEnvSnapshot {
  return REQUIRED_KEYS.reduce<SupabaseEnvSnapshot>((acc, key) => {
    const raw = process.env[key]
    acc[key] = typeof raw === 'string' && raw.trim().length ? raw.trim() : undefined
    return acc
  }, {} as SupabaseEnvSnapshot)
}

export function describeSupabaseEnvSnapshot(snapshot: SupabaseEnvSnapshot = snapshotSupabaseEnv()) {
  return {
    SUPABASE_URL: snapshot.SUPABASE_URL ?? null,
    SUPABASE_SERVICE_ROLE_KEY: snapshot.SUPABASE_SERVICE_ROLE_KEY
      ? `${snapshot.SUPABASE_SERVICE_ROLE_KEY.length} chars`
      : null,
    SUPABASE_STORAGE_BUCKET: snapshot.SUPABASE_STORAGE_BUCKET ?? null,
  }
}

export function assertSupabaseEnv(options: BlobEnvAssertionOptions = {}) {
  const snapshot = options.snapshot ?? snapshotSupabaseEnv()
  const missing = REQUIRED_KEYS.filter((key) => !snapshot[key])
  logBlobDiagnostic('log', 'supabase-env-assertion', { note: options.note, missing, snapshot: describeSupabaseEnvSnapshot(snapshot) })
  if (missing.length) {
    const message = `Missing Supabase configuration: ${missing.join(', ')}`
    logBlobDiagnostic('error', 'supabase-env-missing', { error: message, missing })
    throw new Error(message)
  }
}

let cachedClient: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient
  const snapshot = snapshotSupabaseEnv()
  assertSupabaseEnv({ snapshot, note: 'Initializing Supabase client for storage operations' })
  cachedClient = createClient(snapshot.SUPABASE_URL!, snapshot.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  logBlobDiagnostic('log', 'supabase-client-initialized', {
    url: snapshot.SUPABASE_URL,
    bucket: snapshot.SUPABASE_STORAGE_BUCKET,
  })
  return cachedClient
}

export function getSupabaseBucket(): string {
  const snapshot = snapshotSupabaseEnv()
  assertSupabaseEnv({ snapshot, note: 'Resolving Supabase bucket name' })
  return snapshot.SUPABASE_STORAGE_BUCKET!
}

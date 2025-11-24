import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const REQUIRED_KEYS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'] as const

type ParsedSupabaseUrl = {
  raw: string
  origin: string
  host: string
}

function looksLikePlaceholder(value: string | undefined): boolean {
  if (!value) return false
  const lowered = value.trim().toLowerCase()
  const placeholderTokens = ['your-project-ref', 'example.supabase.co', 'changeme', 'placeholder', 'todo', '[set]', '<']
  return placeholderTokens.some((token) => lowered.includes(token))
}

function parseSupabaseUrl(value: string | undefined): ParsedSupabaseUrl | null {
  if (!value) return null
  try {
    const parsed = new URL(value)
    return { raw: value, origin: parsed.origin, host: parsed.host }
  } catch (error) {
    console.error('[diagnostic]', new Date().toISOString(), 'supabase-url:invalid', {
      value,
      error: error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) },
    })
    return null
  }
}

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
  const parsedUrl = parseSupabaseUrl(snapshot.SUPABASE_URL)
  return {
    SUPABASE_URL: snapshot.SUPABASE_URL ?? null,
    SUPABASE_HOST: parsedUrl?.host ?? null,
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

  const parsedUrl = parseSupabaseUrl(snapshot.SUPABASE_URL)
  if (!parsedUrl) {
    const message = 'SUPABASE_URL is invalid or not a fully-qualified https:// URL. Provide the Supabase project URL explicitly.'
    logBlobDiagnostic('error', 'supabase-env-url-invalid', { error: message, value: snapshot.SUPABASE_URL })
    throw new Error(message)
  }

  if (looksLikePlaceholder(snapshot.SUPABASE_URL)) {
    const message = 'SUPABASE_URL looks like a placeholder. Set the real project URL (e.g., https://<project>.supabase.co).'
    logBlobDiagnostic('error', 'supabase-env-url-placeholder', { error: message, value: snapshot.SUPABASE_URL })
    throw new Error(message)
  }

  if (looksLikePlaceholder(snapshot.SUPABASE_SERVICE_ROLE_KEY)) {
    const message = 'SUPABASE_SERVICE_ROLE_KEY looks like a placeholder. Provide a real service role key from the Supabase project.'
    logBlobDiagnostic('error', 'supabase-env-key-placeholder', { error: message })
    throw new Error(message)
  }

  if (looksLikePlaceholder(snapshot.SUPABASE_STORAGE_BUCKET)) {
    const message = 'SUPABASE_STORAGE_BUCKET looks like a placeholder. Configure the actual bucket name to use for storage.'
    logBlobDiagnostic('error', 'supabase-env-bucket-placeholder', { error: message })
    throw new Error(message)
  }

  const hostLower = parsedUrl.host.toLowerCase()
  const looksSupabaseHost = hostLower.endsWith('.supabase.co') || hostLower.endsWith('.supabase.net')
  if (!looksSupabaseHost) {
    const message = `SUPABASE_URL host must end with .supabase.co or .supabase.net. Received: ${parsedUrl.host}`
    logBlobDiagnostic('error', 'supabase-env-url-host-mismatch', { error: message, host: parsedUrl.host })
    throw new Error(message)
  }

  logBlobDiagnostic('log', 'supabase-env-validated', {
    host: parsedUrl.host,
    origin: parsedUrl.origin,
    bucket: snapshot.SUPABASE_STORAGE_BUCKET,
  })
}

let cachedClient: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient
  const snapshot = snapshotSupabaseEnv()
  assertSupabaseEnv({ snapshot, note: 'Initializing Supabase client for storage operations' })
  const parsedUrl = parseSupabaseUrl(snapshot.SUPABASE_URL)!
  cachedClient = createClient(parsedUrl.origin, snapshot.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  logBlobDiagnostic('log', 'supabase-client-initialized', {
    url: parsedUrl.origin,
    host: parsedUrl.host,
    bucket: snapshot.SUPABASE_STORAGE_BUCKET,
  })
  return cachedClient
}

export function getSupabaseBucket(): string {
  const snapshot = snapshotSupabaseEnv()
  assertSupabaseEnv({ snapshot, note: 'Resolving Supabase bucket name' })
  return snapshot.SUPABASE_STORAGE_BUCKET!
}

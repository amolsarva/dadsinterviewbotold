import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getSupabaseBucket, getSupabaseClient, snapshotSupabaseEnv } from '@/utils/blob-env'

export const runtime = 'nodejs'

type LogLevel = 'log' | 'error'

type HypothesisCategory = 'openai' | 'supabase'

type HypothesisResult = {
  id: string
  category: HypothesisCategory
  label: string
  status: 'ok' | 'warn' | 'error' | 'info'
  detail: string
  evidence?: Record<string, unknown>
  suggestion?: string
  durationMs?: number
}

type OpenAIProbe = {
  ok: boolean
  model?: string
  replyLength?: number
  rawModel?: string | null
  error?: string
}

type OpenAITtsProbe = {
  ok: boolean
  bytes?: number
  error?: string
}

type SupabaseTableProbe = {
  ok: boolean
  tables?: string[]
  error?: string
  status?: number | null
}

const OPENAI_HYPOTHESES = [
  'OPENAI_API_KEY may be missing or blank.',
  'OPENAI_MODEL may be missing.',
  'Requested OpenAI model could be unavailable or removed.',
  'Unexpected response payloads might break parsing.',
  'Diagnostics issue single OpenAI requests without retry/backoff.',
  'TTS requests share the OPENAI_API_KEY and will fail if absent.',
  'TTS model gpt-4o-mini-tts might be unavailable in the account/region.',
  'Client reuse after key rotation can lead to stale credentials.',
  'Served model may differ from requested model, hiding fallbacks.',
  'Diagnostics must run in the node runtime; edge contexts will fail.',
]

const SUPABASE_HYPOTHESES = [
  'Supabase environment variables may be missing or mis-typed.',
  'SUPABASE_URL may not include https:// or the correct host suffix.',
  'Service role key could still be the placeholder value.',
  'Supabase bucket may not exist or be readable with service role.',
  'Turns table hints may be missing for server or client.',
  'Service role may lack access to information_schema for discovery.',
  'SUPABASE_STORAGE_BUCKET might be unset or typoed.',
  'Cached Supabase client errors may persist until restart.',
  'Service role key length could indicate an incomplete copy.',
  'Client NEXT_PUBLIC Supabase env may be missing, preventing parity.',
]

const diagnosticsTimestamp = () => new Date().toISOString()

const envSnapshot = () => {
  const supabaseEnv = snapshotSupabaseEnv()
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'unknown',
    NEXT_RUNTIME: process.env.NEXT_RUNTIME ?? 'nodejs',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'unset',
    SUPABASE_URL: supabaseEnv.SUPABASE_URL ? 'set' : 'missing',
    SUPABASE_SERVICE_ROLE_KEY: supabaseEnv.SUPABASE_SERVICE_ROLE_KEY
      ? `${supabaseEnv.SUPABASE_SERVICE_ROLE_KEY.length} chars`
      : 'missing',
    SUPABASE_STORAGE_BUCKET: supabaseEnv.SUPABASE_STORAGE_BUCKET ?? 'missing',
  }
}

function log(level: LogLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = { ...payload, envSummary: envSnapshot() }
  const message = `[diagnostic] ${diagnosticsTimestamp()} diagnostics:hypotheses:${step}`
  if (level === 'error') {
    console.error(message, entry)
  } else {
    console.log(message, entry)
  }
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error))
    } catch {
      return { message: 'Non-serializable error', value: `${error}` }
    }
  }
  return { message: typeof error === 'string' ? error : 'Unknown error', value: error }
}

async function probeOpenAIChat(): Promise<OpenAIProbe> {
  const started = Date.now()
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const model = process.env.OPENAI_MODEL?.trim()
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY missing' }
  }
  if (!model) {
    return { ok: false, error: 'OPENAI_MODEL missing' }
  }
  try {
    const client = new OpenAI({ apiKey })
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are verifying connectivity for diagnostics.' },
        { role: 'user', content: 'Confirm OpenAI connectivity is working.' },
      ],
      max_tokens: 24,
    })
    const replyLength = completion.choices?.[0]?.message?.content?.trim()?.length ?? 0
    log('log', 'openai-chat:success', {
      durationMs: Date.now() - started,
      model,
      replyLength,
      servedModel: completion.model ?? null,
    })
    return { ok: true, model, replyLength, rawModel: completion.model ?? null }
  } catch (error) {
    const normalized = normalizeError(error)
    log('error', 'openai-chat:failure', { durationMs: Date.now() - started, error: normalized })
    const message = typeof (error as any)?.message === 'string' ? (error as any).message : 'OpenAI chat probe failed'
    return { ok: false, error: message }
  }
}

async function probeOpenAITts(): Promise<OpenAITtsProbe> {
  const started = Date.now()
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return { ok: false, error: 'OPENAI_API_KEY missing for TTS' }
  }
  const client = new OpenAI({ apiKey })
  try {
    const response = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      input: 'diagnostic speech probe',
      voice: 'alloy',
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    log('log', 'openai-tts:success', { durationMs: Date.now() - started, bytes: buffer.length })
    return { ok: true, bytes: buffer.length }
  } catch (error) {
    const normalized = normalizeError(error)
    log('error', 'openai-tts:failure', { durationMs: Date.now() - started, error: normalized })
    const message = typeof (error as any)?.message === 'string' ? (error as any).message : 'OpenAI TTS probe failed'
    return { ok: false, error: message }
  }
}

async function probeSupabaseTables(): Promise<SupabaseTableProbe> {
  const started = Date.now()
  try {
    const client = getSupabaseClient()
    const { data, error, status } = await client
      .from('information_schema.tables')
      .select('table_name')
      .limit(5)
    if (error) {
      const normalized = normalizeError(error)
      log('error', 'supabase-tables:failure', { durationMs: Date.now() - started, error: normalized })
      return {
        ok: false,
        status: typeof status === 'number' ? status : null,
        error: typeof error.message === 'string' ? error.message : 'Failed to list tables',
      }
    }
    const tables = (data ?? [])
      .map((row: any) => (typeof row?.table_name === 'string' ? row.table_name : null))
      .filter((name: string | null): name is string => Boolean(name))
    log('log', 'supabase-tables:success', { durationMs: Date.now() - started, tables })
    return { ok: true, tables }
  } catch (error) {
    const normalized = normalizeError(error)
    log('error', 'supabase-tables:exception', { durationMs: Date.now() - started, error: normalized })
    return { ok: false, error: normalized.message ?? 'Unexpected Supabase table failure' }
  }
}

async function probeSupabaseBucket(): Promise<{ ok: boolean; error?: string }> {
  const started = Date.now()
  try {
    const client = getSupabaseClient()
    const bucket = getSupabaseBucket()
    const { data, error } = await client.storage.getBucket(bucket)
    if (error) {
      const normalized = normalizeError(error)
      log('error', 'supabase-bucket:failure', { durationMs: Date.now() - started, error: normalized, bucket })
      return { ok: false, error: typeof error.message === 'string' ? error.message : 'Bucket lookup failed' }
    }
    const note = data ? 'Bucket metadata retrieved' : 'Bucket returned no metadata'
    log('log', 'supabase-bucket:success', { durationMs: Date.now() - started, bucket, note })
    return { ok: true }
  } catch (error) {
    const normalized = normalizeError(error)
    log('error', 'supabase-bucket:exception', { durationMs: Date.now() - started, error: normalized })
    return { ok: false, error: normalized.message ?? 'Supabase bucket probe failed' }
  }
}

async function runHypotheses(): Promise<HypothesisResult[]> {
  const checks: HypothesisResult[] = []
  const openaiChat = await probeOpenAIChat()
  const openaiTts = await probeOpenAITts()
  const supabaseBucket = await probeSupabaseBucket()
  const supabaseTables = await probeSupabaseTables()

  const openaiModel = process.env.OPENAI_MODEL?.trim()
  const openaiKey = process.env.OPENAI_API_KEY?.trim()
  const supabaseEnv = snapshotSupabaseEnv()

  const add = (entry: HypothesisResult) => checks.push(entry)

  add({
    id: 'openai-key-present',
    category: 'openai',
    label: 'OPENAI_API_KEY present',
    status: openaiKey ? 'ok' : 'error',
    detail: openaiKey ? 'API key is set for diagnostics.' : 'OPENAI_API_KEY is missing; connectivity checks will fail.',
    suggestion: openaiKey ? undefined : 'Set OPENAI_API_KEY to a valid secret; no defaults are assumed.',
  })

  add({
    id: 'openai-model-present',
    category: 'openai',
    label: 'OPENAI_MODEL present',
    status: openaiModel ? 'ok' : 'error',
    detail: openaiModel
      ? `Diagnostics will use ${openaiModel}.`
      : 'OPENAI_MODEL is missing; production and diagnostics cannot align.',
    suggestion: openaiModel ? undefined : 'Set OPENAI_MODEL explicitly; defaults are refused.',
  })

  add({
    id: 'openai-model-available',
    category: 'openai',
    label: 'Model reachable via chat',
    status: openaiChat.ok ? 'ok' : 'error',
    detail: openaiChat.ok
      ? 'Successfully received a chat reply from OpenAI.'
      : `Chat probe failed: ${openaiChat.error ?? 'unknown error'}.`,
    evidence: openaiChat.ok
      ? { replyLength: openaiChat.replyLength, servedModel: openaiChat.rawModel ?? null }
      : undefined,
    suggestion: openaiChat.ok ? undefined : 'Confirm the model name matches your account and region access.',
  })

  add({
    id: 'openai-response-shape',
    category: 'openai',
    label: 'Response payload shape valid',
    status: openaiChat.ok && (openaiChat.replyLength ?? 0) > 0 ? 'ok' : 'warn',
    detail: openaiChat.ok
      ? 'Choices array contained a message payload.'
      : 'Response shape could not be validated because chat probe failed.',
    suggestion: openaiChat.ok
      ? undefined
      : 'Inspect upstream error payloads for schema changes.',
  })

  add({
    id: 'openai-retry-guard',
    category: 'openai',
    label: 'Transient failure guardrails',
    status: 'warn',
    detail:
      'Diagnostics currently attempt a single OpenAI request without retry/backoff; transient outages will surface immediately.',
    suggestion: 'Consider adding bounded retries for diagnostics probes if flakes are common.',
  })

  add({
    id: 'openai-tts-key',
    category: 'openai',
    label: 'TTS key availability',
    status: openaiKey ? 'ok' : 'error',
    detail: openaiKey
      ? 'Shared API key will be used for text and TTS diagnostics.'
      : 'OPENAI_API_KEY missing; TTS cannot initialize.',
  })

  add({
    id: 'openai-tts-model',
    category: 'openai',
    label: 'TTS model reachable',
    status: openaiTts.ok ? 'ok' : 'error',
    detail: openaiTts.ok
      ? 'Successfully generated diagnostic TTS audio.'
      : `TTS probe failed: ${openaiTts.error ?? 'unknown error'}.`,
    evidence: openaiTts.ok ? { bytes: openaiTts.bytes ?? 0 } : undefined,
    suggestion: openaiTts.ok ? undefined : 'Verify gpt-4o-mini-tts access for this account/region.',
  })

  add({
    id: 'openai-client-cache',
    category: 'openai',
    label: 'Client cache freshness',
    status: 'warn',
    detail:
      'Diagnostics instantiate the OpenAI client per request; restart after rotating credentials to avoid stale process state.',
  })

  add({
    id: 'openai-model-mismatch',
    category: 'openai',
    label: 'Requested vs served model',
    status: openaiChat.ok && openaiChat.rawModel && openaiModel && openaiChat.rawModel !== openaiModel ? 'warn' : 'ok',
    detail:
      openaiChat.ok && openaiChat.rawModel && openaiModel && openaiChat.rawModel !== openaiModel
        ? `Served model ${openaiChat.rawModel} differs from requested ${openaiModel}.`
        : 'Served model matches request or is unavailable.',
    suggestion:
      openaiChat.ok && openaiChat.rawModel && openaiModel && openaiChat.rawModel !== openaiModel
        ? 'Align OPENAI_MODEL with the provisioned model to avoid hidden fallbacks.'
        : undefined,
  })

  add({
    id: 'openai-runtime-context',
    category: 'openai',
    label: 'Node runtime confirmed',
    status: process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs' ? 'error' : 'ok',
    detail:
      process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs'
        ? `Diagnostics running on ${process.env.NEXT_RUNTIME}; OpenAI SDK requires node.`
        : 'Diagnostics running on node runtime.',
    suggestion:
      process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs'
        ? 'Move diagnostics route to the node runtime to preserve SDK compatibility.'
        : undefined,
  })

  add({
    id: 'supabase-env-vars',
    category: 'supabase',
    label: 'Supabase env completeness',
    status: supabaseEnv.SUPABASE_URL && supabaseEnv.SUPABASE_SERVICE_ROLE_KEY && supabaseEnv.SUPABASE_STORAGE_BUCKET
      ? 'ok'
      : 'error',
    detail:
      supabaseEnv.SUPABASE_URL && supabaseEnv.SUPABASE_SERVICE_ROLE_KEY && supabaseEnv.SUPABASE_STORAGE_BUCKET
        ? 'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET are set.'
        : 'One or more Supabase env vars are missing; storage will fail.',
    suggestion:
      supabaseEnv.SUPABASE_URL && supabaseEnv.SUPABASE_SERVICE_ROLE_KEY && supabaseEnv.SUPABASE_STORAGE_BUCKET
        ? undefined
        : 'Populate all Supabase env vars; no defaults are assumed.',
  })

  add({
    id: 'supabase-url-shape',
    category: 'supabase',
    label: 'Supabase URL shape',
    status:
      supabaseEnv.SUPABASE_URL && /^https?:\/\//.test(supabaseEnv.SUPABASE_URL) &&
      (supabaseEnv.SUPABASE_URL.endsWith('.supabase.co') || supabaseEnv.SUPABASE_URL.endsWith('.supabase.net'))
        ? 'ok'
        : 'error',
    detail:
      supabaseEnv.SUPABASE_URL && /^https?:\/\//.test(supabaseEnv.SUPABASE_URL)
        ? supabaseEnv.SUPABASE_URL.endsWith('.supabase.co') || supabaseEnv.SUPABASE_URL.endsWith('.supabase.net')
          ? 'Supabase URL format looks valid.'
          : 'Supabase URL host must end with .supabase.co or .supabase.net.'
        : 'Supabase URL missing protocol or value.',
    suggestion: 'Use the full https://<project>.supabase.co URL from your project settings.',
  })

  add({
    id: 'supabase-placeholder-key',
    category: 'supabase',
    label: 'Service role not placeholder',
    status: supabaseEnv.SUPABASE_SERVICE_ROLE_KEY === 'YOUR_SUPABASE_SERVICE_ROLE_KEY' ? 'error' : 'ok',
    detail:
      supabaseEnv.SUPABASE_SERVICE_ROLE_KEY === 'YOUR_SUPABASE_SERVICE_ROLE_KEY'
        ? 'Supabase service role key is using the placeholder value.'
        : 'Service role key is non-placeholder.',
    suggestion:
      supabaseEnv.SUPABASE_SERVICE_ROLE_KEY === 'YOUR_SUPABASE_SERVICE_ROLE_KEY'
        ? 'Replace placeholder with the real service role key; do not rely on defaults.'
        : undefined,
  })

  add({
    id: 'supabase-bucket-access',
    category: 'supabase',
    label: 'Bucket reachable',
    status: supabaseBucket.ok ? 'ok' : 'error',
    detail: supabaseBucket.ok ? 'Bucket metadata query succeeded.' : `Bucket probe failed: ${supabaseBucket.error ?? 'unknown'}.`,
    suggestion: supabaseBucket.ok ? undefined : 'Verify bucket name and service role storage permissions.',
  })

  add({
    id: 'supabase-turns-table',
    category: 'supabase',
    label: 'Turns table configured',
    status: process.env.SUPABASE_TURNS_TABLE && process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE ? 'ok' : 'warn',
    detail:
      process.env.SUPABASE_TURNS_TABLE && process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE
        ? `Server turns table ${process.env.SUPABASE_TURNS_TABLE}; client fallback ${process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE}.`
        : 'Turns table hints are incomplete; client and server may disagree.',
    suggestion:
      process.env.SUPABASE_TURNS_TABLE && process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE
        ? undefined
        : 'Set both SUPABASE_TURNS_TABLE and NEXT_PUBLIC_SUPABASE_TURNS_TABLE to the canonical table.',
  })

  add({
    id: 'supabase-table-discovery',
    category: 'supabase',
    label: 'Table discovery works',
    status: supabaseTables.ok ? 'ok' : 'error',
    detail: supabaseTables.ok
      ? `Information schema responded (${(supabaseTables.tables ?? []).length} tables sampled).`
      : `Table discovery failed: ${supabaseTables.error ?? 'unknown error'}.`,
    evidence: supabaseTables.ok ? { tables: supabaseTables.tables } : undefined,
    suggestion: supabaseTables.ok
      ? undefined
      : 'Ensure the service role has access to information_schema or provide explicit table hints.',
  })

  add({
    id: 'supabase-bucket-name',
    category: 'supabase',
    label: 'Bucket name set',
    status: supabaseEnv.SUPABASE_STORAGE_BUCKET ? 'ok' : 'error',
    detail: supabaseEnv.SUPABASE_STORAGE_BUCKET
      ? `Bucket: ${supabaseEnv.SUPABASE_STORAGE_BUCKET}`
      : 'SUPABASE_STORAGE_BUCKET is missing; uploads will fail.',
  })

  add({
    id: 'supabase-client-cache',
    category: 'supabase',
    label: 'Supabase client caching noted',
    status: 'warn',
    detail:
      'Supabase client is cached per process. If initialization fails once, subsequent calls may reuse the failure until restart.',
    suggestion: 'Restart after env fixes or add cache invalidation after failures.',
  })

  add({
    id: 'supabase-service-key-length',
    category: 'supabase',
    label: 'Service key length',
    status: supabaseEnv.SUPABASE_SERVICE_ROLE_KEY && supabaseEnv.SUPABASE_SERVICE_ROLE_KEY.length > 20 ? 'ok' : 'warn',
    detail: supabaseEnv.SUPABASE_SERVICE_ROLE_KEY
      ? `Key length ${supabaseEnv.SUPABASE_SERVICE_ROLE_KEY.length}.`
      : 'Service role key missing; length cannot be validated.',
    suggestion: !supabaseEnv.SUPABASE_SERVICE_ROLE_KEY
      ? 'Provide the full service role key from Supabase settings.'
      : undefined,
  })

  add({
    id: 'supabase-client-settings',
    category: 'supabase',
    label: 'Client session handling',
    status: 'info',
    detail: 'Supabase client disables session persistence/auto-refresh to avoid stale tokens by design.',
  })

  add({
    id: 'supabase-client-env-alignment',
    category: 'supabase',
    label: 'Client/server env alignment',
    status: process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET ? 'ok' : 'warn',
    detail:
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET
        ? 'Client Supabase URL and bucket are exported.'
        : 'Client Supabase URL or bucket is missing; browser diagnostics may not mirror server storage.',
    suggestion:
      process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET
        ? undefined
        : 'Expose NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET for client diagnostics.',
  })

  return checks
}

export async function GET() {
  try {
    log('log', 'start', {
      hypotheses: {
        openai: OPENAI_HYPOTHESES,
        supabase: SUPABASE_HYPOTHESES,
      },
    })
    const results = await runHypotheses()
    const summary = results.reduce(
      (acc, item) => {
        acc.total += 1
        acc[item.status] = (acc[item.status] ?? 0) + 1
        return acc
      },
      { total: 0, ok: 0, warn: 0, error: 0 } as Record<string, number>,
    )

    log('log', 'complete', { summary })

    return NextResponse.json({
      ok: true,
      checked: results.length,
      summary,
      results,
      hypotheses: { openai: OPENAI_HYPOTHESES, supabase: SUPABASE_HYPOTHESES },
      timestamp: diagnosticsTimestamp(),
    })
  } catch (error) {
    const normalized = normalizeError(error)
    log('error', 'failed', { error: normalized })
    return NextResponse.json(
      {
        ok: false,
        error: 'diagnostics_hypotheses_failed',
        message: normalized.message ?? 'Diagnostics hypotheses failed',
      },
      { status: 500 },
    )
  }
}


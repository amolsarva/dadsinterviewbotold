import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { blobHealth, getBlobEnvironment, primeNetlifyBlobContextFromHeaders, putBlobFromBuffer, readBlob } from '@/lib/blob'
import { getSupabaseBucket, getSupabaseClient, logBlobDiagnostic } from '@/utils/blob-env'
import { jsonErrorResponse } from '@/lib/api-error'
import type { BlobErrorReport } from '@/types/error-types'

const ROUTE_NAME = 'app/api/diagnostics/storage'

const HYPOTHESES = [
  'Supabase environment variables may be missing or mis-typed (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET).',
  'Supabase bucket permissions or existence could block uploads or reads.',
  'Network egress restrictions might prevent reaching Supabase storage.',
]

type LogLevel = 'log' | 'error'

type LogPayload = Record<string, unknown>

type FlowStep = {
  id: string
  label: string
  ok: boolean
  optional?: boolean
  skipped?: boolean
  method?: string
  url?: string
  status?: number
  durationMs?: number
  message?: string
  note?: string
  error?: string
  responseSnippet?: string
  details?: unknown
}

type FlowDiagnostics = {
  ok: boolean
  probeId: string
  startedAt: string
  origin?: string
  uploadPath?: string
  steps: FlowStep[]
}

const formatTimestamp = () => new Date().toISOString()

const envSummary = () => ({
  nodeEnv: process.env.NODE_ENV ?? null,
  supabaseUrl: process.env.SUPABASE_URL ? 'set' : 'missing',
  supabaseBucket: process.env.SUPABASE_STORAGE_BUCKET ?? null,
  supabaseKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
  totalKeys: Object.keys(process.env).length,
})

const logRoute = (level: LogLevel, step: string, payload: LogPayload = {}) => {
  const entry = { route: ROUTE_NAME, step, env: envSummary(), ...payload }
  const message = `[diagnostic] ${formatTimestamp()} ${ROUTE_NAME}:${step}`
  if (level === 'error') {
    console.error(message, entry)
  } else {
    console.log(message, entry)
  }
}

const logRouteError = (step: string, error: unknown, payload: LogPayload = {}) => {
  const normalized =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: 'Non-error rejection', value: error }
  logRoute('error', step, { ...payload, error: normalized })
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error))
    } catch {
      return { ...error }
    }
  }
  return { message: typeof error === 'string' ? error : 'Unknown error', value: error }
}

function stringifyEnvError(envError: BlobErrorReport | null): string | null {
  if (!envError) return null
  return (
    (typeof envError.originalMessage === 'string' && envError.originalMessage.trim()) ||
    (typeof envError.message === 'string' && envError.message.trim()) ||
    'Failed to initialize Supabase storage environment.'
  )
}

function normalizeSupabaseError(error: unknown) {
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : null
  const code = (error as any)?.code ?? null
  const message =
    typeof (error as any)?.message === 'string'
      ? (error as any).message
      : error instanceof Error
      ? error.message
      : 'Unknown Supabase error'
  return { status, code, message }
}

async function verifySupabaseStorageAccess(): Promise<FlowStep> {
  const started = Date.now()
  try {
    const client = getSupabaseClient()
    const bucket = getSupabaseBucket()
    logBlobDiagnostic('log', 'supabase-storage:preflight:start', { bucket })
    const { data, error } = await client.storage.getBucket(bucket)
    if (error) {
      const normalized = normalizeSupabaseError(error)
      logBlobDiagnostic('error', 'supabase-storage:preflight:failure', { bucket, ...normalized })
      return {
        id: 'supabase_preflight',
        label: 'Verify Supabase storage access',
        ok: false,
        durationMs: Date.now() - started,
        status: normalized.status ?? undefined,
        error:
          normalized.status === 401 || normalized.status === 403
            ? 'Service role key lacks storage permissions for bucket.'
            : normalized.message,
        details: { bucket, status: normalized.status, code: normalized.code },
      }
    }

    const note = data ? 'Bucket exists.' : 'Bucket metadata unavailable; proceed cautiously.'
    logBlobDiagnostic('log', 'supabase-storage:preflight:success', { bucket, note })
    return {
      id: 'supabase_preflight',
      label: 'Verify Supabase storage access',
      ok: true,
      durationMs: Date.now() - started,
      message: note,
    }
  } catch (error) {
    const normalized = normalizeSupabaseError(error)
    logBlobDiagnostic('error', 'supabase-storage:preflight:exception', normalized)
    return {
      id: 'supabase_preflight',
      label: 'Verify Supabase storage access',
      ok: false,
      durationMs: Date.now() - started,
      error: normalized.message,
      status: normalized.status ?? undefined,
      details: normalized,
    }
  }
}

export async function GET(req: NextRequest) {
  logRoute('log', 'start', {
    hypotheses: HYPOTHESES,
    method: req.method,
    url: req.url,
    headerKeys: Array.from(req.headers.keys()),
  })

  try {
    logRoute('log', 'context:prime:start', { headerKeys: Array.from(req.headers.keys()) })
    const primed = primeNetlifyBlobContextFromHeaders(req.headers)
    logRoute('log', 'context:prime:complete', { primed })

    const env = getBlobEnvironment()
    const envError = (('error' in env ? (env as any).error : null) ?? null) as BlobErrorReport | null
    logRoute('log', 'environment:resolved', { env, envError })

    if (envError) {
      const message = stringifyEnvError(envError)
      logRoute('error', 'environment:error', { message, envError })
      throw new Error(message ?? 'Supabase storage environment error')
    }

    const health = await blobHealth()
    logRoute('log', 'blob-health:resolved', { health })

    const probeId = randomUUID()
    const startedAt = new Date().toISOString()
    const origin = req.nextUrl?.origin
    const flowSteps: FlowStep[] = []
    const basePath = `diagnostics/${probeId}`
    const uploadPath = `${basePath}/supabase-check.json`
    const payload = JSON.stringify({ probeId, ranAt: startedAt, origin, source: 'storage-diagnostics' })
    const payloadBuffer = Buffer.from(payload, 'utf8')

    const context: FlowDiagnostics = {
      ok: false,
      probeId,
      startedAt,
      origin,
      uploadPath,
      steps: flowSteps,
    }

    const preflight = await verifySupabaseStorageAccess()
    flowSteps.push(preflight)

    // Step 1: upload via Supabase storage
    if (preflight.ok) {
      const started = Date.now()
      try {
        const upload = await putBlobFromBuffer(uploadPath, payloadBuffer, 'application/json', {
          cacheControlMaxAge: 60,
        })
        flowSteps.push({
          id: 'supabase_write',
          label: 'Upload via Supabase storage',
          ok: true,
          durationMs: Date.now() - started,
          message: upload.url,
        })
      } catch (error) {
        const err = error as Error
        const normalized = normalizeSupabaseError(err)
        flowSteps.push({
          id: 'supabase_write',
          label: 'Upload via Supabase storage',
          ok: false,
          durationMs: Date.now() - started,
          error: normalized.message,
          status: normalized.status ?? undefined,
        })
        logRouteError('supabase-write:error', err)
      }
    }

    const writeOk = flowSteps[flowSteps.length - 1]?.ok === true

    // Step 2: read via Supabase storage
    if (writeOk) {
      const started = Date.now()
      try {
        const record = await readBlob(uploadPath)
        if (record) {
          flowSteps.push({
            id: 'supabase_read',
            label: 'Read via Supabase storage',
            ok: true,
            durationMs: Date.now() - started,
            message: `${record.size ?? record.buffer.byteLength} bytes`,
          })
        } else {
          flowSteps.push({
            id: 'supabase_read',
            label: 'Read via Supabase storage',
            ok: false,
            durationMs: Date.now() - started,
            error: 'Blob not found after upload',
          })
        }
      } catch (error) {
        const err = error as Error
        const normalized = normalizeSupabaseError(err)
        flowSteps.push({
          id: 'supabase_read',
          label: 'Read via Supabase storage',
          ok: false,
          durationMs: Date.now() - started,
          error: normalized.message,
          status: normalized.status ?? undefined,
        })
        logRouteError('supabase-read:error', err)
      }
    }

    const flowOk = flowSteps.every((step) => step.ok)
    const ok = health.ok && flowOk
    const message = ok
      ? 'Supabase storage responded to upload and read checks.'
      : 'Supabase storage diagnostics completed with errors. Review flow steps for details.'

    context.ok = ok

    logRoute('log', 'complete', { ok, message, flowOk, healthOk: health.ok })

    return NextResponse.json({
      ok,
      env,
      health,
      message,
      flow: context,
    })
  } catch (error) {
    const serialized = serializeError(error)
    logRouteError('exception', error)
    return jsonErrorResponse(error, serialized.message ?? 'Storage diagnostics failed')
  }
}

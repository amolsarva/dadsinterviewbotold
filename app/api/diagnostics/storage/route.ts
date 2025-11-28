import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import {
  BLOB_PROXY_PREFIX,
  blobHealth,
  getBlobEnvironment,
  primeNetlifyBlobContextFromHeaders,
  putBlobFromBuffer,
  readBlob,
} from '@/lib/blob'
import { jsonErrorResponse } from '@/lib/api-error'
import type { BlobErrorReport } from '@/types/error-types'
import { logBlobDiagnostic } from '@/utils/blob-env'

const ROUTE_NAME = 'app/api/diagnostics/storage'

type LogLevel = 'log' | 'error'

type LogPayload = Record<string, unknown>

const formatTimestamp = () => new Date().toISOString()

const envSummary = () => ({
  nodeEnv: process.env.NODE_ENV ?? null,
  netlify: process.env.NETLIFY ?? null,
  nextRuntime: process.env.NEXT_RUNTIME ?? null,
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

const HYPOTHESES = [
  'Netlify blob credentials were not provisioned, forcing diagnostics to the in-memory fallback.',
  'The Netlify proxy routes are misconfigured, so PUT/GET checks return 4xx or 5xx responses.',
  'Direct Netlify Blobs API calls are blocked (401/403) because NETLIFY_BLOBS_TOKEN or API URL overrides are missing.',
]

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
  sdkPath?: string
  sdkUrl?: string
  sitePutPath?: string
  directApiPath?: string
  steps: FlowStep[]
}

type BlobErrorLike = {
  message?: string
  blobDetails?: unknown
  cause?: BlobErrorLike
  originalMessage?: string
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function snippet(value: string | null | undefined, limit = 200): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.length) return undefined
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, limit - 1)}…`
}

function extractBlobDetails(error: BlobErrorLike | undefined): unknown {
  if (!error || typeof error !== 'object') return undefined
  if (error.blobDetails) return error.blobDetails
  if (error.cause && typeof error.cause === 'object') {
    return extractBlobDetails(error.cause)
  }
  return undefined
}

function buildSiteUrl(origin: string | undefined, path: string): string | null {
  if (!origin) return null
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path
  }
  if (path.startsWith('data:')) {
    return null
  }
  const normalized = path.startsWith('/') ? path : `${BLOB_PROXY_PREFIX}${encodePathSegments(path)}`
  try {
    return new URL(normalized, origin).toString()
  } catch {
    return null
  }
}

async function captureResponseSnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text()
    return snippet(text)
  } catch {
    return undefined
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
    const strictStorageEnabled =
      (env as { provider?: string; configured?: boolean }).provider === 'netlify' && Boolean((env as any).configured) && !envError
    logRoute('log', 'strict-mode:status', {
      strictStorageEnabled,
      message: strictStorageEnabled
        ? 'Netlify credentials detected; memory fallback disabled.'
        : 'Missing Netlify credentials; memory fallback remains available.',
    })
    const health = await blobHealth()
    logRoute('log', 'blob-health:resolved', { health })
    const flowSteps: FlowStep[] = []

    const probeId = randomUUID()
    const startedAt = new Date().toISOString()
    const origin = req.nextUrl?.origin
    const context: FlowDiagnostics = {
      ok: false,
      probeId,
      startedAt,
      origin,
      steps: flowSteps,
    }

    const hasNetlifyConfig =
      (env as { provider?: string; store?: string; siteId?: string }).provider === 'netlify' &&
      Boolean((env as any).store) &&
      Boolean((env as any).siteId)
    const canProbeNetlify = hasNetlifyConfig && Boolean((env as any).configured) && !envError

    if (hasNetlifyConfig && envError) {
      flowSteps.push({
        id: 'netlify_init',
        label: 'Netlify blob initialization',
        ok: false,
        error:
          (typeof envError.originalMessage === 'string' && envError.originalMessage.trim()) ||
          (typeof envError.message === 'string' && envError.message.trim()) ||
          'Failed to initialize the Netlify blob store.',
        details: envError,
      })
      logRoute('error', 'netlify-init:error', { envError })
    }

    if (canProbeNetlify) {
      const netlifyEnv = env as Record<string, any>

      const basePath = `diagnostics/${probeId}`
      const sdkPath = `${basePath}/sdk-check.json`
      const sitePutPath = `${basePath}/site-proxy-check.json`
      const directApiPath = `${basePath}/direct-api-check.json`
      const payload = JSON.stringify({
        probeId,
        ranAt: startedAt,
        origin,
        source: 'storage-diagnostics',
      })
      const payloadBuffer = Buffer.from(payload, 'utf8')

      context.sdkPath = sdkPath
      context.sitePutPath = sitePutPath
      context.directApiPath = directApiPath

      let sdkUrl: string | undefined

      // Step 1: upload via Netlify SDK
      {
        const started = Date.now()
        try {
          const upload = await putBlobFromBuffer(sdkPath, payloadBuffer, 'application/json', {
            cacheControlMaxAge: 60,
          })
          sdkUrl = upload.url
          context.sdkUrl = upload.url
          flowSteps.push({
            id: 'sdk_write',
            label: 'Upload via Netlify SDK',
            ok: true,
            durationMs: Date.now() - started,
            message: upload.url,
          })
        } catch (error) {
          const err = error as BlobErrorLike
          flowSteps.push({
            id: 'sdk_write',
            label: 'Upload via Netlify SDK',
            ok: false,
            durationMs: Date.now() - started,
            error: err?.message,
            details: extractBlobDetails(err),
          })
        }
      }

      const sdkWriteOk = flowSteps[flowSteps.length - 1]?.ok === true

      // Step 2: read via SDK
      if (sdkWriteOk) {
        const started = Date.now()
        try {
          const record = await readBlob(sdkPath)
          if (record) {
            flowSteps.push({
              id: 'sdk_read',
              label: 'Read via Netlify SDK',
              ok: true,
              durationMs: Date.now() - started,
              message: `${record.size ?? record.buffer.byteLength} bytes`,
            })
          } else {
            flowSteps.push({
              id: 'sdk_read',
              label: 'Read via Netlify SDK',
              ok: false,
              durationMs: Date.now() - started,
              error: 'Blob not found after upload',
            })
          }
        } catch (error) {
          const err = error as BlobErrorLike
          flowSteps.push({
            id: 'sdk_read',
            label: 'Read via Netlify SDK',
            ok: false,
            durationMs: Date.now() - started,
            error: err?.message,
            details: extractBlobDetails(err),
          })
        }
      }

      // Step 3: GET via deployed site proxy
      if (sdkUrl) {
        const siteUrl = buildSiteUrl(origin, sdkUrl)
        if (siteUrl) {
          const started = Date.now()
          try {
            const res = await fetch(siteUrl, {
              method: 'GET',
              headers: { 'user-agent': 'dads-interview-bot/diagnostics' },
              cache: 'no-store',
            })
            const bodySnippet = await captureResponseSnippet(res)
            flowSteps.push({
              id: 'proxy_get',
              label: 'GET via site /api/blob proxy',
              ok: res.ok,
              method: 'GET',
              url: siteUrl,
              status: res.status,
              durationMs: Date.now() - started,
              responseSnippet: bodySnippet,
            })
          } catch (error) {
            const err = error as Error
            flowSteps.push({
              id: 'proxy_get',
              label: 'GET via site /api/blob proxy',
              ok: false,
              method: 'GET',
              url: siteUrl,
              durationMs: Date.now() - started,
              error: err?.message,
            })
          }
        } else {
          flowSteps.push({
            id: 'proxy_get',
            label: 'GET via site /api/blob proxy',
            ok: false,
            optional: true,
            skipped: true,
            message: sdkUrl.startsWith('data:')
              ? 'Proxy URL is a data URI (in-memory fallback); skipping site fetch.'
              : 'Unable to determine site URL for blob proxy.',
          })
        }
      }

      // Step 4: PUT via deployed site proxy (critical for production writes)
      {
        const siteUrl = buildSiteUrl(origin, `${BLOB_PROXY_PREFIX}${encodePathSegments(sitePutPath)}`)
        if (siteUrl) {
          const started = Date.now()
          try {
            const res = await fetch(siteUrl, {
              method: 'PUT',
              body: payloadBuffer,
              headers: {
                'content-type': 'application/json',
                'user-agent': 'dads-interview-bot/diagnostics',
              },
            })
            const bodySnippet = await captureResponseSnippet(res)
            flowSteps.push({
              id: 'proxy_put',
              label: 'PUT via site /api/blob proxy',
              ok: res.ok,
              method: 'PUT',
              url: siteUrl,
              status: res.status,
              durationMs: Date.now() - started,
              responseSnippet: bodySnippet,
            })
          } catch (error) {
            const err = error as Error
            flowSteps.push({
              id: 'proxy_put',
              label: 'PUT via site /api/blob proxy',
              ok: false,
              method: 'PUT',
              url: siteUrl,
              durationMs: Date.now() - started,
              error: err?.message,
            })
          }
        } else {
          flowSteps.push({
            id: 'proxy_put',
            label: 'PUT via site /api/blob proxy',
            ok: false,
            optional: true,
            skipped: true,
            error: 'Unable to construct site proxy URL for PUT test.',
          })
        }
      }

      // Step 5: GET the site PUT target to verify persistence
      {
        const siteUrl = buildSiteUrl(origin, `${BLOB_PROXY_PREFIX}${encodePathSegments(sitePutPath)}`)
        if (siteUrl) {
          const started = Date.now()
          try {
            const res = await fetch(siteUrl, {
              method: 'GET',
              headers: { 'user-agent': 'dads-interview-bot/diagnostics' },
              cache: 'no-store',
            })
            const bodySnippet = await captureResponseSnippet(res)
            flowSteps.push({
              id: 'proxy_put_verify',
              label: 'GET site PUT target',
              ok: res.ok,
              method: 'GET',
              url: siteUrl,
              status: res.status,
              durationMs: Date.now() - started,
              responseSnippet: bodySnippet,
            })
          } catch (error) {
            const err = error as Error
            flowSteps.push({
              id: 'proxy_put_verify',
              label: 'GET site PUT target',
              ok: false,
              method: 'GET',
              url: siteUrl,
              durationMs: Date.now() - started,
              error: err?.message,
            })
          }
        } else {
          flowSteps.push({
            id: 'proxy_put_verify',
            label: 'GET site PUT target',
            ok: false,
            optional: true,
            skipped: true,
            error: 'Unable to construct verification URL for PUT test.',
          })
        }
      }

      // Step 6: Direct Netlify API PUT/GET/DELETE checks (optional but informative)
      const token = (process.env.NETLIFY_BLOBS_TOKEN || '').trim() || (process.env.NETLIFY_API_TOKEN || '').trim()
      const siteId = netlifyEnv.siteId
      const storeName = netlifyEnv.store
      const rawApiBase = process.env.NETLIFY_BLOBS_API_URL ? process.env.NETLIFY_BLOBS_API_URL.trim() : ''
      if (!rawApiBase) {
        const message = 'NETLIFY_BLOBS_API_URL is required for direct Netlify API diagnostics.'
        logBlobDiagnostic('error', 'storage-diagnostics:missing-api-base', {
          probeId,
          message,
        })
        logRouteError('direct-api:missing-base', new Error(message), { probeId })
        flowSteps.push({
          id: 'direct_api_base',
          label: 'Netlify API base URL configured',
          ok: false,
          optional: true,
          error: message,
        })
        context.steps = flowSteps
        return NextResponse.json(
          {
            ...context,
            ok: false,
            message,
            error: 'missing_netlify_blobs_api_url',
          },
          { status: 500 },
        )
      }

      const apiBase = rawApiBase.replace(/\/+$/, '')

      if (token && siteId && storeName) {
        const directUrl = `${apiBase}/sites/${encodeURIComponent(siteId)}/stores/${encodeURIComponent(
          storeName,
        )}/items/${encodePathSegments(directApiPath)}`

        // PUT
        {
          const started = Date.now()
          try {
            const res = await fetch(directUrl, {
              method: 'PUT',
              body: payloadBuffer,
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'user-agent': 'dads-interview-bot/diagnostics',
              },
            })
            const bodySnippet = await captureResponseSnippet(res)
            flowSteps.push({
              id: 'direct_api_put',
              label: 'PUT via Netlify blobs API',
              ok: res.ok,
              optional: true,
              method: 'PUT',
              url: directUrl,
              status: res.status,
              durationMs: Date.now() - started,
              responseSnippet: bodySnippet,
            })
          } catch (error) {
            const err = error as Error
            flowSteps.push({
              id: 'direct_api_put',
              label: 'PUT via Netlify blobs API',
              ok: false,
              optional: true,
              method: 'PUT',
              url: directUrl,
              durationMs: Date.now() - started,
              error: err?.message,
            })
          }
        }

        // GET
        {
          const started = Date.now()
          try {
            const res = await fetch(directUrl, {
              method: 'GET',
              headers: {
                authorization: `Bearer ${token}`,
                'user-agent': 'dads-interview-bot/diagnostics',
              },
            })
            const bodySnippet = await captureResponseSnippet(res)
            flowSteps.push({
              id: 'direct_api_get',
              label: 'GET via Netlify blobs API',
              ok: res.ok,
              optional: true,
              method: 'GET',
              url: directUrl,
              status: res.status,
              durationMs: Date.now() - started,
              responseSnippet: bodySnippet,
            })
          } catch (error) {
            const err = error as Error
            flowSteps.push({
              id: 'direct_api_get',
              label: 'GET via Netlify blobs API',
              ok: false,
              optional: true,
              method: 'GET',
              url: directUrl,
              durationMs: Date.now() - started,
              error: err?.message,
            })
          }
        }

        // DELETE
        {
          const started = Date.now()
          try {
            const res = await fetch(directUrl, {
              method: 'DELETE',
              headers: {
                authorization: `Bearer ${token}`,
                'user-agent': 'dads-interview-bot/diagnostics',
              },
            })
            const bodySnippet = await captureResponseSnippet(res)
            flowSteps.push({
              id: 'direct_api_delete',
              label: 'DELETE via Netlify blobs API',
              ok: res.ok || res.status === 404,
              optional: true,
              method: 'DELETE',
              url: directUrl,
              status: res.status,
              durationMs: Date.now() - started,
              responseSnippet: bodySnippet,
              note: res.status === 404 ? 'Resource already removed' : undefined,
            })
          } catch (error) {
            const err = error as Error
            flowSteps.push({
              id: 'direct_api_delete',
              label: 'DELETE via Netlify blobs API',
              ok: false,
              optional: true,
              method: 'DELETE',
              url: directUrl,
              durationMs: Date.now() - started,
              error: err?.message,
            })
          }
        }
      } else {
        flowSteps.push({
          id: 'direct_api_put',
          label: 'PUT via Netlify blobs API',
          ok: false,
          optional: true,
          skipped: true,
          error: 'Missing NETLIFY_BLOBS_TOKEN or site/store identifiers; skipping direct API checks.',
        })
      }
    } else {
      flowSteps.push({
        id: 'netlify_config',
        label: 'Netlify blob configuration',
        ok: false,
        optional: true,
        skipped: true,
        error: 'Netlify blob storage is not configured; skipping flow diagnostics.',
      })
      logRoute('error', 'netlify-config:missing', { env })
    }

    const requiredFailures = flowSteps.filter((step) => !step.optional && !step.ok && !step.skipped)
    const flowOk = requiredFailures.length === 0
    context.ok = flowOk

    const ok = canProbeNetlify && health.ok && health.mode === 'netlify' && flowOk

    let message: string

    if (ok) {
      message = `Netlify blob store "${(env as any).store || 'default'}" responded to SDK and proxy checks.`
    } else if (!hasNetlifyConfig) {
      const missing = (env as any).diagnostics?.missing?.length ? (env as any).diagnostics.missing.join(', ') : null
      message = missing
        ? `Storage is running in in-memory fallback mode. Missing configuration: ${missing}.`
        : 'Storage is running in in-memory fallback mode.'
    } else if (envError) {
      message =
        (typeof envError.originalMessage === 'string' && envError.originalMessage.trim()) ||
        (typeof envError.message === 'string' && envError.message.trim()) ||
        'Failed to initialize Netlify blob storage. Check error details.'
    } else if (!health.ok || health.mode !== 'netlify') {
      message = `Netlify storage health check failed: ${(health as any).reason || health.error || 'unknown error'}`
    } else if (!flowOk && requiredFailures.length) {
      const first = requiredFailures[0]
      const statusLabel = typeof first.status === 'number' ? ` (HTTP ${first.status})` : ''
      const methodLabel = first.method ? `${first.method} ` : ''
      const errorLabel = first.error ? ` — ${first.error}` : first.responseSnippet ? ` — ${first.responseSnippet}` : ''
      message = `Blob flow failed during ${methodLabel}${first.label}${statusLabel}${errorLabel}`
    } else {
      message = 'Netlify storage diagnostics completed with warnings. Review flow steps for details.'
    }

    logRoute('log', 'result', {
      ok,
      flowOk,
      requiredFailures: requiredFailures.length,
      message,
    })

    return NextResponse.json({ ok, env, health, message, flow: context })
  } catch (error) {
    logRouteError('unhandled', error)
    return jsonErrorResponse(error, 'Failed to run storage diagnostics')
  }
}

import { NextResponse } from 'next/server'
import { blobHealth, getBlobEnvironment, primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { dbHealth } from '@/lib/data'
import { areSummaryEmailsEnabled } from '@/lib/email'
import { resolveDefaultNotifyEmailServer } from '@/lib/default-notify-email.server'

type DiagnosticLevel = 'log' | 'error'

type DiagnosticPayload = Record<string, unknown>

function timestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    deployId: process.env.DEPLOY_ID ?? null,
    netlifyDeployId: process.env.NETLIFY_DEPLOY_ID ?? null,
    myDeployId: process.env.MY_DEPLOY_ID ?? null,
    supabaseUrl: process.env.SUPABASE_URL ? 'set' : 'missing',
    supabaseBucket: process.env.SUPABASE_STORAGE_BUCKET ?? null,
    supabaseKeyLength: process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0,
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
    hasResend: Boolean(process.env.RESEND_API_KEY),
    nodeEnv: process.env.NODE_ENV ?? null,
  }
}

function logDiagnostic(level: DiagnosticLevel, step: string, payload: DiagnosticPayload = {}) {
  const entry = { ...payload, envSummary: envSummary() }
  const message = `[diagnostic] ${timestamp()} health:${step}`
  if (level === 'error') {
    console.error(message, entry)
  } else {
    console.log(message, entry)
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
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

export async function GET(request: Request) {
  logDiagnostic('log', 'request:start', {
    method: request.method,
    url: request.url,
  })

  logDiagnostic('log', 'deploy-env:probe', {
    deployId: process.env.DEPLOY_ID ?? null,
    netlifyDeployId: process.env.NETLIFY_DEPLOY_ID ?? null,
    myDeployId: process.env.MY_DEPLOY_ID ?? null,
  })

  try {
    const contextPrimed = primeNetlifyBlobContextFromHeaders(request.headers)
    logDiagnostic('log', 'context:prime:complete', {
      contextPrimed,
    })

    const blob = await blobHealth()
    logDiagnostic('log', 'blob-health:complete', { blob })

    const db = await dbHealth()
    logDiagnostic('log', 'db-health:complete', { db })

    const storageEnv = getBlobEnvironment()
    logDiagnostic('log', 'storage-env:resolved', {
      provider: storageEnv.provider,
      configured: storageEnv.configured,
      store: (storageEnv as any).store ?? null,
      siteId: (storageEnv as any).siteId ?? null,
    })

    const defaultEmail = resolveDefaultNotifyEmailServer()

    const env = {
      hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
      hasBlobStore: storageEnv.configured,
      storageProvider: storageEnv.provider,
      storageStore: (storageEnv as any).store ?? null,
      storageSiteId: (storageEnv as any).siteId ?? null,
      storageError: (storageEnv as any).error ?? null,
      hasResend: Boolean(process.env.RESEND_API_KEY),
      emailsEnabled: areSummaryEmailsEnabled(),
      defaultEmail,
      blobDiagnostics: (storageEnv as any).diagnostics,
    }

    logDiagnostic('log', 'response:success', { blob, db, env })

    return NextResponse.json({ ok: true, env, blob, db })
  } catch (error) {
    const serialized = serializeError(error)
    logDiagnostic('error', 'response:error', {
      error: serialized,
    })

    return NextResponse.json(
      {
        ok: false,
        message: serialized.message ?? 'Health check failed',
        error: serialized,
      },
      { status: 500 },
    )
  }
}

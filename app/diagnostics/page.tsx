'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DeploymentMetadata } from '@/types/deployment'
import { DebugPanel } from '../debug/debug-panel'

type TestKey =
  | 'health'
  | 'session'
  | 'storage'
  | 'google'
  | 'openai'
  | 'smoke'
  | 'turn'
  | 'e2e'
  | 'email'
type TestResult = { status: 'idle' | 'pending' | 'ok' | 'error'; message?: string }
type FoxRecord = {
  id: string
  theory: number
  level: 'info' | 'warn' | 'error'
  message: string
  details?: Record<string, unknown>
  count: number
  firstTriggeredAt: string
  lastTriggeredAt: string
}

type TranscriptSynopsis = {
  text: string
  turn: number
  at: string
  isEmpty: boolean
  reason?: string
  meta?: {
    started?: boolean
    manualStop?: boolean
    stopReason?: string
  }
  provider?: string | null
}

type ProviderErrorSynopsis = {
  status: number | null
  message: string
  reason?: string
  snippet?: string
  at: string
  resolved?: boolean
  resolvedAt?: string
}

type DeploymentSnapshot = {
  origin?: string
  host?: string
  href?: string
  pathname?: string
  releaseId?: string
  deployId?: string
  deployContext?: string
  deployUrl?: string
  deployPrimeUrl?: string
  siteUrl?: string
  netlifySiteUrl?: string
  branch?: string
}

type BlobFlowStep = {
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
  hint?: string
  error?: string
  responseSnippet?: string
}

type RemediationOutcome = 'ok' | 'warn' | 'error'
type RemediationStep = {
  label: string
  outcome: RemediationOutcome
  detail?: string
  suggestion?: string
}

type BlobFlowDiagnostics = {
  ok: boolean
  probeId?: string
  startedAt?: string
  origin?: string
  sdkPath?: string
  sdkUrl?: string
  sitePutPath?: string
  directApiPath?: string
  steps: BlobFlowStep[]
}

declare global {
  interface Window {
    __DEPLOYMENT_METADATA__?: DeploymentMetadata
  }
}

type EnvDumpEntry = {
  key: string
  value: string | null
  severity: 'ok' | 'warn' | 'error' | 'info'
  message: string | null
}

type EnvDumpSummary = {
  total: number
  errors: number
  warnings: number
}

type HypothesisResult = {
  id: string
  category: 'openai' | 'supabase'
  label: string
  status: 'ok' | 'warn' | 'error' | 'info'
  detail: string
  suggestion?: string
  evidence?: Record<string, unknown>
}

type HypothesisSummary = {
  total: number
  ok: number
  warn: number
  error: number
}

function sortEnvEntries(entries: EnvDumpEntry[]): EnvDumpEntry[] {
  const rank: Record<EnvDumpEntry['severity'], number> = { error: 0, warn: 1, ok: 2, info: 3 }
  return [...entries].sort((a, b) => {
    if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity]
    return a.key.localeCompare(b.key)
  })
}

const diagnosticsTimestamp = () => new Date().toISOString()

function readClientEnvSummary(additional?: Record<string, unknown>) {
  const browserSummary = typeof window !== 'undefined'
    ? {
        origin: window.location.origin,
        pathname: window.location.pathname,
      }
    : {
        origin: null,
        pathname: null,
      }

  const deployment: DeploymentMetadata | null =
    typeof window !== 'undefined' && window.__DEPLOYMENT_METADATA__
      ? window.__DEPLOYMENT_METADATA__
      : null

  return {
    timestamp: diagnosticsTimestamp(),
    deployId: deployment?.deployId ?? null,
    deployContext: deployment?.context ?? null,
    deployUrl: deployment?.deployUrl ?? null,
    deployPrimeUrl: deployment?.deployPrimeUrl ?? null,
    siteUrl: deployment?.siteUrl ?? null,
    netlifySiteUrl: deployment?.siteUrl ?? null,
    branch: deployment?.branch ?? null,
    ...browserSummary,
    ...(additional ?? {}),
  }
}

function logClientDiagnostics(
  level: 'log' | 'error',
  step: string,
  payload?: Record<string, unknown>,
) {
  const envSummary = readClientEnvSummary(payload?.envSummary as Record<string, unknown> | undefined)
  const merged = { ...payload, envSummary }
  if (level === 'error') {
    console.error('[diagnostic]', diagnosticsTimestamp(), step, merged)
  } else {
    console.log('[diagnostic]', diagnosticsTimestamp(), step, merged)
  }
}

const TRANSCRIPT_STORAGE_KEY = 'diagnostics:lastTranscript'
const PROVIDER_ERROR_STORAGE_KEY = 'diagnostics:lastProviderError'

const TEST_CONFIG: Record<TestKey, { label: string; path: string; method: 'GET' | 'POST' }> = {
  health: { label: 'Health check', path: '/api/health', method: 'GET' },
  session: { label: 'Session + turns table drill', path: '/api/diagnostics/session', method: 'POST' },
  storage: { label: 'Storage check', path: '/api/diagnostics/storage', method: 'GET' },
  google: { label: 'Google AI API check', path: '/api/diagnostics/google', method: 'GET' },
  openai: { label: 'OpenAI API check', path: '/api/diagnostics/openai', method: 'GET' },
  smoke: { label: 'Smoke test', path: '/api/diagnostics/smoke', method: 'POST' },
  turn: { label: 'Turn sequence drill', path: '/api/diagnostics/turn-sequence', method: 'POST' },
  e2e: { label: 'End-to-end test', path: '/api/diagnostics/e2e', method: 'POST' },
  email: { label: 'Email test', path: '/api/diagnostics/email', method: 'POST' },
}

const TEST_ORDER: TestKey[] = [
  'health',
  'session',
  'storage',
  'google',
  'openai',
  'smoke',
  'turn',
  'e2e',
  'email',
]

function initialResults(): Record<TestKey, TestResult> {
  return {
    health: { status: 'idle' },
    session: { status: 'idle' },
    storage: { status: 'idle' },
    google: { status: 'idle' },
    openai: { status: 'idle' },
    smoke: { status: 'idle' },
    turn: { status: 'idle' },
    e2e: { status: 'idle' },
    email: { status: 'idle' },
  }
}

function describeBlobDetails(raw: any): string[] {
  if (!raw || typeof raw !== 'object') return []
  const details = raw as Record<string, any>
  const parts: string[] = []

  if (typeof details.action === 'string' && details.action.length) {
    parts.push(`action ${details.action}`)
  }
  if (typeof details.target === 'string' && details.target.length) {
    parts.push(`target ${details.target}`)
  }
  if (typeof details.store === 'string' && details.store.length) {
    parts.push(`store ${details.store}`)
  }
  if (typeof details.siteSlug === 'string' && details.siteSlug.length) {
    parts.push(`site ${details.siteSlug}`)
  } else if (typeof details.siteName === 'string' && details.siteName.length) {
    parts.push(`site ${details.siteName}`)
  } else if (typeof details.siteId === 'string' && details.siteId.length) {
    parts.push(`site ${details.siteId}`)
  }
  if (typeof details.tokenSource === 'string' && details.tokenSource.length) {
    parts.push(`token from ${details.tokenSource}`)
  }
  if (typeof details.tokenLength === 'number' && Number.isFinite(details.tokenLength)) {
    parts.push(`token length ${details.tokenLength}`)
  }
  if (Array.isArray(details.missing) && details.missing.length) {
    const missingLabels = details.missing
      .filter(
        (item: unknown): item is string => typeof item === 'string' && item.length > 0,
      )
      .join(', ')
    if (missingLabels.length) {
      parts.push(`missing ${missingLabels}`)
    }
  }
  if (typeof details.usingContext === 'boolean') {
    parts.push(details.usingContext ? 'context payload detected' : 'context payload missing')
  }
  if (Array.isArray(details.contextKeys) && details.contextKeys.length) {
    const contextKeys = details.contextKeys
      .filter(
        (item: unknown): item is string => typeof item === 'string' && item.length > 0,
      )
      .slice(0, 4)
    if (contextKeys.length) {
      parts.push(`context keys ${contextKeys.join(', ')}`)
    }
  }
  if (typeof details.status === 'number' && Number.isFinite(details.status)) {
    parts.push(`status ${details.status}`)
  }
  if (typeof details.code === 'string' && details.code.length) {
    parts.push(`code ${details.code}`)
  }
  if (typeof details.requestId === 'string' && details.requestId.length) {
    parts.push(`request ${details.requestId}`)
  }
  if (typeof details.responseBodySnippet === 'string' && details.responseBodySnippet.length) {
    parts.push(`body: ${details.responseBodySnippet}`)
  }
  if (typeof details.originalMessage === 'string' && details.originalMessage.length) {
    parts.push(`origin: ${details.originalMessage}`)
  }

  return parts
}

function readDeploymentSnapshot(): DeploymentSnapshot | null {
  if (typeof window === 'undefined') return null

  const snapshot: DeploymentSnapshot = {}
  const { location } = window

  if (location) {
    if (typeof location.origin === 'string' && location.origin.length) {
      snapshot.origin = location.origin
    }
    if (typeof location.host === 'string' && location.host.length) {
      snapshot.host = location.host
    }
    if (typeof location.href === 'string' && location.href.length) {
      snapshot.href = location.href
    }
    if (typeof location.pathname === 'string' && location.pathname.length) {
      snapshot.pathname = location.pathname
    }
  }

  const nextData = (window as any).__NEXT_DATA__
  if (nextData && typeof nextData === 'object') {
    if (typeof nextData.buildId === 'string' && nextData.buildId.length) {
      snapshot.releaseId = nextData.buildId
    }
  }

  const deploymentMetadata = window.__DEPLOYMENT_METADATA__
  if (deploymentMetadata) {
    if (typeof deploymentMetadata.deployId === 'string' && deploymentMetadata.deployId.length) {
      snapshot.deployId = deploymentMetadata.deployId
    }
    if (typeof deploymentMetadata.context === 'string' && deploymentMetadata.context.length) {
      snapshot.deployContext = deploymentMetadata.context
    }
    if (typeof deploymentMetadata.deployUrl === 'string' && deploymentMetadata.deployUrl.length) {
      snapshot.deployUrl = deploymentMetadata.deployUrl
    }
    if (typeof deploymentMetadata.deployPrimeUrl === 'string' && deploymentMetadata.deployPrimeUrl.length) {
      snapshot.deployPrimeUrl = deploymentMetadata.deployPrimeUrl
    }
    if (typeof deploymentMetadata.siteUrl === 'string' && deploymentMetadata.siteUrl.length) {
      snapshot.siteUrl = deploymentMetadata.siteUrl
      snapshot.netlifySiteUrl = deploymentMetadata.siteUrl
    }
    if (typeof deploymentMetadata.branch === 'string' && deploymentMetadata.branch.length) {
      snapshot.branch = deploymentMetadata.branch
    }
  }

  return snapshot
}

function summarizeNetlifyDiagnostics(raw: any, deployment?: DeploymentSnapshot | null): string[] {
  if (!raw || typeof raw !== 'object') return []
  const summary: string[] = []

  const tokenPresent = raw?.token?.present === true
  const tokenMissing = Array.isArray(raw?.missing) && raw.missing.includes('token')
  const tokenKeyCandidate = raw?.token?.selected?.key
  const tokenSource =
    typeof tokenKeyCandidate === 'string' && tokenKeyCandidate.length ? tokenKeyCandidate : undefined
  const tokenLabel = tokenPresent
    ? `present${tokenSource ? ` from ${tokenSource}` : ''}`
    : raw?.token?.present === false && tokenMissing
    ? 'missing'
    : 'unknown'
  const tokenLabelWithContext =
    !tokenPresent && !tokenMissing
      ? raw?.usingContext
        ? 'not provided (Netlify context detected)'
        : 'not provided'
      : tokenLabel

  const storePreviewCandidate = raw?.store?.selected?.valuePreview ?? raw?.store?.selected?.value
  const storePreview =
    typeof storePreviewCandidate === 'string' && storePreviewCandidate.length
      ? storePreviewCandidate
      : undefined
  const storeDefaulted = raw?.store?.defaulted === true
  const storeLabel = storePreview
    ? `${storePreview}${storeDefaulted ? ' (defaulted)' : ''}`
    : storeDefaulted
    ? 'defaulted (value unknown)'
    : 'unresolved'

  const sitePreviewCandidate = raw?.siteId?.selected?.valuePreview ?? raw?.siteId?.selected?.value
  const sitePreview =
    typeof sitePreviewCandidate === 'string' && sitePreviewCandidate.length
      ? sitePreviewCandidate
      : undefined
  const sitePresent = raw?.siteId?.present === true
  const siteLabel = sitePresent
    ? `${sitePreview || 'value provided'}${raw?.siteId?.defaulted ? ' (defaulted)' : ''}`
    : raw?.siteId?.present === false
    ? 'missing'
    : 'unknown'

  const overrides: string[] = []
  const warnings: string[] = []
  const edgeUrlCandidate = raw?.optional?.edgeUrl?.selected?.valuePreview
  const apiUrlCandidate = raw?.optional?.apiUrl?.selected?.valuePreview
  const uncachedEdgeUrlCandidate = raw?.optional?.uncachedEdgeUrl?.selected?.valuePreview
  const edgeUrl = typeof edgeUrlCandidate === 'string' && edgeUrlCandidate.length ? edgeUrlCandidate : undefined
  const apiUrl = typeof apiUrlCandidate === 'string' && apiUrlCandidate.length ? apiUrlCandidate : undefined
  const uncachedEdgeUrl =
    typeof uncachedEdgeUrlCandidate === 'string' && uncachedEdgeUrlCandidate.length
      ? uncachedEdgeUrlCandidate
      : undefined

  if (edgeUrl) overrides.push(`edge=${edgeUrl}`)
  if (uncachedEdgeUrl) overrides.push(`uncached_edge=${uncachedEdgeUrl}`)
  if (apiUrl) overrides.push(`api=${apiUrl}`)

  if (edgeUrl && /^https?:\/\/netlify-blobs\.netlify\.app/i.test(edgeUrl)) {
    warnings.push('Edge override points at netlify-blobs.netlify.app; remove or switch to the API host for writes')
  }
  if (edgeUrl && !apiUrl) {
    warnings.push('Edge override is set without NETLIFY_BLOBS_API_URL; uploads will target the edge host')
  }

  summary.push(`Store: ${storeLabel}`)
  summary.push(`Token: ${tokenLabelWithContext}`)
  summary.push(`Site ID: ${siteLabel}`)
  summary.push(`Overrides: ${overrides.length ? overrides.join(' · ') : 'none set'}`)
  if (warnings.length) {
    summary.push(`Warnings: ${warnings.join(' · ')}`)
  }

  if (deployment) {
    const originLabel = deployment.origin || deployment.host
    if (originLabel) {
      summary.push(`Deployment origin: ${originLabel}`)
    }
    if (deployment.href) {
      summary.push(`Deployment URL: ${deployment.href}`)
    }
    if (deployment.pathname) {
      summary.push(`Deployment path: ${deployment.pathname}`)
    }
    if (deployment.deployContext) {
      summary.push(`Runtime context: ${deployment.deployContext}`)
    }
    if (deployment.branch) {
      summary.push(`Branch: ${deployment.branch}`)
    }
    if (deployment.deployUrl) {
      summary.push(`Deploy URL: ${deployment.deployUrl}`)
    }
    if (deployment.deployPrimeUrl) {
      summary.push(`Preview URL: ${deployment.deployPrimeUrl}`)
    }
    if (deployment.netlifySiteUrl) {
      summary.push(`Netlify site URL: ${deployment.netlifySiteUrl}`)
    }
    if (deployment.siteUrl && deployment.siteUrl !== deployment.netlifySiteUrl) {
      summary.push(`Site URL: ${deployment.siteUrl}`)
    }
    if (deployment.deployId) {
      summary.push(`Deploy ID: ${deployment.deployId}`)
    }
    if (deployment.releaseId) {
      summary.push(`Build ID: ${deployment.releaseId}`)
    }
  }

  return summary
}

function formatSummary(key: TestKey, data: any): string {
  if (!data || typeof data !== 'object') return ''

  if (key === 'health') {
    const env = data.env || {}
    const blob = data.blob || {}
    const db = data.db || {}
    const storageLabel = env.hasBlobStore
      ? env.storageStore
        ? `${env.storageProvider || 'netlify'} (${env.storageStore})`
        : env.storageProvider || 'configured'
      : env.storageProvider === 'memory'
      ? 'memory fallback'
      : env.storageProvider || 'unconfigured'
    const parts = [
      `OpenAI: ${env.hasOpenAI ? 'yes' : 'no'}`,
      `Storage: ${storageLabel}`,
      `Resend: ${env.hasResend ? 'yes' : 'no'}`,
    ]
    if (blob) parts.push(`Storage health: ${blob.ok ? 'ok' : blob.reason || 'error'}`)
    if (db) parts.push(`DB: ${db.ok ? db.mode || 'ok' : db.reason || 'error'}`)
    if (env?.blobDiagnostics) {
      const missing = Array.isArray(env.blobDiagnostics.missing)
        ? env.blobDiagnostics.missing.filter((item: string) => typeof item === 'string')
        : []
      const contextLabel = env.blobDiagnostics.usingContext ? 'context detected' : 'no context payload'
      parts.push(`Blob env: ${missing.length ? `missing ${missing.join(', ')}` : 'complete'} · ${contextLabel}`)
    }
    return parts.join(' · ')
  }

  if (key === 'session') {
    const steps: BlobFlowStep[] = Array.isArray(data?.steps) ? data.steps : []
    const failing = steps.find((step) => step.ok === false)
    const stepSummary = steps.length
      ? steps
          .map((step) => {
            const status = typeof step.status === 'number' ? ` HTTP ${step.status}` : ''
            return `${step.ok ? '✅' : '❌'} ${step.label || step.id || 'step'}${status}`
          })
          .join(' · ')
      : null

    if (failing) {
      const hint = failing.hint ? ` Hint: ${failing.hint}` : ''
      return `Session drill failed at ${failing.label || failing.id}: ${failing.detail || 'unknown error'}.${hint}`
    }

    const message = typeof data?.message === 'string' ? data.message : null
    const tableLabel = data?.table ? `Table ${data.table}` : 'table unknown'
    const sessionLabel = data?.sessionId ? `Session ${data.sessionId}` : 'session id unknown'

    if (stepSummary) {
      return `${message || 'Session drill executed.'} · ${tableLabel} · ${sessionLabel} · Steps: ${stepSummary}`
    }

    return `${message || 'Session drill executed.'} · ${tableLabel} · ${sessionLabel}`
  }

  if (key === 'storage') {
    const diagnostics = data?.env?.diagnostics
    const detailParts: string[] = []
    if (diagnostics) {
      const tokenSource = diagnostics.token?.selected?.key
      const tokenMissing = Array.isArray(diagnostics.missing) && diagnostics.missing.includes('token')
      const tokenStatus = diagnostics.token?.present
        ? `token present (${tokenSource || 'source unknown'})`
        : tokenMissing
        ? 'token missing'
        : diagnostics.usingContext
        ? 'token not provided (Netlify context detected)'
        : 'token not provided'
      detailParts.push(tokenStatus)
      const siteSource = diagnostics.siteId?.selected?.key
      const siteStatus = diagnostics.siteId?.present
        ? `site ID present (${siteSource || 'source unknown'})`
        : 'site ID missing'
      detailParts.push(siteStatus)
      const storeStatus = diagnostics.store?.selected?.valuePreview
        ? `store ${diagnostics.store.selected.valuePreview}${diagnostics.store.defaulted ? ' (defaulted)' : ''}`
        : 'store unresolved'
      detailParts.push(storeStatus)
      if (
        diagnostics.optional?.edgeUrl?.present ||
        diagnostics.optional?.apiUrl?.present ||
        diagnostics.optional?.uncachedEdgeUrl?.present
      ) {
        const edge = diagnostics.optional?.edgeUrl?.selected?.valuePreview
        const api = diagnostics.optional?.apiUrl?.selected?.valuePreview
        const uncached = diagnostics.optional?.uncachedEdgeUrl?.selected?.valuePreview
        if (edge) detailParts.push(`edge URL set (${edge})`)
        if (api) detailParts.push(`API URL set (${api})`)
        if (uncached) detailParts.push(`uncached edge URL set (${uncached})`)
      }
      if (Array.isArray(diagnostics.missing) && diagnostics.missing.length) {
        detailParts.push(`missing: ${diagnostics.missing.join(', ')}`)
      }
    }
    const flow: BlobFlowDiagnostics | undefined = Array.isArray(data?.flow?.steps)
      ? (data.flow as BlobFlowDiagnostics)
      : undefined
    if (flow && Array.isArray(flow.steps) && flow.steps.length) {
      const stepSummary = flow.steps.map(step => {
        const status = typeof step.status === 'number' ? ` ${step.status}` : ''
        const method = step.method ? `${step.method} ` : ''
        const flag = step.skipped ? '⏭️' : step.ok ? '✅' : '❌'
        return `${flag} ${method}${step.id || step.label || 'step'}${status}`
      })
      detailParts.push(`flow: ${stepSummary.join(' · ')}`)
      if (!flow.ok) {
        const failingStep = flow.steps.find(step => !step.ok && !step.optional && !step.skipped)
        if (failingStep) {
          const label = failingStep.label || failingStep.id || 'unknown step'
          const status = typeof failingStep.status === 'number' ? ` (HTTP ${failingStep.status})` : ''
          detailParts.push(`flow failure: ${label}${status}`)
        }
      }
    }
    const healthDetails = data?.health?.details
    if (healthDetails) {
      const detailSnippets = describeBlobDetails(healthDetails)
      if (detailSnippets.length) {
        detailParts.push(...detailSnippets.map(snippet => `health ${snippet}`))
      }
    }
    if (typeof data?.message === 'string') {
      return detailParts.length ? `${data.message} · ${detailParts.join(' · ')}` : data.message
    }
    if (data?.env?.provider === 'netlify' && data?.ok) {
      return detailParts.length
        ? `Netlify blob storage ready · ${detailParts.join(' · ')}`
        : 'Netlify blob storage ready.'
    }
    if (data?.env?.provider === 'memory') {
      return detailParts.length
        ? `Using in-memory storage fallback · ${detailParts.join(' · ')}`
        : 'Using in-memory storage fallback.'
    }
    if (data?.health?.reason) return `Error: ${data.health.reason}`
    return data?.ok ? 'Storage check passed' : 'Storage check failed'
  }

  if (key === 'google') {
    if (data.ok) {
      const model = data.model || {}
      const replyText = typeof data.reply === 'string' ? data.reply.trim() : ''
      const replySnippet = replyText.length > 60 ? `${replyText.slice(0, 57)}…` : replyText
      const reply = replySnippet ? ` · Reply: ${replySnippet}` : ''
      return `Model: ${model.name || model.id || 'unknown'}${reply}`
    }
    if (data.error) return `Error: ${data.error}`
    if (data.status && data.message) return `HTTP ${data.status}: ${data.message}`
  }

  if (key === 'openai') {
    if (data.ok) {
      const modelId = data.model?.id || data.model || 'unknown model'
      const replyText = typeof data.reply === 'string' ? data.reply.trim() : ''
      const replySnippet = replyText.length > 60 ? `${replyText.slice(0, 57)}…` : replyText
      const reply = replySnippet ? ` · Reply: ${replySnippet}` : ''
      return `Model: ${modelId}${reply}`
    }
    if (data.error) return `Error: ${data.error}`
    if (data.status && data.message) return `HTTP ${data.status}: ${data.message}`
  }

  if (key === 'email') {
    const status = data.status || {}
    if (status.ok) return `Email sent via ${status.provider || 'configured provider'}`
    if (status.skipped) return 'Email skipped (no provider configured)'
  }

  if (key === 'smoke') {
    if (data.ok) return 'Session created and finalized'
    const detailParts: string[] = []
    if (data.stage) detailParts.push(`stage ${data.stage}`)
    if (data.cause) detailParts.push(`cause: ${data.cause}`)
    const blobDetails = data.details || data.blobDetails
    if (blobDetails) {
      detailParts.push(...describeBlobDetails(blobDetails))
    }
    return detailParts.length
      ? `${data.error || 'Smoke test failed'} · ${detailParts.join(' · ')}`
      : data.error || 'Smoke test failed'
  }
  if (key === 'e2e') {
    if (data.ok) return 'Session completed end-to-end'
    const detailParts: string[] = []
    if (data.stage) detailParts.push(`stage ${data.stage}`)
    if (data.cause) detailParts.push(`cause: ${data.cause}`)
    const blobDetails = data.details || data.blobDetails
    if (blobDetails) {
      detailParts.push(...describeBlobDetails(blobDetails))
    }
    return detailParts.length
      ? `${data.error || 'E2E test failed'} · ${detailParts.join(' · ')}`
      : data.error || 'E2E test failed'
  }

  if (key === 'turn') {
    const steps = Array.isArray(data?.steps) ? data.steps : []
    const stepSummary = steps.length
      ? steps
          .map((step: any) => {
            const flag = step.ok ? '✅' : '❌'
            const statusLabel = typeof step.status === 'number' ? ` HTTP ${step.status}` : ''
            return `${flag} ${step.id || 'step'}${statusLabel}`
          })
          .join(' · ')
      : null
    const turnIdLabel = data?.turnId || data?.turn?.id
    if (data.ok && stepSummary) {
      return `${stepSummary}${turnIdLabel ? ` · turn ${turnIdLabel}` : ''}`
    }
    if (stepSummary) return stepSummary
    return data.error || 'Turn sequence failed'
  }

  if (data.error) return `Error: ${data.error}`
  return data.ok ? 'Passed' : 'Failed'
}

function buildStorageRemediation(data: any): RemediationStep[] {
  const steps: RemediationStep[] = []
  const envSnapshot = data?.env?.env || data?.env?.diagnostics || data?.env?.supabase
  const supabaseUrl: string | null =
    (envSnapshot?.SUPABASE_URL as string | null | undefined) ??
    (typeof envSnapshot?.supabaseUrl === 'string' ? envSnapshot.supabaseUrl : null)
  const serviceRolePresent = Boolean(
    envSnapshot?.SUPABASE_SERVICE_ROLE_KEY || envSnapshot?.supabaseServiceRoleKey,
  )
  const bucketName: string | null =
    (envSnapshot?.SUPABASE_STORAGE_BUCKET as string | null | undefined) ??
    (typeof envSnapshot?.supabaseBucket === 'string' ? envSnapshot.supabaseBucket : null)

  if (supabaseUrl && serviceRolePresent && bucketName) {
    steps.push({
      label: 'Env configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET)',
      outcome: 'ok',
      detail: `Bucket ${bucketName}`,
    })
  } else {
    const missing: string[] = []
    if (!supabaseUrl) missing.push('SUPABASE_URL')
    if (!serviceRolePresent) missing.push('SUPABASE_SERVICE_ROLE_KEY')
    if (!bucketName) missing.push('SUPABASE_STORAGE_BUCKET')
    steps.push({
      label: 'Env configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET)',
      outcome: 'error',
      detail: missing.length ? `Missing ${missing.join(', ')}` : 'Incomplete configuration',
      suggestion: 'Set all Supabase storage env vars and redeploy.',
    })
  }

  const healthOk = data?.health?.ok === true
  const healthReason: string | undefined = data?.health?.reason || data?.health?.error
  steps.push({
    label: 'Supabase bucket health check',
    outcome: healthOk ? 'ok' : 'error',
    detail: healthOk ? 'List probe succeeded' : healthReason || 'Health probe failed',
    suggestion: healthOk
      ? undefined
      : healthReason && healthReason.toLowerCase().includes('enotfound')
      ? 'Check that SUPABASE_URL host resolves and the project is active.'
      : 'Confirm Supabase project is up and keys are active.',
  })

  const flow: BlobFlowDiagnostics | undefined = Array.isArray(data?.flow?.steps)
    ? (data.flow as BlobFlowDiagnostics)
    : undefined
  if (flow && Array.isArray(flow.steps)) {
    flow.steps.forEach((step) => {
      const outcome: RemediationStep['outcome'] = step.ok
        ? 'ok'
        : step.optional || step.skipped
        ? 'warn'
        : 'error'
      const suggestion = step.ok
        ? undefined
        : step.error && step.error.toLowerCase().includes('fetch failed')
        ? 'Verify Supabase URL, bucket name, and that the service role key is enabled.'
        : step.status === 403
        ? 'Check bucket RLS policies and ensure service_role key is used.'
        : undefined
      steps.push({
        label: step.label || step.id,
        outcome,
        detail: [step.method, step.status ? `HTTP ${step.status}` : null, step.error || step.responseSnippet]
          .filter(Boolean)
          .join(' · '),
        suggestion,
      })
    })
  }

  return steps
}

function buildDefaultRemediation(
  key: TestKey,
  ok: boolean,
  status: number | null,
  message?: string,
): RemediationStep[] {
  const suggestions: Partial<Record<TestKey, string>> = {
    openai: 'Verify OPENAI_API_KEY and model env vars; check provider status.',
    google: 'Verify GOOGLE_API_KEY/GOOGLE_MODEL and confirm access is enabled.',
    email: 'Check SENDGRID_API_KEY or RESEND_API_KEY and DEFAULT_NOTIFY_EMAIL.',
    smoke: 'Inspect server logs; ensure dependent services are reachable.',
    session: 'Confirm Supabase URL/service key and SUPABASE_TURNS_TABLE are correct; run session drill again.',
    turn: 'Confirm /api/save-turn prerequisites (Supabase URL, service role key, turns table, and blob config).',
    e2e: 'Run storage and provider checks; fix failures above first.',
    health: 'Review storage/db details in the health payload.',
    storage: 'Inspect Supabase URL, service role key, bucket name, and RLS policies.',
  }

  return [
    {
      label: `${TEST_CONFIG[key].label} response`,
      outcome: ok ? 'ok' : 'error',
      detail: status ? `HTTP ${status}${message ? ` — ${message}` : ''}` : message,
      suggestion: ok ? undefined : suggestions[key],
    },
  ]
}

export default function DiagnosticsPage() {
  const [latestTranscript, setLatestTranscript] = useState<TranscriptSynopsis | null>(null)
  const [latestProviderError, setLatestProviderError] = useState<ProviderErrorSynopsis | null>(null)
  const [envDump, setEnvDump] = useState<EnvDumpEntry[] | null>(null)
  const [envSummary, setEnvSummary] = useState<EnvDumpSummary | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const [envStatusNote, setEnvStatusNote] = useState<string | null>(null)
  const [envCopyStatus, setEnvCopyStatus] = useState<string | null>(null)
  const [hypothesisResults, setHypothesisResults] = useState<HypothesisResult[] | null>(null)
  const [hypothesisSummary, setHypothesisSummary] = useState<HypothesisSummary | null>(null)
  const [hypothesisError, setHypothesisError] = useState<string | null>(null)
  const [hypothesisStatus, setHypothesisStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [log, setLog] = useState<string>('Ready. Run diagnostics to gather fresh results.')
  const [results, setResults] = useState<Record<TestKey, TestResult>>(() => initialResults())
  const [remediationPlans, setRemediationPlans] = useState<Partial<Record<TestKey, RemediationStep[]>>>({})
  const [isRunning, setIsRunning] = useState(false)
  const [foxes, setFoxes] = useState<FoxRecord[]>([])

  const envCopyText = useMemo(() => {
    if (!envDump || envDump.length === 0) return ''
    return envDump
      .map(
        (entry) =>
          `${entry.key},${entry.severity.toUpperCase()},${entry.value ?? '(undefined)'},${entry.message ?? '—'}`,
      )
      .join('\n')
  }, [envDump])

  const envCopyRows = useMemo(() => {
    if (!envDump || envDump.length === 0) return 20
    return Math.max(envDump.length + 4, 20)
  }, [envDump])

  const hypothesisIcon = useMemo(
    () => ({ ok: '✅', warn: '⚠️', error: '❌', info: 'ℹ️' } as const),
    [],
  )

  const sortedHypotheses = useMemo(() => {
    if (!hypothesisResults) return []
    return [...hypothesisResults].sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category)
      if (a.status !== b.status) return a.status.localeCompare(b.status)
      return a.label.localeCompare(b.label)
    })
  }, [hypothesisResults])

  const handleCopyEnv = useCallback(async () => {
    if (!envDump || envDump.length === 0) {
      setEnvCopyStatus('No environment variables to copy yet.')
      logClientDiagnostics('error', 'diagnostics:env-dump:copy:empty', {
        envSummary: { total: envDump?.length || 0 },
      })
      return
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      const fallbackMessage = 'Clipboard access is unavailable in this browser context.'
      setEnvCopyStatus(fallbackMessage)
      logClientDiagnostics('error', 'diagnostics:env-dump:copy:unsupported', {
        envSummary: { total: envDump.length },
        detail: fallbackMessage,
      })
      return
    }
    try {
      await navigator.clipboard.writeText(envCopyText)
      setEnvCopyStatus('Copied all environment variables to the clipboard.')
      logClientDiagnostics('log', 'diagnostics:env-dump:copy:success', {
        envSummary: { total: envDump.length },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown copy error'
      setEnvCopyStatus(`Copy failed: ${message}`)
      logClientDiagnostics('error', 'diagnostics:env-dump:copy:error', {
        envSummary: { total: envDump.length },
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: 'Unknown error', value: error },
      })
    }
  }, [envCopyText, envDump])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = '/api/diagnostics/hypotheses'
    setHypothesisStatus('loading')

    logClientDiagnostics('log', 'diagnostics:hypotheses:fetch:start', {
      request: { url, method: 'GET', accept: 'application/json' },
    })

    async function loadHypotheses() {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        const payload = await response.json()

        const isValid =
          payload && typeof payload === 'object' && Array.isArray((payload as any).results) && typeof (payload as any).summary === 'object'

        if (!isValid) {
          throw new Error('Malformed hypotheses diagnostics payload')
        }

        const normalizedResults: HypothesisResult[] = (payload as any).results.map((item: any) => {
          const statusCandidates = ['ok', 'warn', 'error', 'info']
          const status =
            typeof item?.status === 'string' && statusCandidates.includes(item.status.toLowerCase())
              ? (item.status.toLowerCase() as HypothesisResult['status'])
              : 'info'
          return {
            id: typeof item?.id === 'string' && item.id.length ? item.id : crypto.randomUUID(),
            category: item?.category === 'supabase' ? 'supabase' : 'openai',
            label: typeof item?.label === 'string' ? item.label : 'Unlabeled hypothesis',
            status,
            detail: typeof item?.detail === 'string' ? item.detail : 'No detail provided.',
            suggestion: typeof item?.suggestion === 'string' ? item.suggestion : undefined,
            evidence: item?.evidence && typeof item.evidence === 'object' ? item.evidence : undefined,
          }
        })

        const summaryRaw = (payload as any).summary
        const normalizedSummary: HypothesisSummary = {
          total:
            typeof summaryRaw?.total === 'number' && Number.isFinite(summaryRaw.total)
              ? summaryRaw.total
              : normalizedResults.length,
          ok: typeof summaryRaw?.ok === 'number' && Number.isFinite(summaryRaw.ok) ? summaryRaw.ok : 0,
          warn: typeof summaryRaw?.warn === 'number' && Number.isFinite(summaryRaw.warn) ? summaryRaw.warn : 0,
          error: typeof summaryRaw?.error === 'number' && Number.isFinite(summaryRaw.error) ? summaryRaw.error : 0,
        }

        setHypothesisResults(normalizedResults)
        setHypothesisSummary(normalizedSummary)
        setHypothesisError(response.ok ? null : (payload as any)?.message ?? `HTTP ${response.status}`)
        setHypothesisStatus(response.ok ? 'idle' : 'error')

        logClientDiagnostics('log', 'diagnostics:hypotheses:fetch:success', {
          response: { status: response.status },
          summary: normalizedSummary,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        setHypothesisResults(null)
        setHypothesisSummary(null)
        setHypothesisError(message)
        setHypothesisStatus('error')
        logClientDiagnostics('error', 'diagnostics:hypotheses:fetch:error', {
          request: { url },
          error: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : { message: 'Unknown error', value: error },
        })
      }
    }

    void loadHypotheses()
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    let cancelled = false
    const url = '/api/diagnostics/env?format=json'

    logClientDiagnostics('log', 'diagnostics:env-dump:fetch:start', {
      request: { url, method: 'GET', accept: 'application/json' },
    })

    async function loadEnvDump() {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' } })
        const payload = await response.json()

        const payloadHasEnv = payload && typeof payload === 'object' && Array.isArray((payload as any).env)
        const responseDetail =
          payload && typeof payload === 'object' && typeof (payload as any).error === 'string'
            ? (payload as any).error
            : `HTTP ${response.status}`

        if (!payloadHasEnv) {
          throw new Error('Malformed environment diagnostics payload')
        }

        const entriesRaw = (payload as any).env as any[]
        const sanitizedEntries: EnvDumpEntry[] = entriesRaw.map((item) => {
          const rawKey = typeof item?.key === 'string' ? item.key : String(item?.key ?? '')
          const key = rawKey && rawKey.length ? rawKey : '(unnamed)'
          const rawValue = item?.value
          const value =
            rawValue === null || rawValue === undefined
              ? null
              : typeof rawValue === 'string'
              ? rawValue
              : String(rawValue)
          const rawSeverity = typeof item?.severity === 'string' ? item.severity.toLowerCase() : 'info'
          const severity: EnvDumpEntry['severity'] = ['ok', 'warn', 'error', 'info'].includes(rawSeverity)
            ? (rawSeverity as EnvDumpEntry['severity'])
            : 'info'
          const message =
            item?.message === null || item?.message === undefined
              ? null
              : typeof item.message === 'string'
              ? item.message
              : String(item.message)
          return { key, value, severity, message }
        })
        const sortedEntries = sortEnvEntries(sanitizedEntries)

        const summarySource = (payload as any).summary
        const summary: EnvDumpSummary | null =
          summarySource && typeof summarySource === 'object'
            ? {
                total: (() => {
                  if (typeof summarySource.total === 'number' && Number.isFinite(summarySource.total)) {
                    return summarySource.total
                  }
                  if (typeof summarySource.total === 'string') {
                    const parsed = Number(summarySource.total)
                    if (Number.isFinite(parsed)) return parsed
                  }
                  return sanitizedEntries.length
                })(),
                errors: (() => {
                  if (typeof summarySource.errors === 'number' && Number.isFinite(summarySource.errors)) {
                    return summarySource.errors
                  }
                  if (typeof summarySource.errors === 'string') {
                    const parsed = Number(summarySource.errors)
                    if (Number.isFinite(parsed)) return parsed
                  }
                  return 0
                })(),
                warnings: (() => {
                  if (
                    typeof summarySource.warnings === 'number' &&
                    Number.isFinite(summarySource.warnings)
                  ) {
                    return summarySource.warnings
                  }
                  if (typeof summarySource.warnings === 'string') {
                    const parsed = Number(summarySource.warnings)
                    if (Number.isFinite(parsed)) return parsed
                  }
                  return 0
                })(),
              }
            : {
                total: sanitizedEntries.length,
                errors: 0,
                warnings: 0,
              }

        if (!cancelled) {
          setEnvDump(sortedEntries)
          setEnvSummary(summary)
          setEnvError(null)
          setEnvStatusNote(
            !response.ok || (payload && typeof payload === 'object' && (payload as any).ok === false)
              ? `Environment diagnostics responded with ${response.status}: ${responseDetail}`
              : null,
          )
        }

        const severityCounts = sanitizedEntries.reduce(
          (acc, entry) => {
            acc.total += 1
            acc.bySeverity[entry.severity] = (acc.bySeverity[entry.severity] ?? 0) + 1
            return acc
          },
          { total: 0, bySeverity: { ok: 0, warn: 0, error: 0, info: 0 } as Record<EnvDumpEntry['severity'], number> },
        )

        const collectIssues = (keys: string[]) =>
          sanitizedEntries.filter(
            (entry) => keys.includes(entry.key) && (entry.severity === 'warn' || entry.severity === 'error'),
          )

        const hypothesisEvaluations = [
          {
            hypothesis: 'Required environment variables might be missing or using fallback placeholders.',
            confirmed: severityCounts.bySeverity.error > 0,
            evidence: sanitizedEntries
              .filter((entry) => entry.severity === 'error')
              .map((entry) => ({ key: entry.key, message: entry.message })),
          },
          {
            hypothesis: 'Blob storage credentials may not match the current Netlify site configuration.',
            confirmed: collectIssues([
              'NETLIFY_BLOBS_SITE_ID',
              'NETLIFY_BLOBS_STORE',
              'NETLIFY_BLOBS_TOKEN',
              'NETLIFY_BLOBS_API_URL',
              'NETLIFY_BLOBS_EDGE_URL',
              'NETLIFY_BLOBS_PUBLIC_BASE_URL',
            ]).length > 0,
            evidence: collectIssues([
              'NETLIFY_BLOBS_SITE_ID',
              'NETLIFY_BLOBS_STORE',
              'NETLIFY_BLOBS_TOKEN',
              'NETLIFY_BLOBS_API_URL',
              'NETLIFY_BLOBS_EDGE_URL',
              'NETLIFY_BLOBS_PUBLIC_BASE_URL',
            ]).map((entry) => ({ key: entry.key, severity: entry.severity, message: entry.message })),
          },
          {
            hypothesis: 'Email delivery could be disabled because provider API keys are absent.',
            confirmed: collectIssues([
              'DEFAULT_NOTIFY_EMAIL',
              'RESEND_API_KEY',
              'SENDGRID_API_KEY',
              'ENABLE_SESSION_EMAILS',
            ]).length > 0,
            evidence: collectIssues([
              'DEFAULT_NOTIFY_EMAIL',
              'RESEND_API_KEY',
              'SENDGRID_API_KEY',
              'ENABLE_SESSION_EMAILS',
            ]).map((entry) => ({ key: entry.key, severity: entry.severity, message: entry.message })),
          },
          {
            hypothesis: 'Google AI access may fail if the API key or model name is unset.',
            confirmed: collectIssues(['GOOGLE_API_KEY', 'GOOGLE_MODEL']).length > 0,
            evidence: collectIssues(['GOOGLE_API_KEY', 'GOOGLE_MODEL']).map((entry) => ({
              key: entry.key,
              severity: entry.severity,
              message: entry.message,
            })),
          },
        ]

        logClientDiagnostics('log', 'diagnostics:env-dump:fetch:success', {
          response: { status: response.status },
          summary,
          severityCounts,
          hypothesisEvaluations,
        })

        if (!response.ok || (payload && typeof payload === 'object' && (payload as any).ok === false)) {
          logClientDiagnostics('error', 'diagnostics:env-dump:fetch:non-ok', {
            response: { status: response.status },
            detail: responseDetail,
            envCount: sanitizedEntries.length,
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        logClientDiagnostics('error', 'diagnostics:env-dump:fetch:error', {
          request: { url },
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
          detail: message,
        })
        if (!cancelled) {
          setEnvError(message)
          setEnvDump([])
          setEnvSummary(null)
          setEnvStatusNote(null)
        }
      }
    }

    void loadEnvDump()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const read = () => {
      if (typeof window === 'undefined') {
        logClientDiagnostics('log', 'diagnostics:transcript:storage-read:skipped', {
          reason: 'window undefined',
        })
        return
      }

      try {
        logClientDiagnostics('log', 'diagnostics:transcript:storage-read:start', {
          storageKey: TRANSCRIPT_STORAGE_KEY,
        })
        const raw = window.localStorage.getItem(TRANSCRIPT_STORAGE_KEY)
        if (!raw) {
          setLatestTranscript(null)
          logClientDiagnostics('log', 'diagnostics:transcript:storage-read:empty', {
            storageKey: TRANSCRIPT_STORAGE_KEY,
          })
        } else {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== 'object') {
            setLatestTranscript(null)
            logClientDiagnostics('log', 'diagnostics:transcript:storage-read:invalid', {
              storageKey: TRANSCRIPT_STORAGE_KEY,
            })
          } else {
            const payload: TranscriptSynopsis = {
              text: typeof (parsed as any).text === 'string' ? (parsed as any).text : '',
              turn: typeof (parsed as any).turn === 'number' ? (parsed as any).turn : 0,
              at: typeof (parsed as any).at === 'string' ? (parsed as any).at : '',
              isEmpty: Boolean((parsed as any).isEmpty),
              reason: typeof (parsed as any).reason === 'string' ? (parsed as any).reason : undefined,
              meta:
                (parsed as any).meta && typeof (parsed as any).meta === 'object'
                  ? {
                      started:
                        typeof (parsed as any).meta.started === 'boolean'
                          ? (parsed as any).meta.started
                          : undefined,
                      manualStop:
                        typeof (parsed as any).meta.manualStop === 'boolean'
                          ? (parsed as any).meta.manualStop
                          : undefined,
                      stopReason:
                        typeof (parsed as any).meta.stopReason === 'string'
                          ? (parsed as any).meta.stopReason
                          : undefined,
                    }
                  : undefined,
              provider:
                typeof (parsed as any).provider === 'string'
                  ? (parsed as any).provider
                  : (parsed as any).provider === null
                  ? null
                  : undefined,
            }
            setLatestTranscript(payload)
            logClientDiagnostics('log', 'diagnostics:transcript:storage-read:success', {
              storageKey: TRANSCRIPT_STORAGE_KEY,
              transcript: {
                isEmpty: payload.isEmpty,
                turn: payload.turn,
                at: payload.at,
                provider: payload.provider,
              },
            })
          }
        }
      } catch (error) {
        logClientDiagnostics('error', 'diagnostics:transcript:storage-read:error', {
          storageKey: TRANSCRIPT_STORAGE_KEY,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: 'Unknown error', value: error },
        })
        setLatestTranscript(null)
      }

      try {
        logClientDiagnostics('log', 'diagnostics:provider-error:storage-read:start', {
          storageKey: PROVIDER_ERROR_STORAGE_KEY,
        })
        const rawError = window.localStorage.getItem(PROVIDER_ERROR_STORAGE_KEY)
        if (!rawError) {
          setLatestProviderError(null)
          logClientDiagnostics('log', 'diagnostics:provider-error:storage-read:empty', {
            storageKey: PROVIDER_ERROR_STORAGE_KEY,
          })
        } else {
          const parsedError = JSON.parse(rawError)
          if (!parsedError || typeof parsedError !== 'object') {
            setLatestProviderError(null)
            logClientDiagnostics('log', 'diagnostics:provider-error:storage-read:invalid', {
              storageKey: PROVIDER_ERROR_STORAGE_KEY,
            })
          } else {
            const rawStatus =
              typeof (parsedError as any).status === 'number'
                ? (parsedError as any).status
                : typeof (parsedError as any).status === 'string'
                ? Number.parseInt((parsedError as any).status, 10)
                : null
            const normalizedStatus =
              typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : null
            const snapshot: ProviderErrorSynopsis = {
              status: normalizedStatus,
              message: typeof (parsedError as any).message === 'string' ? (parsedError as any).message : 'Unknown error',
              reason: typeof (parsedError as any).reason === 'string' ? (parsedError as any).reason : undefined,
              snippet: typeof (parsedError as any).snippet === 'string' ? (parsedError as any).snippet : undefined,
              at: typeof (parsedError as any).at === 'string' ? (parsedError as any).at : '',
              resolved: (parsedError as any).resolved === true,
              resolvedAt:
                typeof (parsedError as any).resolvedAt === 'string' ? (parsedError as any).resolvedAt : undefined,
            }
            setLatestProviderError(snapshot)
            logClientDiagnostics('log', 'diagnostics:provider-error:storage-read:success', {
              storageKey: PROVIDER_ERROR_STORAGE_KEY,
              providerError: {
                status: snapshot.status,
                resolved: snapshot.resolved,
                at: snapshot.at,
              },
            })
          }
        }
      } catch (error) {
        logClientDiagnostics('error', 'diagnostics:provider-error:storage-read:error', {
          storageKey: PROVIDER_ERROR_STORAGE_KEY,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: 'Unknown error', value: error },
        })
        setLatestProviderError(null)
      }
    }
    const handleStorage = (event: StorageEvent) => {
      if (
        !event.key ||
        event.key === TRANSCRIPT_STORAGE_KEY ||
        event.key === PROVIDER_ERROR_STORAGE_KEY
      ) {
        read()
      }
    }
    const handleFocus = () => {
      if (typeof document !== 'undefined') {
        if (document.visibilityState && document.visibilityState !== 'visible') return
      }
      read()
    }
    read()
    window.addEventListener('storage', handleStorage)
    window.addEventListener('focus', handleFocus)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleFocus)
    }
    return () => {
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener('focus', handleFocus)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleFocus)
      }
    }
  }, [])

  const formatFlag = (value: boolean | undefined) =>
    value === true ? 'yes' : value === false ? 'no' : 'unknown'

  const append = (line: string) =>
    setLog((l) => (l && l.length > 0 ? l + '\n' + line : line))

  const statusIcon = useMemo(
    () => ({ idle: '•', pending: '…', ok: '✅', error: '❌' } as const),
    []
  )
  const remediationIcon = useMemo(
    () => ({ ok: '✅', warn: '⚠️', error: '❌' } as const),
    [],
  )

  const updateResult = (key: TestKey, patch: Partial<TestResult>) => {
    setResults(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }

  async function runDiagnostics() {
    if (isRunning) return
    setIsRunning(true)
    setLog('Running diagnostics...')
    setResults(initialResults())
    setFoxes([])
    setRemediationPlans({})

    const resultStatusLog: Record<TestKey, TestResult['status']> = Object.fromEntries(
      TEST_ORDER.map((key) => [key, 'idle' as TestResult['status']]),
    ) as Record<TestKey, TestResult['status']>

    logClientDiagnostics('log', 'diagnostics:run:start', {
      tests: TEST_ORDER.map((key) => ({ key, path: TEST_CONFIG[key].path, method: TEST_CONFIG[key].method })),
    })

    let transcriptSnapshot: TranscriptSynopsis | null = null
    let providerSnapshot: ProviderErrorSynopsis | null = null
    if (typeof window !== 'undefined') {
      try {
        const rawTranscript = window.localStorage.getItem(TRANSCRIPT_STORAGE_KEY)
        if (rawTranscript) {
          const parsedTranscript = JSON.parse(rawTranscript)
          if (parsedTranscript && typeof parsedTranscript === 'object') {
            transcriptSnapshot = {
              text: typeof (parsedTranscript as any).text === 'string' ? (parsedTranscript as any).text : '',
              turn: typeof (parsedTranscript as any).turn === 'number' ? (parsedTranscript as any).turn : 0,
              at: typeof (parsedTranscript as any).at === 'string' ? (parsedTranscript as any).at : '',
              isEmpty: Boolean((parsedTranscript as any).isEmpty),
              reason:
                typeof (parsedTranscript as any).reason === 'string'
                  ? (parsedTranscript as any).reason
                  : undefined,
              meta:
                (parsedTranscript as any).meta && typeof (parsedTranscript as any).meta === 'object'
                  ? {
                      started:
                        typeof (parsedTranscript as any).meta.started === 'boolean'
                          ? (parsedTranscript as any).meta.started
                          : undefined,
                      manualStop:
                        typeof (parsedTranscript as any).meta.manualStop === 'boolean'
                          ? (parsedTranscript as any).meta.manualStop
                          : undefined,
                      stopReason:
                        typeof (parsedTranscript as any).meta.stopReason === 'string'
                          ? (parsedTranscript as any).meta.stopReason
                          : undefined,
                    }
                  : undefined,
            }
          }
        }
      } catch (error) {
        logClientDiagnostics('error', 'diagnostics:run:transcript-snapshot:error', {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: 'Unknown error', value: error },
        })
      }

      try {
        const rawError = window.localStorage.getItem(PROVIDER_ERROR_STORAGE_KEY)
        if (rawError) {
          const parsed = JSON.parse(rawError)
          if (parsed && typeof parsed === 'object') {
            const rawStatus =
              typeof (parsed as any).status === 'number'
                ? (parsed as any).status
                : typeof (parsed as any).status === 'string'
                ? Number.parseInt((parsed as any).status, 10)
                : null
            const normalizedStatus =
              typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : null
            providerSnapshot = {
              status: normalizedStatus,
              message: typeof (parsed as any).message === 'string' ? (parsed as any).message : 'Unknown error',
              reason: typeof (parsed as any).reason === 'string' ? (parsed as any).reason : undefined,
              snippet: typeof (parsed as any).snippet === 'string' ? (parsed as any).snippet : undefined,
              at: typeof (parsed as any).at === 'string' ? (parsed as any).at : '',
              resolved: (parsed as any).resolved === true,
              resolvedAt:
                typeof (parsed as any).resolvedAt === 'string' ? (parsed as any).resolvedAt : undefined,
            }
          }
        }
      } catch (error) {
        logClientDiagnostics('error', 'diagnostics:run:provider-snapshot:error', {
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : { message: 'Unknown error', value: error },
        })
      }
    }

    const deploymentSnapshot = readDeploymentSnapshot()

    setLatestTranscript(transcriptSnapshot)
    if (providerSnapshot) {
      setLatestProviderError(providerSnapshot)
    } else {
      setLatestProviderError(null)
    }

    if (deploymentSnapshot) {
      const originLabel = deploymentSnapshot.origin || deploymentSnapshot.host || 'origin unknown'
      append(`[deployment] Origin: ${originLabel}`)
      if (deploymentSnapshot.href) {
        append(`[deployment] URL: ${deploymentSnapshot.href}`)
      }
      if (deploymentSnapshot.pathname) {
        append(`[deployment] Path: ${deploymentSnapshot.pathname}`)
      }
      if (deploymentSnapshot.deployContext) {
        append(`[deployment] Runtime context: ${deploymentSnapshot.deployContext}`)
      }
      if (deploymentSnapshot.branch) {
        append(`[deployment] Branch: ${deploymentSnapshot.branch}`)
      }
      if (deploymentSnapshot.deployUrl) {
        append(`[deployment] Deploy URL: ${deploymentSnapshot.deployUrl}`)
      }
      if (deploymentSnapshot.deployPrimeUrl) {
        append(`[deployment] Preview URL: ${deploymentSnapshot.deployPrimeUrl}`)
      }
      if (deploymentSnapshot.netlifySiteUrl) {
        append(`[deployment] Netlify site URL: ${deploymentSnapshot.netlifySiteUrl}`)
      }
      if (deploymentSnapshot.siteUrl && deploymentSnapshot.siteUrl !== deploymentSnapshot.netlifySiteUrl) {
        append(`[deployment] Site URL: ${deploymentSnapshot.siteUrl}`)
      }
      if (deploymentSnapshot.deployId) {
        append(`[deployment] Deploy ID: ${deploymentSnapshot.deployId}`)
      }
      if (deploymentSnapshot.releaseId) {
        append(`[deployment] Build ID: ${deploymentSnapshot.releaseId}`)
      }
    } else {
      append('[deployment] Unable to determine current deployment origin from browser context.')
    }

    if (transcriptSnapshot) {
      const capturedAt =
        transcriptSnapshot.at && !Number.isNaN(Date.parse(transcriptSnapshot.at))
          ? new Date(transcriptSnapshot.at).toLocaleString()
          : 'time unknown'
      if (transcriptSnapshot.isEmpty) {
        const reasonLabel = transcriptSnapshot.reason
          ? ` (${String(transcriptSnapshot.reason).replace(/_/g, ' ')})`
          : ''
        append(`[transcript] Turn ${transcriptSnapshot.turn || '–'} at ${capturedAt}: no transcript${reasonLabel}.`)
      } else {
        append(
          `[transcript] Turn ${transcriptSnapshot.turn || '–'} at ${capturedAt}: "${transcriptSnapshot.text}"`,
        )
      }
      if (transcriptSnapshot.meta) {
        append(
          `[transcript] Meta → started=${formatFlag(transcriptSnapshot.meta.started)} · manual_stop=${formatFlag(
            transcriptSnapshot.meta.manualStop,
          )} · stop_reason=${transcriptSnapshot.meta.stopReason || 'unknown'}`,
        )
      }
    } else {
      append('[transcript] No transcript data captured yet.')
    }

    if (providerSnapshot) {
      const capturedAt = providerSnapshot.at && !Number.isNaN(Date.parse(providerSnapshot.at))
        ? new Date(providerSnapshot.at).toLocaleString()
        : 'time unknown'
      append(
        `[provider-error] ${
          providerSnapshot.status ? `HTTP ${providerSnapshot.status}` : 'Request failed'
        } at ${capturedAt} (${providerSnapshot.reason || 'reason unknown'})`,
      )
      if (providerSnapshot.resolved) {
        const resolvedAt =
          providerSnapshot.resolvedAt && !Number.isNaN(Date.parse(providerSnapshot.resolvedAt))
            ? new Date(providerSnapshot.resolvedAt).toLocaleString()
            : 'time unknown'
        append(`[provider-error] Resolved at ${resolvedAt}`)
      }
      if (providerSnapshot.snippet) {
        append(`[provider-error] Snippet: ${providerSnapshot.snippet}`)
      }
    } else {
      append('[provider-error] No provider errors recorded yet.')
    }

    for (const key of TEST_ORDER) {
      const { path, method } = TEST_CONFIG[key]
      updateResult(key, { status: 'pending', message: undefined })
      resultStatusLog[key] = 'pending'
      append(`→ ${path}`)
      logClientDiagnostics('log', 'diagnostics:test:start', {
        test: key,
        request: { path, method },
      })

      try {
        const res = await fetch(path, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        })
        logClientDiagnostics('log', 'diagnostics:test:response', {
          test: key,
          response: { status: res.status, ok: res.ok },
        })
        const rawText = await res.text()
        let parsed: any = null
        try {
          parsed = JSON.parse(rawText)
        } catch (err) {
          parsed = null
          logClientDiagnostics('log', 'diagnostics:test:parse-json-failed', {
            test: key,
            error:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack }
                : { message: 'Unknown parse error', value: err },
          })
        }

        let normalizedMessage: string | undefined
        let normalizedOk = res.ok
        let remediationSteps: RemediationStep[] | undefined

        if (parsed) {
          append(JSON.stringify(parsed, null, 2))
          const ok = typeof parsed.ok === 'boolean' ? parsed.ok : res.ok
          normalizedOk = ok
          const message = formatSummary(key, parsed)
          normalizedMessage = message
          updateResult(key, { status: ok ? 'ok' : 'error', message })
          resultStatusLog[key] = ok ? 'ok' : 'error'
          remediationSteps =
            key === 'storage'
              ? buildStorageRemediation(parsed)
              : buildDefaultRemediation(key, ok, res.status, message)
          if (key === 'storage') {
            const diagnosticsSummary = summarizeNetlifyDiagnostics(parsed?.env?.diagnostics, deploymentSnapshot)
            if (diagnosticsSummary.length) {
              append('***KEY NETFLIFY ITEMS***')
              diagnosticsSummary.forEach(line => append(line))
              append('***KEY NETFLIFY ITEMS***')
            }
            const flow = parsed?.flow as BlobFlowDiagnostics | undefined
            if (flow && Array.isArray(flow.steps) && flow.steps.length) {
              append('***BLOB FLOW STEPS***')
              const contextParts: string[] = []
              if (flow.probeId) contextParts.push(`probe=${flow.probeId}`)
              if (flow.sdkPath) contextParts.push(`sdk_path=${flow.sdkPath}`)
              if (flow.sitePutPath) contextParts.push(`site_put_path=${flow.sitePutPath}`)
              if (flow.directApiPath) contextParts.push(`direct_api_path=${flow.directApiPath}`)
              if (flow.origin) contextParts.push(`origin=${flow.origin}`)
              if (contextParts.length) {
                append(`[blob-flow] Context → ${contextParts.join(' · ')}`)
              }
              flow.steps.forEach(step => {
                const flag = step.skipped ? '⏭️' : step.ok ? '✅' : '❌'
                const method = step.method ? `${step.method} ` : ''
                const status = typeof step.status === 'number' ? ` (HTTP ${step.status})` : ''
                const url = step.url ? ` → ${step.url}` : ''
                const duration = typeof step.durationMs === 'number' ? ` · ${step.durationMs}ms` : ''
                const note = step.note ? ` · note: ${step.note}` : ''
                const error = step.error ? ` · error: ${step.error}` : ''
                const body = step.responseSnippet ? ` · body: ${step.responseSnippet}` : ''
                append(`${flag} ${method}${step.label || step.id}${status}${url}${duration}${note}${error}${body}`)
              })
              append('***BLOB FLOW STEPS***')
            }
          }
        } else {
          append(rawText || '(no response body)')
          normalizedMessage = res.ok ? 'Received response' : `HTTP ${res.status}`
          normalizedOk = res.ok
          updateResult(key, {
            status: res.ok ? 'ok' : 'error',
            message: normalizedMessage,
          })
          resultStatusLog[key] = res.ok ? 'ok' : 'error'
          remediationSteps = buildDefaultRemediation(key, res.ok, res.status, normalizedMessage)
        }

        logClientDiagnostics('log', 'diagnostics:test:success', {
          test: key,
          response: { status: res.status, ok: normalizedOk },
          message: normalizedMessage,
        })

        if (remediationSteps && remediationSteps.length) {
          setRemediationPlans((prev) => ({ ...prev, [key]: remediationSteps }))
        }
      } catch (e: any) {
        const errorMessage = e?.message || 'Request failed'
        append(`Request failed: ${errorMessage}`)
        updateResult(key, { status: 'error', message: errorMessage })
        resultStatusLog[key] = 'error'
        setRemediationPlans((prev) => ({
          ...prev,
          [key]: buildDefaultRemediation(key, false, null, errorMessage),
        }))
        logClientDiagnostics('error', 'diagnostics:test:error', {
          test: key,
          error:
            e instanceof Error
              ? { name: e.name, message: e.message, stack: e.stack }
              : { message: 'Unknown error', value: e },
          detail: errorMessage,
        })
      }
    }

    logClientDiagnostics('log', 'diagnostics:foxes:fetch:start', {
      request: { path: '/api/diagnostics/foxes', method: 'GET' },
    })

    try {
      const foxRes = await fetch('/api/diagnostics/foxes')
      logClientDiagnostics('log', 'diagnostics:foxes:fetch:response', {
        response: { status: foxRes.status, ok: foxRes.ok },
      })
      if (foxRes.ok) {
        const data = await foxRes.json()
        if (data && Array.isArray(data.foxes)) {
          setFoxes(data.foxes as FoxRecord[])
          if (data.foxes.length) {
            append(`Foxes flagged: ${data.foxes.length}`)
            append(JSON.stringify(data.foxes, null, 2))
            logClientDiagnostics('log', 'diagnostics:foxes:fetch:success', {
              count: data.foxes.length,
            })
          } else {
            append('Foxes flagged: 0')
            logClientDiagnostics('log', 'diagnostics:foxes:fetch:success', {
              count: 0,
            })
          }
        }
      }
    } catch (err) {
      append('Failed to load fox diagnostics.')
      logClientDiagnostics('error', 'diagnostics:foxes:fetch:error', {
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : { message: 'Unknown error', value: err },
      })
    }

    append('Diagnostics complete.')
    logClientDiagnostics('log', 'diagnostics:run:complete', {
      testsRun: TEST_ORDER.length,
      results: { ...resultStatusLog },
    })
    setIsRunning(false)
  }

  const transcriptTurnLabel =
    latestTranscript && typeof latestTranscript.turn === 'number' && latestTranscript.turn > 0
      ? latestTranscript.turn
      : '–'
  const transcriptTimestampLabel =
    latestTranscript && typeof latestTranscript.at === 'string' && latestTranscript.at.length
      ? Number.isNaN(Date.parse(latestTranscript.at))
        ? 'time unknown'
        : new Date(latestTranscript.at).toLocaleString()
      : 'time unknown'
  const transcriptReasonLabel = latestTranscript?.reason
    ? ` (${String(latestTranscript.reason).replace(/_/g, ' ')})`
    : ''
  const transcriptProviderLabel = latestTranscript?.provider
    ? latestTranscript.provider
    : 'provider unknown'

  return (
    <main>
      <div className="panel-card diagnostics-panel">
        <h2 className="page-heading">Diagnostics</h2>
        <button onClick={runDiagnostics} disabled={isRunning} className="btn-secondary btn-large">
          {isRunning ? 'Running…' : 'Run full diagnostics'}
        </button>

        <div className="diagnostics-transcript">
          <h3>Latest transcript heard</h3>
          {latestTranscript ? (
            <div className="diagnostic-card">
              <div className="diagnostic-card-head">
                <span className="diagnostic-label">
                  Turn {transcriptTurnLabel} · {transcriptTimestampLabel} · {transcriptProviderLabel}
                </span>
              </div>
              <div className="diagnostic-message">
                {latestTranscript.isEmpty
                  ? `No transcript captured${transcriptReasonLabel}.`
                  : `“${latestTranscript.text}”`}
              </div>
              {latestTranscript.meta && (
                <div className="diagnostic-meta">
                  Started: {formatFlag(latestTranscript.meta.started)} · Manual stop:{' '}
                  {formatFlag(latestTranscript.meta.manualStop)} · Stop reason:{' '}
                  {latestTranscript.meta.stopReason || 'unknown'}
                </div>
              )}
            </div>
          ) : (
            <p className="status-note">No recent transcript data captured yet.</p>
          )}
        </div>

        <div className="diagnostics-provider-error">
          <h3>Latest provider error</h3>
          {latestProviderError ? (
            <div className="diagnostic-card">
              <div className="diagnostic-card-head">
                <span className="diagnostic-label">
                  {latestProviderError.status ? `HTTP ${latestProviderError.status}` : 'Request failed'} ·{' '}
                  {Number.isNaN(Date.parse(latestProviderError.at))
                    ? 'time unknown'
                    : new Date(latestProviderError.at).toLocaleString()}
                </span>
              </div>
              <div className="diagnostic-message">{latestProviderError.message}</div>
              <div className="diagnostic-meta">
                Reason: {latestProviderError.reason || 'unspecified'} · Status:{' '}
                {latestProviderError.resolved ? 'resolved' : 'active'}
                {latestProviderError.resolved && latestProviderError.resolvedAt
                  ? ` at ${new Date(latestProviderError.resolvedAt).toLocaleString()}`
                  : ''}
              </div>
              {latestProviderError.snippet && (
                <pre className="diagnostic-snippet">{latestProviderError.snippet}</pre>
              )}
            </div>
          ) : (
            <p className="status-note">No provider errors have been recorded yet.</p>
          )}
        </div>

        <div className="diagnostics-hypotheses">
          <h3>OpenAI + Supabase hypotheses checklist</h3>
          <p className="status-note">
            Live environment checks for the twenty OpenAI and Supabase hypotheses. Each item logs with a timestamped
            diagnostic prefix to avoid silent failures.
          </p>
          {hypothesisStatus === 'loading' && <p className="status-note">Loading hypothesis checks…</p>}
          {hypothesisError && <p className="status-note env-error-note">Failed to load: {hypothesisError}</p>}
          {hypothesisSummary && (
            <div className="diagnostics-env-summary">
              <span>Total: {hypothesisSummary.total}</span>
              <span>OK: {hypothesisSummary.ok}</span>
              <span>Warnings: {hypothesisSummary.warn}</span>
              <span>Errors: {hypothesisSummary.error}</span>
            </div>
          )}
          {sortedHypotheses.length === 0 ? (
            <p className="status-note">No hypothesis results yet.</p>
          ) : (
            <div className="hypothesis-grid">
              {sortedHypotheses.map((item) => (
                <div key={item.id} className={`diagnostic-card hypothesis-card hypothesis-${item.status}`}>
                  <div className="diagnostic-card-head">
                    <span className="diagnostic-icon" aria-hidden="true">
                      {hypothesisIcon[item.status]}
                    </span>
                    <span className="diagnostic-label">{item.label}</span>
                    <span className="hypothesis-category">{item.category}</span>
                  </div>
                  <div className="diagnostic-message hypothesis-detail">{item.detail}</div>
                  {item.suggestion ? (
                    <div className="hypothesis-suggestion">Suggested action: {item.suggestion}</div>
                  ) : null}
                  {item.evidence ? (
                    <pre className="hypothesis-evidence">{JSON.stringify(item.evidence, null, 2)}</pre>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="diagnostics-tests">
          {TEST_ORDER.map((key) => {
            const result = results[key]
            const steps = remediationPlans[key] ?? []
            return (
              <div key={key} className="diagnostic-card">
                <div className="diagnostic-card-head">
                  <span className="diagnostic-icon" aria-hidden="true">
                    {statusIcon[result.status]}
                  </span>
                  <span className="diagnostic-label">{TEST_CONFIG[key].label}</span>
                </div>
                {result.message && <div className="diagnostic-message">{result.message}</div>}
                {steps.length > 0 && (
                  <ul className="diagnostic-steps">
                    {steps.map((step, index) => (
                      <li key={`${key}-step-${index}`} className="diagnostic-step">
                        <span className="diagnostic-step-icon" aria-hidden="true">
                          {remediationIcon[step.outcome]}
                        </span>
                        <div className="diagnostic-step-body">
                          <div className="diagnostic-step-label">{step.label}</div>
                          {step.detail && <div className="diagnostic-step-detail">{step.detail}</div>}
                          {step.suggestion && (
                            <div className="diagnostic-step-suggestion">Suggestion: {step.suggestion}</div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>

        <textarea value={log} readOnly rows={12} className="diagnostics-log" />

        <div className="diagnostics-foxes">
          <h3>Tracked foxes</h3>
          {foxes.length === 0 ? (
            <p className="status-note">No foxes have been triggered yet.</p>
          ) : (
            <ul className="diagnostics-fox-list">
              {foxes.map((fox) => (
                <li key={fox.id} className="diagnostic-card">
                  <div className="fox-head">
                    <span className="fox-title">Theory {fox.theory} – {fox.message}</span>
                    <span className="fox-level">{fox.level}</span>
                  </div>
                  <div className="fox-meta">
                    Count: {fox.count} · Last: {new Date(fox.lastTriggeredAt).toLocaleString()}
                  </div>
                  {fox.details && (
                    <pre className="fox-details">{JSON.stringify(fox.details, null, 2)}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="diagnostics-debug-panel">
          <h3>Debug utilities</h3>
          <p className="status-note">
            These controls mirror the dedicated Debug page so you can validate blob storage and cleanup flows without
            leaving the diagnostics workspace.
          </p>
          <DebugPanel />
        </div>

        <div className="diagnostics-env-dump">
          <h3>Environment variables snapshot</h3>
          {envError ? (
            <p className="status-note env-error-note">
              Failed to load environment variables: {envError}
            </p>
          ) : envDump === null ? (
            <p className="status-note">Loading environment variables…</p>
          ) : envDump.length === 0 ? (
            <p className="status-note">No environment variables were returned by diagnostics.</p>
          ) : (
            <>
              {envStatusNote && <p className="status-note env-error-note">{envStatusNote}</p>}
              {envSummary && (
                <div className="diagnostics-env-summary">
                  <span>Total: {envSummary.total}</span>
                  <span>Errors: {envSummary.errors}</span>
                  <span>Warnings: {envSummary.warnings}</span>
                </div>
              )}
              <div className="env-copy-controls">
                <button type="button" className="btn-secondary" onClick={handleCopyEnv}>
                  Copy all env vars
                </button>
                {envCopyStatus ? <span className="status-note">{envCopyStatus}</span> : null}
              </div>
              <textarea
                className="env-copy-textarea"
                readOnly
                value={envCopyText}
                rows={envCopyRows}
                style={{ height: `${envCopyRows}em` }}
              />
              <div className="env-table-wrapper" role="region" aria-live="polite">
                <table className="env-table">
                  <thead>
                    <tr>
                      <th scope="col">Key</th>
                      <th scope="col">Status</th>
                      <th scope="col">Value</th>
                      <th scope="col">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {envDump.map((entry, index) => {
                      const rowKey = entry.key && entry.key.length ? entry.key : `env-${index}`
                      return (
                        <tr key={rowKey}>
                          <td>{entry.key || '(unnamed)'}</td>
                          <td>
                            <span className={`env-severity env-${entry.severity}`}>
                              {entry.severity.toUpperCase()}
                            </span>
                          </td>
                          <td>
                            <code>{entry.value ?? '(undefined)'}</code>
                          </td>
                          <td>{entry.message ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  )
}

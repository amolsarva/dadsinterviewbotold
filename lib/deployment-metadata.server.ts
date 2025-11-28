import { URL } from 'node:url'
import type { DeploymentMetadata, ParsedRepo } from '@/types/deployment'
export type { DeploymentMetadata } from '@/types/deployment'

type LogLevel = 'log' | 'error'

type LogPayload = Record<string, unknown>

type DeployIdCandidate = {
  key: string
  value: string | undefined
}

const HYPOTHESES = [
  'NETLIFY_DEPLOY_ID may not be exported to the build environment, leaving blob writes without provenance.',
  'Commit metadata could still reference deprecated hosting variables, breaking build footer links.',
  'Client diagnostics may not receive deployment context if no bootstrap script publishes it.',
]

function formatTimestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    netlify: process.env.NETLIFY ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
    totalKeys: Object.keys(process.env).length,
  }
}

function log(level: LogLevel, step: string, payload: LogPayload = {}) {
  const entry = { ...payload, envSummary: envSummary(), hypotheses: HYPOTHESES }
  const message = `[diagnostic] ${formatTimestamp()} deployment-metadata:${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function parseRepoFromEnv(): ParsedRepo {
  const fromGithub = process.env.GITHUB_REPOSITORY ?? process.env.NEXT_PUBLIC_GITHUB_REPOSITORY ?? null
  if (fromGithub && fromGithub.includes('/')) {
    const [owner, name] = fromGithub.split('/', 2)
    return {
      owner,
      name,
      httpsUrl: `https://github.com/${owner}/${name}`,
    }
  }

  const repositoryUrl = process.env.REPOSITORY_URL ?? null
  if (repositoryUrl) {
    try {
      const parsed = new URL(repositoryUrl)
      const parts = parsed.pathname.split('/').filter(Boolean)
      if (parts.length >= 2) {
        const owner = parts[parts.length - 2]
        const name = parts[parts.length - 1].replace(/\.git$/i, '')
        return {
          owner,
          name,
          httpsUrl: `https://github.com/${owner}/${name}`,
        }
      }
    } catch (error) {
      log('error', 'repo:parse-error', { repositoryUrl, error })
    }
  }

  return {
    owner: null,
    name: null,
    httpsUrl: null,
  }
}

function pickDeployId(): { candidate: DeployIdCandidate | null; cleanedValue: string | null } {
  const candidates: DeployIdCandidate[] = [
    { key: 'MY_DEPLOY_ID', value: process.env.MY_DEPLOY_ID },
    { key: 'NETLIFY_DEPLOY_ID', value: process.env.NETLIFY_DEPLOY_ID },
    { key: 'DEPLOY_ID', value: process.env.DEPLOY_ID },
    { key: 'VERCEL_DEPLOYMENT_ID', value: process.env.VERCEL_DEPLOYMENT_ID },
    { key: 'VERCEL_DEPLOY_ID', value: process.env.VERCEL_DEPLOY_ID },
    { key: 'VERCEL_BUILD_ID', value: process.env.VERCEL_BUILD_ID },
    { key: 'NEXT_PUBLIC_DEPLOY_ID', value: process.env.NEXT_PUBLIC_DEPLOY_ID },
  ]

  for (const candidate of candidates) {
    if (typeof candidate.value === 'string') {
      const trimmed = candidate.value.trim()
      if (trimmed.length > 0) {
        return { candidate, cleanedValue: trimmed }
      }
    }
  }

  return { candidate: null, cleanedValue: null }
}

export function resolveDeploymentMetadata(): DeploymentMetadata {
  log('log', 'resolve:start', {})

  const platform: DeploymentMetadata['platform'] =
    process.env.NETLIFY === 'true'
      ? 'netlify'
      : process.env.VERCEL === '1' || process.env.VERCEL === 'true'
      ? 'vercel'
      : 'custom'

  const { candidate, cleanedValue } = pickDeployId()

  const deployIdRequired = platform === 'netlify'
  const hasDeployId = Boolean(candidate && cleanedValue)

  if (deployIdRequired && !hasDeployId) {
    const message =
      'Deploy ID is required but missing. Export NETLIFY_DEPLOY_ID (or MY_DEPLOY_ID/DEPLOY_ID) before building.'
    log('error', 'resolve:deploy-id-missing', { platform, deployIdRequired })
    throw new Error(message)
  }

  const deployId =
    cleanedValue ?? `missing-deploy-id-${Date.now()}`
  const deployIdSource = candidate?.key ?? 'fallback:missing'

  if (!hasDeployId) {
    log('error', 'resolve:deploy-id-fallback', {
      platform,
      deployIdSource,
      deployId,
    })
  }

  const commitRef = process.env.COMMIT_REF ?? process.env.GIT_COMMIT_SHA ?? null
  const commitMessage = process.env.COMMIT_MESSAGE ?? process.env.GIT_COMMIT_MESSAGE ?? null
  const commitTimestamp = process.env.COMMIT_TIMESTAMP ?? process.env.GIT_COMMIT_TIMESTAMP ?? null
  const branch = process.env.BRANCH ?? process.env.HEAD ?? null
  const siteId = process.env.NETLIFY_SITE_ID ?? process.env.SITE_ID ?? null
  const siteName = process.env.NETLIFY_SITE_NAME ?? process.env.SITE_NAME ?? null
  const deployUrl = process.env.DEPLOY_URL ?? null
  const deployPrimeUrl = process.env.DEPLOY_PRIME_URL ?? null
  const siteUrl = process.env.URL ?? null
  const context = process.env.CONTEXT ?? process.env.NETLIFY_CONTEXT ?? null

  const repo = parseRepoFromEnv()

  const metadata: DeploymentMetadata = {
    platform,
    deployId,
    deployIdSource,
    commitRef,
    commitMessage,
    commitTimestamp,
    branch,
    siteId,
    siteName,
    deployUrl,
    deployPrimeUrl,
    siteUrl,
    repo,
    context,
  }

  log('log', 'resolve:success', { metadata })

  return metadata
}

export function buildDeploymentBootstrapScript(metadata: DeploymentMetadata): string {
  log('log', 'bootstrap:emit', { metadataPreview: { ...metadata, repo: metadata.repo } })

  const literal = JSON.stringify(metadata)
  return `(() => {\n  const step = 'deployment:bootstrap:apply'\n  const now = new Date().toISOString()\n  const summary = typeof window === 'undefined'\n    ? { origin: '__no_window__', pathname: '__no_window__' }\n    : { origin: window.location.origin, pathname: window.location.pathname }\n  const payload = { metadata: ${literal}, summary }\n  console.log('[diagnostic] ' + now + ' ' + step + ' ' + JSON.stringify(payload))\n  window.__DEPLOYMENT_METADATA__ = ${literal}\n  window.dispatchEvent(new CustomEvent('deployment:ready', { detail: ${literal} }))\n})()`
}

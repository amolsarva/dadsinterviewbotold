import { resolveDeploymentMetadata } from '@/lib/deployment-metadata.server'
import { NextResponse } from 'next/server'
import { jsonErrorResponse } from '@/lib/api-error'

type EndpointSummary = {
  key: string
  method: 'GET' | 'POST'
  path: string
  description: string
}

const ENDPOINTS: EndpointSummary[] = [
  {
    key: 'health',
    method: 'GET',
    path: '/api/health',
    description: 'Overall service health, storage configuration, and email defaults.',
  },
  {
    key: 'env',
    method: 'GET',
    path: '/api/diagnostics/env',
    description: 'Full environment inspection and validation for required variables.',
  },
  {
    key: 'storage',
    method: 'GET',
    path: '/api/diagnostics/storage',
    description: 'Blob store readiness check and environment diagnostics.',
  },
  {
    key: 'google',
    method: 'GET',
    path: '/api/diagnostics/google',
    description: 'Connectivity test against the configured Google AI model.',
  },
  {
    key: 'openai',
    method: 'GET',
    path: '/api/diagnostics/openai',
    description: 'Connectivity test against the configured OpenAI model.',
  },
  {
    key: 'smoke',
    method: 'POST',
    path: '/api/diagnostics/smoke',
    description: 'End-to-end session smoke test that writes to the configured blob store.',
  },
  {
    key: 'e2e',
    method: 'POST',
    path: '/api/diagnostics/e2e',
    description: 'Full workflow exercise that mirrors production transcript storage.',
  },
  {
    key: 'email',
    method: 'POST',
    path: '/api/diagnostics/email',
    description: 'Dispatches a summary email via the configured provider.',
  },
]

function detectDeployment() {
  const metadata = resolveDeploymentMetadata()
  const platform = metadata.platform
  const functionBase = platform === 'netlify' ? '/.netlify/functions' : null

  return {
    platform,
    functionBase,
    nodeEnv: process.env.NODE_ENV,
    edgeMiddleware: Boolean(process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs'),
    netlifySiteId: metadata.siteId ?? null,
    netlifySiteName: metadata.siteName ?? null,
    deployContext: metadata.context ?? null,
    deployUrl: metadata.deployUrl ?? metadata.deployPrimeUrl ?? metadata.siteUrl ?? null,
    deployId: metadata.deployId,
    branch: metadata.branch,
    commitRef: metadata.commitRef,
  }
}

const TROUBLESHOOTING = [
  'If this endpoint returns 404 in production, the diagnostics routes were not bundled as server functions.',
  'Confirm your build preserves the Next.js app directory and that Netlify is using the Next.js runtime.',
  'When deploying to Netlify without the Next adapter, place functions under netlify/functions or configure `netlify.toml`.',
  'Use `netlify functions:list` or `netlify dev` locally to confirm the diagnostics handlers are registered.',
]

export async function GET() {
  try {
    const deployment = detectDeployment()

    const preferredBase = deployment.functionBase ? `${deployment.functionBase}/diagnostics` : '/api/diagnostics'

    return NextResponse.json({
      ok: true,
      message:
        'Diagnostics base route is available. Invoke the specific endpoints below to run targeted checks.',
      preferredBase,
      deployment,
      endpoints: ENDPOINTS,
      troubleshooting: TROUBLESHOOTING,
    })
  } catch (error) {
    return jsonErrorResponse(error, 'Failed to load diagnostics metadata')
  }
}

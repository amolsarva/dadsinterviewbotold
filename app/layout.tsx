import './globals.css'
import React from 'react'
import { buildDefaultNotifyEmailBootstrapScript } from '@/lib/default-notify-email.server'
import { buildDeploymentBootstrapScript, resolveDeploymentMetadata } from '@/lib/deployment-metadata.server'
import { SiteNav } from './site-nav'

type LogLevel = 'log' | 'error'

function formatTimestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    nodeEnv: process.env.NODE_ENV ?? null,
    platform: process.env.VERCEL ? 'vercel' : process.env.NETLIFY ? 'netlify' : 'custom',
    totalKeys: Object.keys(process.env).length,
  }
}

function log(level: LogLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = { ...payload, envSummary: envSummary() }
  const message = `[diagnostic] ${formatTimestamp()} layout:${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function tryBuildDefaultEmailBootstrapScript() {
  try {
    const script = buildDefaultNotifyEmailBootstrapScript()
    log('log', 'default-email:bootstrap:ready')
    return script
  } catch (error) {
    const errorPayload =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { message: 'unknown_error' }
    log('error', 'default-email:bootstrap:skipped', { error: errorPayload })
    const clientNotice =
      "(() => {const now = new Date().toISOString(); const payload = { reason: 'missing_default_notify_email', envSummary: " +
      `JSON.stringify(${JSON.stringify(envSummary())}) }; ` +
      "console.error('[diagnostic] ' + now + ' default-email:bootstrap:client-missing ' + JSON.stringify(payload));})();"
    return clientNotice
  }
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const deploymentMetadata = resolveDeploymentMetadata()
  const commitSha = deploymentMetadata.commitRef ?? ''
  const commitMessage = deploymentMetadata.commitMessage ?? 'commit message unavailable'
  const commitTimestamp = deploymentMetadata.commitTimestamp
  const repoOwner = deploymentMetadata.repo.owner ?? ''
  const repoSlug = deploymentMetadata.repo.name ?? ''

  const shortSha = commitSha ? commitSha.slice(0, 7) : deploymentMetadata.deployId.slice(0, 7)

  const commitUrl =
    commitSha && deploymentMetadata.repo.httpsUrl
      ? `${deploymentMetadata.repo.httpsUrl}/commit/${commitSha}`
      : null

  const easternFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const formatEasternLabel = (date: Date) => `${easternFormatter.format(date)} ET`
  const fallbackEasternTime = formatEasternLabel(new Date())
  let formattedTime = fallbackEasternTime
  if (commitTimestamp) {
    const parsed = new Date(commitTimestamp)
    if (!Number.isNaN(parsed.valueOf())) {
      formattedTime = formatEasternLabel(parsed)
    }
  }
  const buildTimestampLabel = `This build is from ${formattedTime}`

  const defaultEmailBootstrapScript = tryBuildDefaultEmailBootstrapScript()
  const deploymentBootstrapScript = buildDeploymentBootstrapScript(deploymentMetadata)

  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: defaultEmailBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: deploymentBootstrapScript }} />
        <div className="site-shell">
          <header className="site-header">
            <h1 className="site-title">DadsBot</h1>
            <SiteNav />
          </header>
          <div className="panel-section">{children}</div>
          <footer className="site-footer">
            {commitUrl ? (
              <a href={commitUrl}>
                {shortSha} — {commitMessage}
              </a>
            ) : (
              <span>
                {shortSha} — {commitMessage}
              </span>
            )}{' '}
            · {buildTimestampLabel}
          </footer>
        </div>
      </body>
    </html>
  )
}

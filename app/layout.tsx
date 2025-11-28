import './globals.css'
import React from 'react'
import { buildDefaultNotifyEmailBootstrapScript } from '@/lib/default-notify-email.server'
import { buildDeploymentBootstrapScript, resolveDeploymentMetadata } from '@/lib/deployment-metadata.server'
import { SiteNav } from './site-nav'

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

  const defaultEmailBootstrapScript = buildDefaultNotifyEmailBootstrapScript()
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

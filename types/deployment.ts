export type ParsedRepo = {
  owner: string | null
  name: string | null
  httpsUrl: string | null
}

export type DeploymentMetadata = {
  platform: 'vercel' | 'netlify' | 'custom'
  deployId: string
  deployIdSource: string
  commitRef: string | null
  commitMessage: string | null
  commitTimestamp: string | null
  branch: string | null
  siteId: string | null
  siteName: string | null
  deployUrl: string | null
  deployPrimeUrl: string | null
  siteUrl: string | null
  repo: ParsedRepo
  context: string | null
}

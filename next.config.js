const { env } = process

const relevantEnvSummary = () => ({
  VERCEL: env.VERCEL ?? null,
  VERCEL_ENV: env.VERCEL_ENV ?? null,
  NODE_ENV: env.NODE_ENV ?? null,
  SUPABASE_URL: env.SUPABASE_URL ? '[set]' : null,
  SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY ? `${env.SUPABASE_SERVICE_ROLE_KEY.length} chars` : null,
  SUPABASE_STORAGE_BUCKET: env.SUPABASE_STORAGE_BUCKET ?? null,
})

const diagnosticLog = (message, extra = {}) => {
  const timestamp = new Date().toISOString()
  const payload = { ...extra, envSummary: relevantEnvSummary() }
  console.log(`[diagnostic] ${timestamp} | ${message} | payload=${JSON.stringify(payload)}`)
}

const diagnosticThrow = (message, extra = {}) => {
  const timestamp = new Date().toISOString()
  const payload = { ...extra, envSummary: relevantEnvSummary() }
  const serializedPayload = JSON.stringify(payload)
  const formattedMessage = `[diagnostic] ${timestamp} | ${message} | payload=${serializedPayload}`
  console.error(formattedMessage)
  throw new Error(formattedMessage)
}

const requiredSupabaseKeys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET']
const missing = requiredSupabaseKeys.filter((key) => !env[key] || !String(env[key]).trim().length)
if (missing.length) {
  diagnosticThrow('Missing required Supabase configuration for Vercel deployment', { missing })
}

diagnosticLog('Vercel runtime detected; Supabase configuration present')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    serverActions: { allowedOrigins: ['*'] },
  },
}

module.exports = nextConfig

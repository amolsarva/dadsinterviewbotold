import { createClient, type SupabaseClient } from "@supabase/supabase-js"

type EnvSummary = {
  supabaseUrl: string
  supabaseServiceRoleKey: string
  supabaseStorageBucket: string
}

type LogLevel = "log" | "error"

type HealthResult = {
  ok: boolean
  message: string
  detail?: unknown
}

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function baseEnvSummary(): EnvSummary {
  return {
    supabaseUrl: process.env.SUPABASE_URL ? "set" : "missing",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "missing",
    supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET ? "set" : "missing",
  }
}

function logDiagnostic(level: LogLevel, step: string, envSummary: EnvSummary, details?: Record<string, unknown>) {
  const payload = {
    step,
    timestamp: diagnosticsTimestamp(),
    envSummary,
    ...(details ?? {}),
  }
  const message = `[diagnostic] ${payload.timestamp} supabase-health:${step} ${JSON.stringify(payload)}`
  return level === "error" ? console.error(message) : console.log(message)
}

function requireEnv(key: string, envSummary: EnvSummary): string {
  const value = process.env[key]
  if (!value || !value.trim()) {
    const error = new Error(`${key} is required for Supabase health checks; diagnostics never assume defaults.`)
    logDiagnostic("error", "missing-env", envSummary, { key })
    throw error
  }
  return value
}

function getSupabaseClient(envSummary: EnvSummary): SupabaseClient {
  const supabaseUrl = requireEnv("SUPABASE_URL", envSummary)
  const supabaseServiceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", envSummary)
  const client = createClient(supabaseUrl, supabaseServiceRoleKey)
  logDiagnostic("log", "client-initialized", envSummary, {
    endpointPreview: `${supabaseUrl.slice(0, 24)}...`,
  })
  return client
}

async function validateServiceRoleAccess(client: SupabaseClient, envSummary: EnvSummary): Promise<HealthResult> {
  logDiagnostic("log", "service-role:check", envSummary)
  const { error } = await client.from("turns").select("id", { head: true, count: "exact" })
  if (error) {
    const message = `Service role validation failed: ${error.message}`
    logDiagnostic("error", "service-role:failed", envSummary, { error: message })
    return { ok: false, message }
  }
  logDiagnostic("log", "service-role:ok", envSummary)
  return { ok: true, message: "Service role key can access turns table." }
}

async function validateTurnsTableSchema(client: SupabaseClient, envSummary: EnvSummary): Promise<HealthResult> {
  logDiagnostic("log", "turns-schema:check", envSummary)
  const { data, error } = await client
    .from("turns")
    .select("id, created_at", { count: "exact", head: true })
  if (error) {
    const message = `Turns table schema validation failed: ${error.message}`
    logDiagnostic("error", "turns-schema:failed", envSummary, { error: message })
    return { ok: false, message }
  }
  logDiagnostic("log", "turns-schema:ok", envSummary, { count: data?.length ?? 0 })
  return { ok: true, message: "Turns table schema accessible." }
}

async function checkStorageBucketAccess(client: SupabaseClient, envSummary: EnvSummary): Promise<HealthResult> {
  const bucket = requireEnv("SUPABASE_STORAGE_BUCKET", envSummary)
  logDiagnostic("log", "storage:check", envSummary, { bucket })
  const { error } = await client.storage.from(bucket).list("", { limit: 1 })
  if (error) {
    const message = `Storage bucket access failed: ${error.message}`
    logDiagnostic("error", "storage:failed", envSummary, { bucket, error: message })
    return { ok: false, message }
  }
  logDiagnostic("log", "storage:ok", envSummary, { bucket })
  return { ok: true, message: "Storage bucket accessible." }
}

async function checkStorageWritePermissions(client: SupabaseClient, envSummary: EnvSummary): Promise<HealthResult> {
  const bucket = requireEnv("SUPABASE_STORAGE_BUCKET", envSummary)
  const path = `diagnostics/supabase-health-${Date.now()}.txt`
  logDiagnostic("log", "storage-write:check", envSummary, { bucket, path })
  const { error } = await client.storage
    .from(bucket)
    .upload(path, new Blob(["diagnostics-write-probe"]), { upsert: true, contentType: "text/plain" })
  if (error) {
    const message = `Storage write permissions failed: ${error.message}`
    logDiagnostic("error", "storage-write:failed", envSummary, { bucket, path, error: message })
    return { ok: false, message }
  }
  logDiagnostic("log", "storage-write:ok", envSummary, { bucket, path })
  return { ok: true, message: "Storage bucket accepts writes." }
}

async function runHealthCheckSuite(): Promise<HealthResult[]> {
  const envSummary = baseEnvSummary()
  logDiagnostic("log", "suite:start", envSummary, {
    note: "Supabase diagnostics share production env; no diagnostics-only settings are used.",
  })
  const client = getSupabaseClient(envSummary)

  const results: HealthResult[] = []
  const checks = [
    () => validateServiceRoleAccess(client, envSummary),
    () => validateTurnsTableSchema(client, envSummary),
    () => checkStorageBucketAccess(client, envSummary),
    () => checkStorageWritePermissions(client, envSummary),
  ]

  for (const check of checks) {
    try {
      const result = await check()
      results.push(result)
      if (!result.ok) {
        logDiagnostic("error", "suite:check-failed", envSummary, { message: result.message })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Supabase health check failure"
      logDiagnostic("error", "suite:exception", envSummary, { error: message })
      results.push({ ok: false, message })
    }
  }

  logDiagnostic("log", "suite:complete", envSummary, { results })
  return results
}

export {
  checkStorageBucketAccess,
  checkStorageWritePermissions,
  runHealthCheckSuite,
  validateServiceRoleAccess,
  validateTurnsTableSchema,
}

import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function logDiagnostic(
  level: "log" | "error",
  step: string,
  envSummary: Record<string, string>,
  details?: Record<string, unknown>,
) {
  const payload = {
    step,
    timestamp: diagnosticsTimestamp(),
    envSummary,
    ...(details ?? {}),
  }
  const message = `[diagnostic] ${payload.timestamp} supabase:${step} ${JSON.stringify(payload)}`
  return level === "error" ? console.error(message) : console.log(message)
}

function requireEnv(key: string, value: string | undefined) {
  if (!value) {
    const error = new Error(`${key} is required for Supabase diagnostics; no defaults are assumed.`)
    error.name = "MissingSupabaseEnv"
    throw error
  }
  return value
}

export async function GET() {
  const timestamp = diagnosticsTimestamp()
  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

  const envSummary = {
    supabaseUrl: supabaseUrl ? "set" : "missing",
    supabaseAnonKey: supabaseAnonKey ? "set" : "missing",
    modelParityNote: "Diagnostics uses production Supabase credentials; there are no diagnostics-only fallbacks.",
  }

  try {
    logDiagnostic("log", "start", envSummary, {
      note: "Validating Supabase environment before health RPC.",
    })

    const validatedUrl = requireEnv("SUPABASE_URL", supabaseUrl)
    const validatedAnonKey = requireEnv("SUPABASE_ANON_KEY", supabaseAnonKey)

    const supabase = createClient(validatedUrl, validatedAnonKey)
    logDiagnostic("log", "client-initialized", envSummary, {
      endpointPreview: `${validatedUrl.slice(0, 24)}...`,
    })

    const { data, error } = await supabase.rpc("health_check")

    if (error) {
      logDiagnostic("error", "rpc-failed", envSummary, { error: error.message })
      return NextResponse.json(
        {
          status: "error",
          ok: false,
          timestamp,
          envSummary,
          message: "Supabase health check failed.",
          recoveryInstructions: [
            "Check your Supabase instance status in the dashboard.",
            "Verify database connection settings and RPC availability.",
            "Confirm SUPABASE_URL and SUPABASE_ANON_KEY match production values.",
          ],
          error: error.message,
        },
        { status: 500 },
      )
    }

    logDiagnostic("log", "rpc-success", envSummary, { result: data })

    return NextResponse.json({
      status: "success",
      ok: true,
      timestamp,
      envSummary,
      message: "Supabase is healthy!",
      data,
    })
  } catch (error: any) {
    logDiagnostic("error", "failed", envSummary, {
      error: error instanceof Error ? error.message : String(error),
    })

    return NextResponse.json(
      {
        status: "error",
        ok: false,
        timestamp,
        envSummary,
        message:
          error instanceof Error
            ? error.message
            : "Supabase diagnostics failed; verify required environment variables and RPC availability.",
        recoveryInstructions: [
          "Set SUPABASE_URL and SUPABASE_ANON_KEY to the same values used in production.",
          "Ensure the health_check RPC exists and is accessible to the anon role.",
          "Retry once credentials are in place; the endpoint exits early on missing configuration.",
        ],
      },
      { status: 500 },
    )
  }
}

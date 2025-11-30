import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel, getGoogleClient } from "@/lib/google"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

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
  const message = `[diagnostic] ${payload.timestamp} google:${step} ${JSON.stringify(payload)}`
  return level === "error" ? console.error(message) : console.log(message)
}

export async function GET() {
  const timestamp = diagnosticsTimestamp()

  const googleModel = resolveGoogleModel(process.env.GOOGLE_MODEL)
  const apiKey = process.env.GOOGLE_API_KEY ?? ""

  const envSummary = {
    googleApiKey: apiKey ? "set" : "missing",
    googleModel,
    modelSource: "GOOGLE_MODEL",
  }

  try {
    logDiagnostic("log", "start", envSummary, {
      note: "Diagnostics shares production GOOGLE_MODEL/GOOGLE_API_KEY. No diagnostics-only defaults are used.",
    })

    if (!apiKey) {
      const error = new Error("GOOGLE_API_KEY must be set for diagnostics to mirror production")
      logDiagnostic("error", "missing-api-key", envSummary, { error: error.message })
      throw error
    }

    const client = getGoogleClient(googleModel)
    logDiagnostic("log", "client-initialized", envSummary, { modelUsed: googleModel })

    // Minimal, stable Gemini request
    const result = await client.generateContent("diagnostics-ping")

    const output = result?.response?.text?.() ?? null

    logDiagnostic("log", "generate-content:success", envSummary, {
      outputPreview: output ? output.slice(0, 100) : null,
    })

    return NextResponse.json({
      ok: true,
      timestamp,
      envSummary,
      diagnostics: {
        modelUsed: googleModel,
        output,
      },
    })
  } catch (err: any) {
    logDiagnostic("error", "failed", envSummary, {
      error: err instanceof Error ? err.message : String(err),
    })

    return jsonErrorResponse(err, "Google diagnostics failed", undefined, {
      timestamp,
      envSummary,
      error: err?.message ?? String(err),
    })
  }
}

import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel } from "@/lib/google"

// Approved exports for Route Handlers
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

// The only function allowed as the handler:
export async function GET() {
  const timestamp = new Date().toISOString()

  const envSummary = {
    googleApiKey: process.env.GOOGLE_API_KEY ? "set" : "missing",
    model: process.env.GOOGLE_MODEL ?? null,
  }

  try {
    const model = resolveGoogleModel()
    const result = await model.generateContent("ping")

    return NextResponse.json({
      ok: true,
      timestamp,
      envSummary,
      diagnostics: result ?? null,
    })
  } catch (err: any) {
    return jsonErrorResponse("google-diagnostics-error", {
      error: err.message ?? String(err),
      timestamp,
      envSummary,
    })
  }
}

import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel } from "@/lib/google"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

export async function GET() {
  const timestamp = new Date().toISOString()

  const modelName = process.env.GOOGLE_MODEL ?? ""
  const envSummary = {
    googleApiKey: process.env.GOOGLE_API_KEY ? "set" : "missing",
    model: modelName || "missing",
  }

  try {
    const model = resolveGoogleModel(modelName)
    const result = await model.generateContent("ping")

    return NextResponse.json({
      ok: true,
      timestamp,
      envSummary,
      diagnostics: result ?? null,
    })
  } catch (err: any) {
    return jsonErrorResponse("google-diagnostics-error", {
      error: err?.message ?? String(err),
      timestamp,
      envSummary,
    })
  }
}

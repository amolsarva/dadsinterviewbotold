import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel } from "@/lib/google"

// Next.js 14.2+ requires grouping static exports into a single config.
export const config = {
  runtime: "nodejs",
  dynamic: "force-dynamic",
  fetchCache: "force-no-store",
}

// All route handlers must be async.
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

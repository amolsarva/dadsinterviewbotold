import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel, getGoogleClient } from "@/lib/google"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

export async function GET() {
  const timestamp = new Date().toISOString()

  const googleModel = resolveGoogleModel(process.env.GOOGLE_MODEL)
  const apiKey = process.env.GOOGLE_API_KEY ?? ""

  const envSummary = {
    googleApiKey: apiKey ? "set" : "missing",
    googleModel,
  }

  try {
    if (!apiKey) throw new Error("GOOGLE_API_KEY must be set")

    const client = getGoogleClient(googleModel)

    // simplest "ping" request
    const result = await client.generateContent("diagnostics-ping")

    return NextResponse.json({
      ok: true,
      timestamp,
      envSummary,
      diagnostics: {
        modelUsed: googleModel,
        output:
          result?.response?.text() ??
          result?.candidates?.[0]?.content?.parts?.[0]?.text ??
          null,
      },
    })
  } catch (err: any) {
    return jsonErrorResponse("google-diagnostics-error", {
      timestamp,
      envSummary,
      error: err?.message ?? String(err),
    })
  }
}

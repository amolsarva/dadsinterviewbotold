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
    if (!apiKey) {
      throw new Error("GOOGLE_API_KEY must be set")
    }

    const client = getGoogleClient(googleModel)

    // Minimal, stable Gemini request
    const result = await client.generateContent("diagnostics-ping")

    // New Google SDK result shape always uses result.response.text()
    const output = result?.response?.text?.() ?? null

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
    // jsonErrorResponse *requires* a string, not an object
    return jsonErrorResponse(
      "google-diagnostics-error",
      `timestamp=${timestamp}; error=${err?.message ?? String(err)}`
    )
  }
}

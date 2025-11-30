import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel } from "@/lib/google"
import { GoogleGenerativeAI } from "@google/generative-ai"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

export async function GET() {
  const timestamp = new Date().toISOString()

  const modelName = resolveGoogleModel(process.env.GOOGLE_MODEL ?? "")
  const apiKey = process.env.GOOGLE_API_KEY ?? ""

  const envSummary = {
    googleApiKey: apiKey ? "set" : "missing",
    model: modelName || "missing",
  }

  try {
    if (!apiKey || !modelName) {
      throw new Error("Missing GOOGLE_API_KEY or GOOGLE_MODEL")
    }

    const genai = new GoogleGenerativeAI(apiKey)
    const model = genai.getGenerativeModel({ model: modelName })

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

import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { resolveGoogleModel } from "@/lib/google"
import OpenAI from "openai"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

export async function GET() {
  const timestamp = new Date().toISOString()

  const googleModel = resolveGoogleModel(process.env.GOOGLE_MODEL ?? "")
  const openaiKey = process.env.OPENAI_API_KEY ?? ""

  const envSummary = {
    googleModel,
    openaiKey: openaiKey ? "set" : "missing",
  }

  try {
    if (!openaiKey) throw new Error("OPENAI_API_KEY must be set")

    const client = new OpenAI({ apiKey: openaiKey })

    const completion = await client.chat.completions.create({
      model: googleModel || "gpt-4o-mini",
      messages: [{ role: "user", content: "diagnostics-ping" }],
      max_tokens: 5,
      temperature: 0,
    })

    return NextResponse.json({
      ok: true,
      timestamp,
      envSummary,
      diagnostics: {
        modelUsed: completion.model,
        output: completion.choices?.[0]?.message?.content ?? null,
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

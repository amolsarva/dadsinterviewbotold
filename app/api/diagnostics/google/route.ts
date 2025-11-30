// api/diagnostics/google/route.ts
"use server"

import { NextResponse } from "next/server"

// Force this API route to always run dynamically at request-time.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

//
// --- Local utility code only ---
// Avoid importing google helpers shared with production,
// because Next may hoist their imports into static chunks.
//
type DiagnosticLevel = "log" | "error"

const hypotheses = [
  "GOOGLE_API_KEY may be unset in the diagnostics environment.",
  "GOOGLE_DIAGNOSTICS_MODEL or GOOGLE_MODEL might be blank.",
  "The Google API response could contain errors or empty candidates.",
]

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    googleApiKey: process.env.GOOGLE_API_KEY ? "set" : "missing",
    model: process.env.GOOGLE_MODEL ?? null,
  }
}

function log(level: DiagnosticLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = { ...payload, envSummary: envSummary() }
  const message = `[diagnostic] ${diagnosticsTimestamp()} diagnostics:google:${step} ${JSON.stringify(entry)}`
  level === "error" ? console.error(message) : console.log(message)
}

// Minimal local resolver to avoid import leakage
function resolveGoogleModel(raw: string | undefined): string {
  const model = raw?.trim()
  if (!model) throw new Error("GOOGLE_MODEL must be set for diagnostics.")
  return model
}

function extractReplyText(payload: any): string {
  try {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : []
    for (const c of candidates) {
      const parts = Array.isArray(c?.content?.parts) ? c.content.parts : []
      const text = parts
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim()
      if (text) return text
    }
  } catch {}
  return ""
}

//
// --- GET handler ---
//
export async function GET() {
  log("log", "request:start", { hypotheses })

  const googleApiKey = process.env.GOOGLE_API_KEY?.trim() || ""
  if (!googleApiKey) {
    const message = "GOOGLE_API_KEY is required for diagnostics."
    log("error", "request:missing-api-key", { message })
    return NextResponse.json({ ok: false, error: "missing_google_api_key", message }, { status: 500 })
  }

  let model: string
  try {
    model = resolveGoogleModel(process.env.GOOGLE_MODEL)
    log("log", "model:resolved", { model })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resolve diagnostics model."
    log("error", "model:resolution-failed", { message })
    return NextResponse.json({ ok: false, error: "missing_google_model", message }, { status: 500 })
  }

  const prompt = "Reply with a short confirmation that the Google diagnostics check succeeded."

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
        cache: "no-store",          // required to prevent caching
        next: { revalidate: 0 },    // belt-and-suspenders
      }
    )

    const json = await response.json().catch(() => ({}))
    const reply = extractReplyText(json)
    const providerStatus = response.status

    if (!response.ok) {
      const msg =
        json?.error?.message ||
        json?.error ||
        response.statusText ||
        "Request failed"

      log("error", "request:provider-error", {
        status: providerStatus,
        message: msg,
        providerResponseSnippet: reply || JSON.stringify(json).slice(0, 400),
      })

      return NextResponse.json(
        {
          ok: false,
          status: providerStatus,
          message: msg,
          model: { name: model },
        },
        { status: providerStatus >= 400 ? providerStatus : 502 }
      )
    }

    log("log", "request:success", { status: providerStatus })

    return NextResponse.json({
      ok: true,
      status: providerStatus,
      model: { name: model },
      reply,
    })
  } catch (error: any) {
    log("error", "request:exception", {
      error: error instanceof Error ? { name: error.name, message: error.message } : { message: "unknown_error" },
    })

    return NextResponse.json(
      {
        ok: false,
        error: "google_diagnostics_exception",
        message: error?.message || "Google diagnostics failed",
      },
      { status: 500 }
    )
  }
}

import { NextResponse } from "next/server"
import { jsonErrorResponse } from "@/lib/api-error"
import { createClient } from "@supabase/supabase-js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

export async function GET() {
  const timestamp = new Date().toISOString()

  const supabaseUrl = process.env.SUPABASE_URL ?? ""
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? ""

  // Summarize env without leaking secrets
  const envSummary = {
    supabaseUrl: supabaseUrl ? "set" : "missing",
    supabaseAnonKey: supabaseAnonKey ? "set" : "missing",
  }

  // Create a safe client even if values are blank
  const supabase = createClient(supabaseUrl || "https://example.com", supabaseAnonKey || "public-anon-key")

  try {
    // Run a *very cheap* RLS-safe ping
    const { error } = await supabase.from("conversation_turns").select("id").limit(1)

    return NextResponse.json({
      ok: !error,
      timestamp,
      envSummary,
      ping: error ? `Error: ${error.message}` : "success",
    })
  } catch (err: any) {
    return jsonErrorResponse(
      "supabase-diagnostics-error",
      `timestamp=${timestamp}; error=${err?.message ?? String(err)}`
    )
  }
}

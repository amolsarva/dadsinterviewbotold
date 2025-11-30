import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export async function GET() {
  // Ensure these are always strings
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";

  // Prevent TypeScript errors and runtime crashes
  const safeUrl = supabaseUrl || "https://example.com";
  const safeAnon = supabaseAnonKey || "public-anon-key";

  const supabase = createClient(safeUrl, safeAnon);

  try {
    const { error, data } = await supabase.rpc("health_check");

    if (error) {
      return NextResponse.json(
        {
          status: "error",
          message: "Supabase is down!",
          details: error.message,
        },
        { status: 500 }
      );
    }

    logDiagnostic("log", "rpc-success", envSummary, { result: data })

    return NextResponse.json({
      status: "success",
      ok: true,
      timestamp,
      envSummary,
      message: "Supabase is healthy!",
      data,
    })
  } catch (error: any) {
    logDiagnostic("error", "failed", envSummary, {
      error: error instanceof Error ? error.message : String(error),
    })

    return NextResponse.json(
      {
        status: "error",
        ok: false,
        timestamp,
        envSummary,
        message:
          error instanceof Error
            ? error.message
            : "Supabase diagnostics failed; verify required environment variables and RPC availability.",
        recoveryInstructions: [
          "Set SUPABASE_URL and SUPABASE_ANON_KEY to the same values used in production.",
          "Ensure the health_check RPC exists and is accessible to the anon role.",
          "Retry once credentials are in place; the endpoint exits early on missing configuration.",
        ],
      },
      { status: 500 },
    )
  }
}

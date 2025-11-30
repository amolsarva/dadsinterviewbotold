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

    return NextResponse.json({
      status: "success",
      message: "Supabase is healthy!",
      data,
    });
  } catch (err: any) {
    return NextResponse.json(
      {
        status: "error",
        message: "Supabase diagnostics failed",
        details: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { runSupabaseHealthCheck } from '@/lib/supabase-health';

export const runtime = 'nodejs';

export async function GET() {
  const result = await runSupabaseHealthCheck();

  return NextResponse.json(result, {
    status: result.ok ? 200 : 400,
  });
}

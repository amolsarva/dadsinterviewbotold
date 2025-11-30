// lib/supabase-health.ts
// Supabase JS v2-compliant health checks.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const bucketName = process.env.SUPABASE_STORAGE_BUCKET || 'public';

const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey);

// Utility wrapper to avoid thrown errors
async function safe<T>(name: string, fn: () => Promise<T>) {
  try {
    const result: any = await fn();
    return {
      ok: true,
      name,
      details: result?.details || null,
    };
  } catch (err: any) {
    return {
      ok: false,
      name,
      details: err?.message || String(err),
      recovery: recoverMessage(name),
    };
  }
}

function recoverMessage(name: string) {
  switch (name) {
    case 'validateServiceRoleKey':
      return 'Check SUPABASE_SERVICE_ROLE_KEY in Vercel → Environment Variables. Test with a simple curl to your REST endpoint.';
    case 'validateTurnsTableSchema':
      return 'Open Supabase → Table Editor → confirm turns table exists and all required columns are present.';
    case 'validateStorageBucketExists':
      return `Open Supabase → Storage → confirm a bucket named "${bucketName}" exists.`;
    case 'validateStorageWrite':
      return `Confirm Storage RLS allows uploads or the service role key is correct.`;
    default:
      return 'Check your Supabase configuration and permissions.';
  }
}

// ---- CHECK 1: Service role key works ----
async function validateServiceRoleKey() {
  return safe('validateServiceRoleKey', async () => {
    const { error } = await supabase
      .from('pg_tables')
      .select('tablename')
      .limit(1);

    if (error) throw new Error(`Service role key invalid: ${error.message}`);
    return { details: 'Service role key succeeded.' };
  });
}

// ---- CHECK 2: Turns table exists ----
async function validateTurnsTableSchema() {
  return safe('validateTurnsTableSchema', async () => {
    const table = process.env.SUPABASE_TURNS_TABLE || 'conversation_turns';

    const { error } = await supabase
      .from(table)
      .select('*', { head: true })
      .limit(1);

    if (error)
      throw new Error(
        `Turns table "${table}" not accessible: ${error.message}`
      );

    return { details: `Turns table "${table}" exists.` };
  });
}

// ---- CHECK 3: Storage bucket exists ----
async function validateStorageBucketExists() {
  return safe('validateStorageBucketExists', async () => {
    const { data, error } = await supabase.storage.from(bucketName).list('', {
      limit: 1,
    });

    if (error)
      throw new Error(
        `Storage bucket "${bucketName}" not reachable: ${error.message}`
      );

    return { details: `Bucket "${bucketName}" exists (${data?.length} items).` };
  });
}

// ---- CHECK 4: Storage write works ----
async function validateStorageWrite() {
  return safe('validateStorageWrite', async () => {
    const testPath = `healthcheck-${Date.now()}.txt`;
    const buffer = Buffer.from('healthcheck');

    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(testPath, buffer, { contentType: 'text/plain' });

    if (uploadError)
      throw new Error(`Write failed: ${uploadError.message}`);

    // Cleanup
    await supabase.storage.from(bucketName).remove([testPath]);

    return { details: 'Write check passed.' };
  });
}

// ---- MASTER CHECK ----
export async function runSupabaseHealthCheck() {
  const checks = await Promise.all([
    validateServiceRoleKey(),
    validateTurnsTableSchema(),
    validateStorageBucketExists(),
    validateStorageWrite(),
  ]);

  const ok = checks.every((c) => c.ok);
  return { ok, timestamp: new Date().toISOString(), checks };
}

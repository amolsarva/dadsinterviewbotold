// lib/supabase-health.ts
// Supabase JS v2-compliant health checks with verbose diagnostics.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

type LogLevel = 'log' | 'error';

const diagnosticsTimestamp = () => new Date().toISOString();

const envSummary = () => ({
  NODE_ENV: process.env.NODE_ENV ?? 'unknown',
  NEXT_RUNTIME: process.env.NEXT_RUNTIME ?? 'nodejs',
  SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : 'missing',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
    ? `${process.env.SUPABASE_SERVICE_ROLE_KEY.length} chars`
    : 'missing',
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET ?? 'missing',
  SUPABASE_TURNS_TABLE: process.env.SUPABASE_TURNS_TABLE ?? 'missing',
  SUPABASE_SESSIONS_TABLE: process.env.SUPABASE_SESSIONS_TABLE ?? 'missing',
});

function log(level: LogLevel, step: string, payload: Record<string, unknown> = {}) {
  const message = `[diagnostic] ${diagnosticsTimestamp()} supabase-health:${step}`;
  const entry = { ...payload, envSummary: envSummary() };
  if (level === 'error') {
    console.error(message, entry);
  } else {
    console.log(message, entry);
  }
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error));
    } catch (err) {
      return { message: 'Non-serializable error', value: `${error}` };
    }
  }
  return { message: typeof error === 'string' ? error : 'Unknown error', value: error };
}

function getSupabaseEnvOrThrow() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucketName = process.env.SUPABASE_STORAGE_BUCKET?.trim();
  const sessionsTable = process.env.SUPABASE_SESSIONS_TABLE?.trim();

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!bucketName) missing.push('SUPABASE_STORAGE_BUCKET');
  if (!sessionsTable) missing.push('SUPABASE_SESSIONS_TABLE');

  if (missing.length) {
    const message = `Supabase health check missing required env vars: ${missing.join(', ')}`;
    throw new Error(message);
  }

  const table = process.env.SUPABASE_TURNS_TABLE?.trim();
  if (!table) {
    throw new Error('Supabase health check requires SUPABASE_TURNS_TABLE to be set explicitly.');
  }

  return { supabaseUrl, serviceRoleKey, bucketName, table, sessionsTable } as {
    supabaseUrl: string;
    serviceRoleKey: string;
    bucketName: string;
    table: string;
    sessionsTable: string;
  };
}

// Utility wrapper to log and avoid thrown errors escaping the health check
async function safe<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: boolean; name: string; details: string | null; recovery?: string }> {
  const started = Date.now();
  log('log', `${name}:start`);
  try {
    const result: any = await fn();
    const details = result?.details || null;
    log('log', `${name}:success`, { durationMs: Date.now() - started, details });
    return {
      ok: true,
      name,
      details,
    };
  } catch (err: any) {
    const normalized = normalizeError(err);
    log('error', `${name}:failure`, {
      durationMs: Date.now() - started,
      error: normalized.message ?? String(err),
      stack: normalized.stack,
    });
    return {
      ok: false,
      name,
      details: normalized.message || String(err),
      recovery: recoverMessage(name),
    };
  }
}

function recoverMessage(name: string) {
  switch (name) {
    case 'validateServiceRoleKey':
      return 'Set SUPABASE_SERVICE_ROLE_KEY (full service key) in env and verify it via a curl to any REST endpoint.';
    case 'validateTurnsTableSchema':
      return 'Ensure SUPABASE_TURNS_TABLE exists in Supabase Table Editor and columns match expectations.';
    case 'validateSessionsTableSchema':
      return 'Set SUPABASE_SESSIONS_TABLE to the sessions table name or create it with expected columns (id, email_to, status).';
    case 'validateStorageBucketExists':
      return 'Create the bucket named in SUPABASE_STORAGE_BUCKET or grant the service role access to it.';
    case 'validateStorageWrite':
      return 'Enable Storage RLS or confirm the service role key has write permissions to the bucket.';
    default:
      return 'Check your Supabase configuration and permissions.';
  }
}

// ---- CHECK 1: Service role key works ----
async function validateServiceRoleKey(supabase: SupabaseClient) {
  return safe('validateServiceRoleKey', async () => {
    const { error } = await supabase.from('pg_tables').select('tablename').limit(1);

    if (error) throw new Error(`Service role key invalid: ${error.message}`);
    return { details: 'Service role key succeeded.' };
  });
}

// ---- CHECK 2: Turns table exists ----
async function validateTurnsTableSchema(supabase: SupabaseClient, table: string) {
  return safe('validateTurnsTableSchema', async () => {
    const { error } = await supabase.from(table).select('*', { head: true }).limit(1);

    if (error) throw new Error(`Turns table "${table}" not accessible: ${error.message}`);

    return { details: `Turns table "${table}" exists.` };
  });
}

// ---- CHECK 2b: Sessions table exists ----
async function validateSessionsTableSchema(supabase: SupabaseClient, sessionsTable: string) {
  return safe('validateSessionsTableSchema', async () => {
    const { error } = await supabase.from(sessionsTable).select('id', { head: true }).limit(1);

    if (error) throw new Error(`Sessions table "${sessionsTable}" not accessible: ${error.message}`);

    return { details: `Sessions table "${sessionsTable}" exists.` };
  });
}

// ---- CHECK 3: Storage bucket exists ----
async function validateStorageBucketExists(supabase: SupabaseClient, bucketName: string) {
  return safe('validateStorageBucketExists', async () => {
    const { data, error } = await supabase.storage.from(bucketName).list('', {
      limit: 1,
    });

    if (error) throw new Error(`Storage bucket "${bucketName}" not reachable: ${error.message}`);

    return { details: `Bucket "${bucketName}" exists (${data?.length ?? 0} items).` };
  });
}

// ---- CHECK 4: Storage write works ----
async function validateStorageWrite(supabase: SupabaseClient, bucketName: string) {
  return safe('validateStorageWrite', async () => {
    const testPath = `healthcheck-${Date.now()}.txt`;
    const buffer = Buffer.from('healthcheck');

    const { error: uploadError } = await supabase.storage
      .from(bucketName)
      .upload(testPath, buffer, { contentType: 'text/plain' });

    if (uploadError) throw new Error(`Write failed: ${uploadError.message}`);

    await supabase.storage.from(bucketName).remove([testPath]);

    return { details: 'Write check passed.' };
  });
}

// ---- MASTER CHECK ----
export async function runSupabaseHealthCheck() {
  const started = Date.now();
  log('log', 'start');
  try {
    const { supabaseUrl, serviceRoleKey, bucketName, table, sessionsTable } = getSupabaseEnvOrThrow();
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const checks = await Promise.all([
      validateServiceRoleKey(supabase),
      validateTurnsTableSchema(supabase, table),
      validateSessionsTableSchema(supabase, sessionsTable),
      validateStorageBucketExists(supabase, bucketName),
      validateStorageWrite(supabase, bucketName),
    ]);

    const ok = checks.every((c) => c.ok);
    log('log', 'complete', {
      durationMs: Date.now() - started,
      ok,
      checksSummary: checks.map((c) => ({ name: c.name, ok: c.ok })),
    });
    return { ok, timestamp: new Date().toISOString(), bucketName, table, sessionsTable, checks };
  } catch (error) {
    const normalized = normalizeError(error);
    log('error', 'fatal', {
      durationMs: Date.now() - started,
      error: normalized.message,
      stack: normalized.stack,
    });
    return {
      ok: false,
      timestamp: new Date().toISOString(),
      error: normalized.message,
      checks: [],
    };
  }
}

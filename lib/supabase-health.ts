// lib/supabase-health.ts
// Modern Supabase JS v2-compatible health checks with clean diagnostics,
// avoiding forbidden pg_catalog introspection.

import { createClient, SupabaseClient } from '@supabase/supabase-js';

type LogLevel = 'log' | 'error';

const ts = () => new Date().toISOString();

// ----------------------------------------------------------------------
// ENV SUMMARY + LOGGING
// ----------------------------------------------------------------------

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
  const prefix = `[diagnostic] ${ts()} supabase-health:${step}`;
  const entry = { ...payload, envSummary: envSummary() };
  level === 'error' ? console.error(prefix, entry) : console.log(prefix, entry);
}

// ----------------------------------------------------------------------
// ERROR NORMALIZATION
// ----------------------------------------------------------------------

function normalizeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.parse(JSON.stringify(error));
    } catch {
      return { message: 'Non-serializable error', value: String(error) };
    }
  }
  return { message: typeof error === 'string' ? error : 'Unknown error', value: error };
}

// ----------------------------------------------------------------------
// STRICT ENV EXTRACTION (TYPE-SAFE)
// ----------------------------------------------------------------------

export function requireSupabaseEnv(): {
  supabaseUrl: string;
  serviceRoleKey: string;
  bucketName: string;
  sessionsTable: string;
  turnsTable: string;
} {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucketName = process.env.SUPABASE_STORAGE_BUCKET?.trim();
  const sessionsTable = process.env.SUPABASE_SESSIONS_TABLE?.trim();
  const turnsTable = process.env.SUPABASE_TURNS_TABLE?.trim();

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!bucketName) missing.push('SUPABASE_STORAGE_BUCKET');
  if (!sessionsTable) missing.push('SUPABASE_SESSIONS_TABLE');
  if (!turnsTable) missing.push('SUPABASE_TURNS_TABLE');

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  return {
    supabaseUrl,
    serviceRoleKey,
    bucketName,
    sessionsTable,
    turnsTable,
  };
}

// ----------------------------------------------------------------------
// SAFE WRAPPER
// ----------------------------------------------------------------------

async function safe<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<{ ok: boolean; name: string; details: string | null; recovery?: string }> {
  const started = Date.now();
  log('log', `${name}:start`);
  try {
    const result: any = await fn();
    log('log', `${name}:success`, {
      durationMs: Date.now() - started,
      details: result?.details ?? null,
    });
    return { ok: true, name, details: result?.details ?? null };
  } catch (err) {
    const normalized = normalizeError(err);
    log('error', `${name}:failure`, {
      durationMs: Date.now() - started,
      error: normalized.message,
      stack: normalized.stack,
    });
    return {
      ok: false,
      name,
      details: normalized.message,
      recovery: recoveryHint(name),
    };
  }
}

function recoveryHint(name: string) {
  switch (name) {
    case 'validateServiceRoleKey':
      return 'Ensure SUPABASE_SERVICE_ROLE_KEY is the full service-role secret.';
    case 'validateTurnsTableSchema':
      return 'Verify SUPABASE_TURNS_TABLE exists and is readable by service role.';
    case 'validateSessionsTableSchema':
      return 'Verify SUPABASE_SESSIONS_TABLE exists and has basic columns.';
    case 'validateStorageBucketExists':
      return 'Ensure the bucket exists and service role has access.';
    case 'validateStorageWrite':
      return 'Check Storage RLS or service role permissions.';
    default:
      return 'General Supabase configuration issue.';
  }
}

// ----------------------------------------------------------------------
// CHECK 1: Service role key validation
// ----------------------------------------------------------------------

async function validateServiceRoleKey(supabase: SupabaseClient, sessionsTable: string) {
  return safe('validateServiceRoleKey', async () => {
    const { error } = await supabase
      .from(sessionsTable)
      .select('id', { head: true })
      .limit(1);

    if (error)
      throw new Error(`Service role key failed (table read): ${error.message}`);

    return { details: 'Service role key succeeded.' };
  });
}

// ----------------------------------------------------------------------
// CHECK 2: Turns table exists
// ----------------------------------------------------------------------

async function validateTurnsTableSchema(supabase: SupabaseClient, table: string) {
  return safe('validateTurnsTableSchema', async () => {
    const { error } = await supabase.from(table).select('*', { head: true }).limit(1);
    if (error) throw new Error(`Turns table "${table}" not accessible: ${error.message}`);
    return { details: `Turns table "${table}" exists.` };
  });
}

// ----------------------------------------------------------------------
// CHECK 3: Sessions table exists
// ----------------------------------------------------------------------

async function validateSessionsTableSchema(supabase: SupabaseClient, sessionsTable: string) {
  return safe('validateSessionsTableSchema', async () => {
    const { error } = await supabase
      .from(sessionsTable)
      .select('id', { head: true })
      .limit(1);

    if (error)
      throw new Error(`Sessions table "${sessionsTable}" not accessible: ${error.message}`);

    return { details: `Sessions table "${sessionsTable}" exists.` };
  });
}

// ----------------------------------------------------------------------
// CHECK 4: Bucket exists
// ----------------------------------------------------------------------

async function validateStorageBucketExists(supabase: SupabaseClient, bucket: string) {
  return safe('validateStorageBucketExists', async () => {
    const { error } = await supabase.storage.from(bucket).list('', { limit: 1 });
    if (error) throw new Error(`Bucket "${bucket}" not reachable: ${error.message}`);
    return { details: `Bucket "${bucket}" exists.` };
  });
}

// ----------------------------------------------------------------------
// CHECK 5: Bucket write-test
// ----------------------------------------------------------------------

async function validateStorageWrite(supabase: SupabaseClient, bucket: string) {
  return safe('validateStorageWrite', async () => {
    const testPath = `healthcheck-${Date.now()}.txt`;
    const buffer = Buffer.from('healthcheck');

    const { error: writeErr } = await supabase.storage
      .from(bucket)
      .upload(testPath, buffer, { contentType: 'text/plain' });

    if (writeErr) throw new Error(`Write failed: ${writeErr.message}`);

    await supabase.storage.from(bucket).remove([testPath]);
    return { details: 'Write check passed.' };
  });
}

// ----------------------------------------------------------------------
// MASTER CHECK
// ----------------------------------------------------------------------

export async function runSupabaseHealthCheck() {
  const started = Date.now();
  log('log', 'start');

  try {
    const { supabaseUrl, serviceRoleKey, bucketName, turnsTable, sessionsTable } =
      requireSupabaseEnv();

    // TypeScript is now satisfied: strings guaranteed.
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const checks = await Promise.all([
      validateServiceRoleKey(supabase, sessionsTable),
      validateTurnsTableSchema(supabase, turnsTable),
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

    return {
      ok,
      timestamp: ts(),
      bucketName,
      turnsTable,
      sessionsTable,
      checks,
    };
  } catch (error) {
    const norm = normalizeError(error);
    log('error', 'fatal', {
      durationMs: Date.now() - started,
      error: norm.message,
      stack: norm.stack,
    });
    return {
      ok: false,
      timestamp: ts(),
      error: norm.message,
      checks: [],
    };
  }
}

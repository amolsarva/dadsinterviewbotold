import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { describeDatabaseMetaEnv, getConversationTurnsTable } from '@/db/meta'
import { jsonErrorResponse } from '@/lib/api-error'

export const runtime = 'nodejs'

type LogLevel = 'log' | 'error'

type SessionStep = {
  id: string
  label: string
  ok: boolean
  status?: number
  detail?: string
  hint?: string
}

function nowISO() {
  return new Date().toISOString()
}

function envSummary() {
  return describeDatabaseMetaEnv()
}

function log(level: LogLevel, step: string, payload?: Record<string, unknown>) {
  const entry = {
    step,
    timestamp: nowISO(),
    env: envSummary(),
    ...(payload ?? {}),
  }
  const serialized = `[diagnostic] ${nowISO()} session-diagnostics:${step}`
  if (level === 'error') {
    console.error(serialized, entry)
  } else {
    console.log(serialized, entry)
  }
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.parse(JSON.stringify(error))
    } catch {
      return { value: error }
    }
  }
  return { message: typeof error === 'string' ? error : 'Unknown error', value: error }
}

function requireEnv(name: string) {
  const raw = process.env[name]
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) {
    const message = `${name} is required for session diagnostics.`
    log('error', 'env:missing', { name, message })
    throw new Error(message)
  }
  return value
}

export async function POST() {
  const started = Date.now()
  const steps: SessionStep[] = []
  const sessionId = `diagnostic-session-${Date.now().toString(36)}`

  log('log', 'request:start', { method: 'POST', sessionId })

  try {
    const supabaseUrl = requireEnv('SUPABASE_URL')
    const supabaseServiceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
    const table = getConversationTurnsTable()
    const client = createClient(supabaseUrl, supabaseServiceRoleKey)

    steps.push({
      id: 'env',
      label: 'Supabase env vars present',
      ok: true,
      detail: `Table ${table}; URL ${supabaseUrl}`,
    })

    log('log', 'table:probe:start', { table })
    const probe = await client.from(table).select('id').limit(1)
    if (probe.error) {
      const detail = probe.error.message || 'Unknown table access error'
      log('error', 'table:probe:failure', { table, status: probe.status, detail })
      steps.push({
        id: 'table_probe',
        label: 'Turns table probe',
        ok: false,
        status: probe.status ?? undefined,
        detail,
        hint: 'Verify SUPABASE_TURNS_TABLE matches the table created in Supabase.',
      })
      return NextResponse.json(
        {
          ok: false,
          sessionId,
          table,
          steps,
          message: `Turns table probe failed: ${detail}`,
          hints: ['Double-check SUPABASE_TURNS_TABLE and its RLS policies.', 'Confirm service role key has insert access.'],
        },
        { status: 400 },
      )
    }

    steps.push({
      id: 'table_probe',
      label: 'Turns table probe',
      ok: true,
      detail: 'Select head query succeeded',
    })

    const payload = {
      session_id: sessionId,
      turn: 1,
      transcript: 'diagnostic turn payload',
      assistant_reply: null,
      provider: 'diagnostic',
      manifest_url: null,
      user_audio_url: null,
      assistant_audio_url: null,
      duration_ms: 0,
      assistant_duration_ms: 0,
    }

    log('log', 'insert:start', { table, payload })
    const insertResult = await client.from(table).insert(payload).select('id').single()
    if (insertResult.error || !insertResult.data) {
      const detail = insertResult.error?.message || 'Insert returned no data'
      log('error', 'insert:failure', {
        table,
        status: insertResult.status,
        detail,
      })
      steps.push({
        id: 'insert',
        label: 'Insert diagnostic row',
        ok: false,
        status: insertResult.status ?? undefined,
        detail,
        hint: 'Ensure table columns match ConversationTurnInsert and service role has INSERT privilege.',
      })
      return NextResponse.json(
        {
          ok: false,
          sessionId,
          table,
          steps,
          message: `Failed to insert diagnostic turn: ${detail}`,
          hints: [
            'Verify SUPABASE_TURNS_TABLE schema has session_id, turn, transcript, and assistant_reply columns.',
            'Check Supabase Auth policies for service role inserts.',
          ],
        },
        { status: 400 },
      )
    }

    const insertedId = insertResult.data.id
    steps.push({
      id: 'insert',
      label: 'Insert diagnostic row',
      ok: true,
      status: insertResult.status ?? undefined,
      detail: `Inserted row ${insertedId}`,
    })

    log('log', 'cleanup:start', { table, sessionId })
    const cleanup = await client.from(table).delete().eq('session_id', sessionId)
    if (cleanup.error) {
      log('error', 'cleanup:failure', {
        table,
        sessionId,
        status: cleanup.status,
        detail: cleanup.error.message,
      })
      steps.push({
        id: 'cleanup',
        label: 'Cleanup diagnostic row',
        ok: false,
        status: cleanup.status ?? undefined,
        detail: cleanup.error.message,
        hint: 'Delete rows with session_id manually if cleanup keeps failing.',
      })
    } else {
      steps.push({ id: 'cleanup', label: 'Cleanup diagnostic row', ok: true, detail: 'Removed diagnostic row' })
    }

    log('log', 'complete', {
      durationMs: Date.now() - started,
      table,
      sessionId,
      cleanupStatus: cleanup.status ?? null,
    })

    return NextResponse.json({
      ok: true,
      sessionId,
      table,
      insertedId,
      cleanupStatus: cleanup.status ?? null,
      steps,
      message: 'Session ID and Supabase turn insertion verified.',
      hints: [
        'Share the sessionId and failing step details when reporting issues.',
        'Ensure Supabase env vars are identical across server and client.',
      ],
    })
  } catch (error) {
    const normalized = normalizeError(error)
    log('error', 'fatal', { error: normalized, durationMs: Date.now() - started })
    return jsonErrorResponse(error, 'Session diagnostics failed')
  }
}

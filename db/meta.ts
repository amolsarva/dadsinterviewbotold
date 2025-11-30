import { getSupabaseClient, logBlobDiagnostic, snapshotSupabaseEnv } from '@/utils/blob-env'

const TURN_TABLE_FALLBACK = 'conversation_turns'
const REQUIRED_COLUMNS = ['session_id', 'turn', 'transcript'] as const

type TableColumn = {
  table_name: string
  column_name: string
}

type InformationSchemaColumnsTable = {
  Row: TableColumn
  Insert: TableColumn
  Update: Partial<TableColumn>
  Relationships: []
}

type TableShape = {
  table: string
  columns: string[]
}

let cachedTurnsTable: string | null = null
let tableDiscoveryPromise: Promise<string> | null = null

function diagnosticsTimestamp() {
  return new Date().toISOString()
}

function envSummary() {
  const snapshot = snapshotSupabaseEnv()
  return {
    supabaseUrl: snapshot.SUPABASE_URL ? 'set' : 'missing',
    supabaseServiceRoleKey: snapshot.SUPABASE_SERVICE_ROLE_KEY
      ? `${snapshot.SUPABASE_SERVICE_ROLE_KEY.length} chars`
      : null,
    supabaseBucket: snapshot.SUPABASE_STORAGE_BUCKET ?? null,
    envTurnsTable: process.env.SUPABASE_TURNS_TABLE?.trim() || null,
    publicTurnsTable: process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE?.trim() || null,
    cachedTurnsTable,
    fallback: TURN_TABLE_FALLBACK,
  }
}

function logMeta(level: 'log' | 'error', event: string, payload?: Record<string, unknown>) {
  const entry = { event, env: envSummary(), ...(payload ?? {}) }
  const message = `[diagnostic] ${diagnosticsTimestamp()} db-meta ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

function markCached(table: string) {
  cachedTurnsTable = table
  logMeta('log', 'turn-table:cached', { table })
  return table
}

function validateEnvTableHint(table: string | undefined | null) {
  if (!table) return null
  const normalized = table.trim()
  if (!normalized.length) return null
  return normalized
}

function shapeFromColumns(rows: TableColumn[]): TableShape[] {
  const grouped = rows.reduce<Record<string, Set<string>>>((acc, row) => {
    if (!acc[row.table_name]) {
      acc[row.table_name] = new Set()
    }
    acc[row.table_name].add(row.column_name)
    return acc
  }, {})

  return Object.entries(grouped).map(([table, columns]) => ({ table, columns: Array.from(columns).sort() }))
}

function isTurnsLike(shape: TableShape) {
  return REQUIRED_COLUMNS.every((column) => shape.columns.includes(column))
}

async function listTableColumns() {
  const client = getSupabaseClient()
  logMeta('log', 'introspect:tables:start')
  const { data, error, status } = await client
    .from<'information_schema.columns', InformationSchemaColumnsTable>('information_schema.columns')
    .select('table_name,column_name')
    .eq('table_schema', 'public')

  if (error) {
    logMeta('error', 'introspect:tables:error', { status, error: error.message })
    throw new Error(`Failed to list Supabase tables: ${error.message}`)
  }
  if (!data) {
    logMeta('error', 'introspect:tables:empty', { status })
    throw new Error('Supabase metadata query returned no data for tables')
  }
  const shapes = shapeFromColumns(data)
  logMeta('log', 'introspect:tables:success', {
    status,
    tableCount: shapes.length,
    turnsLike: shapes.filter(isTurnsLike).map((shape) => shape.table),
  })
  return shapes
}

function pickTurnsTable(shapes: TableShape[]): string {
  const explicit = validateEnvTableHint(process.env.SUPABASE_TURNS_TABLE)
  if (explicit) {
    const found = shapes.find((shape) => shape.table === explicit)
    if (found && isTurnsLike(found)) {
      logMeta('log', 'turn-table:env-selected', { table: explicit, source: 'SUPABASE_TURNS_TABLE' })
      return explicit
    }
    logMeta('error', 'turn-table:env-mismatch', {
      table: explicit,
      source: 'SUPABASE_TURNS_TABLE',
      message: 'Provided SUPABASE_TURNS_TABLE does not match an introspected turns-like table.',
    })
    throw new Error('SUPABASE_TURNS_TABLE does not point to a turns-like table; update configuration.')
  }

  const publicHint = validateEnvTableHint(process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE)
  if (publicHint) {
    const found = shapes.find((shape) => shape.table === publicHint)
    if (found && isTurnsLike(found)) {
      logMeta('log', 'turn-table:env-selected', { table: publicHint, source: 'NEXT_PUBLIC_SUPABASE_TURNS_TABLE' })
      return publicHint
    }
    logMeta('error', 'turn-table:env-mismatch', {
      table: publicHint,
      source: 'NEXT_PUBLIC_SUPABASE_TURNS_TABLE',
      message: 'NEXT_PUBLIC_SUPABASE_TURNS_TABLE did not match an introspected turns-like table.',
    })
  }

  const exact = shapes.find((shape) => shape.table === TURN_TABLE_FALLBACK)
  if (exact && isTurnsLike(exact)) {
    logMeta('log', 'turn-table:introspected:exact', { table: TURN_TABLE_FALLBACK })
    return TURN_TABLE_FALLBACK
  }

  const firstTurns = shapes.find((shape) => isTurnsLike(shape))
  if (firstTurns) {
    logMeta('log', 'turn-table:introspected:candidate', { table: firstTurns.table })
    return firstTurns.table
  }

  logMeta('error', 'turn-table:introspected:fallback', {
    table: TURN_TABLE_FALLBACK,
    message: 'No turns-like table detected; falling back to configured conversation_turns.',
  })
  return TURN_TABLE_FALLBACK
}

export async function getConversationTurnsTable(): Promise<string> {
  if (cachedTurnsTable) return cachedTurnsTable
  if (!tableDiscoveryPromise) {
    tableDiscoveryPromise = (async () => {
      const shapes = await listTableColumns()
      const table = pickTurnsTable(shapes)
      return markCached(table)
    })().catch((error) => {
      logMeta('error', 'turn-table:resolve:error', {
        error: error instanceof Error ? error.message : 'unknown error',
      })
      throw error instanceof Error ? error : new Error('Failed to resolve conversation turns table')
    })
  }
  const table = await tableDiscoveryPromise
  return table
}

export function getCachedConversationTurnsTable(): string | null {
  return cachedTurnsTable
}

export function describeDatabaseMetaEnv() {
  const snapshot = snapshotSupabaseEnv()
  const details = {
    supabaseUrl: snapshot.SUPABASE_URL ? 'set' : 'missing',
    supabaseServiceRoleKey: snapshot.SUPABASE_SERVICE_ROLE_KEY
      ? `${snapshot.SUPABASE_SERVICE_ROLE_KEY.length} chars`
      : null,
    supabaseBucket: snapshot.SUPABASE_STORAGE_BUCKET ?? null,
    envTurnsTable: process.env.SUPABASE_TURNS_TABLE?.trim() || null,
    publicTurnsTable: process.env.NEXT_PUBLIC_SUPABASE_TURNS_TABLE?.trim() || null,
    cachedTurnsTable,
    fallback: TURN_TABLE_FALLBACK,
  }
  logBlobDiagnostic('log', 'db-meta:env', details)
  return details
}

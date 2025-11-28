import { assertSupabaseEnv, describeSupabaseEnvSnapshot, getSupabaseBucket, getSupabaseClient, logBlobDiagnostic } from '@/utils/blob-env'

export const BLOB_PROXY_PREFIX = '/api/blob/'

export type PutBlobOptions = {
  access?: 'public'
  addRandomSuffix?: boolean
  cacheControlMaxAge?: number
}

export type ListedBlob = {
  pathname: string
  url: string
  downloadUrl: string
  uploadedAt?: Date
  size?: number
  metadata?: Record<string, unknown>
}

export type ListCommandOptions = {
  prefix?: string
  limit?: number
  cursor?: string | null
}

export type ListBlobResult = {
  blobs: ListedBlob[]
  nextCursor: string | null
  hasMore?: boolean
}

export type ReadBlobResult = {
  buffer: Buffer
  contentType: string
  uploadedAt?: string
  etag?: string
  size?: number
  cacheControl?: string
}

export function primeNetlifyBlobContextFromHeaders(headers: Headers | Record<string, unknown> | null | undefined) {
  logBlobDiagnostic('log', 'supabase-context:headers-ignored', {
    note: 'Supabase storage uses environment configuration; headers are logged for traceability only.',
    headerKeys: headers && typeof headers === 'object' ? Object.keys(headers) : [],
  })
  return true
}

export function getBlobToken(): string | undefined {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (key && key.trim().length) {
    logBlobDiagnostic('log', 'supabase-token:resolved', { length: key.length })
    return key
  }
  logBlobDiagnostic('error', 'supabase-token:missing', { note: 'SUPABASE_SERVICE_ROLE_KEY is required for storage access.' })
  return undefined
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, '')
  return trimmed
}

function applyRandomSuffix(path: string): string {
  if (!path) return path
  const normalized = normalizePath(path)
  const lastSlash = normalized.lastIndexOf('/')
  const directory = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : ''
  const filename = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  const dotIndex = filename.lastIndexOf('.')
  const suffix = `-${Math.random().toString(36).slice(2, 10)}`
  if (dotIndex > 0) {
    return `${directory}${filename.slice(0, dotIndex)}${suffix}${filename.slice(dotIndex)}`
  }
  return `${directory}${filename}${suffix}`
}

function pathFromUrl(pathOrUrl: string): string {
  try {
    const parsed = new URL(pathOrUrl)
    return parsed.pathname.replace(/^\/+/, '')
  } catch {
    return normalizePath(pathOrUrl)
  }
}

function getClientAndBucket() {
  const client = getSupabaseClient()
  const bucket = getSupabaseBucket()
  return { client, bucket }
}

type BucketStatus = { exists: boolean; checkedAt: number }

const bucketStatusCache = new Map<string, BucketStatus>()

async function ensureBucketExists(client: ReturnType<typeof getSupabaseClient>, bucket: string, forceRefresh = false) {
  const cached = bucketStatusCache.get(bucket)
  if (cached && cached.exists && !forceRefresh) {
    logBlobDiagnostic('log', 'supabase-bucket:cached', { bucket, checkedAt: new Date(cached.checkedAt).toISOString() })
    return true
  }

  logBlobDiagnostic('log', 'supabase-bucket:verify-start', { bucket })
  const { data, error: getError } = await client.storage.getBucket(bucket)
  if (!getError && data) {
    bucketStatusCache.set(bucket, { exists: true, checkedAt: Date.now() })
    logBlobDiagnostic('log', 'supabase-bucket:exists', { bucket })
    return true
  }

  const getStatus = (getError as any)?.status
  if (getError && getStatus !== 404) {
    logBlobDiagnostic('error', 'supabase-bucket:verify-failure', { bucket, error: getError.message, status: getStatus })
    throw new Error(`Failed to verify Supabase bucket ${bucket}: ${getError.message}`)
  }

  logBlobDiagnostic('log', 'supabase-bucket:create-start', { bucket })
  const { error: createError } = await client.storage.createBucket(bucket, { public: false })
  const createStatus = (createError as any)?.status
  if (createError) {
    logBlobDiagnostic('error', 'supabase-bucket:create-failure', { bucket, error: createError.message, status: createStatus })
    throw new Error(`Failed to create Supabase bucket ${bucket}: ${createError.message}`)
  }
  bucketStatusCache.set(bucket, { exists: true, checkedAt: Date.now() })
  logBlobDiagnostic('log', 'supabase-bucket:create-success', { bucket })
  return true
}

type RecoveryAction =
  | 'none'
  | 'bucket-created'
  | 'retry-conflict'
  | 'retry-transient'
  | 'retry-bucket-creation'

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function executeWithRecovery<T>(
  operation: string,
  bucket: string,
  pathname: string,
  fn: () => Promise<{ data: T | null; error: { message: string; status?: number } | null }>,
) {
  const client = getSupabaseClient()
  await ensureBucketExists(client, bucket)

  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let recovery: RecoveryAction = 'none'
    const attemptMeta = { attempt, maxAttempts, bucket, pathname, operation }
    logBlobDiagnostic('log', 'supabase-operation:attempt', attemptMeta)
    const { data, error } = await fn()
    if (!error) {
      logBlobDiagnostic('log', 'supabase-operation:success', { ...attemptMeta, recovery })
      return { data, recovery }
    }

    const status = error.status ?? null
    const code = (error as any).code
    const message = error.message || ''
    const isNotFound = status === 404
    const isConflict = status === 409 || code === 'duplicate' || /duplicate/i.test(message)
    const isTransient = status === 0 || (status !== null && status >= 500)

    if (isNotFound) {
      recovery = 'retry-bucket-creation'
      logBlobDiagnostic('error', 'supabase-operation:bucket-missing', { ...attemptMeta, status, error: error.message })
      await ensureBucketExists(client, bucket, true)
    } else if (isConflict) {
      recovery = 'retry-conflict'
      logBlobDiagnostic('error', 'supabase-operation:conflict', { ...attemptMeta, status, error: error.message })
      const { error: removeError } = await client.storage.from(bucket).remove([pathname])
      const removeStatus = (removeError as any)?.status
      if (removeError) {
        logBlobDiagnostic('error', 'supabase-operation:conflict-removal-failed', {
          ...attemptMeta,
          status: removeStatus,
          error: removeError.message,
        })
      } else {
        logBlobDiagnostic('log', 'supabase-operation:conflict-removed', { ...attemptMeta })
      }
    } else if (isTransient) {
      recovery = 'retry-transient'
      logBlobDiagnostic('error', 'supabase-operation:transient', { ...attemptMeta, status, error: error.message })
    } else {
      logBlobDiagnostic('error', 'supabase-operation:unrecoverable', { ...attemptMeta, status, error: error.message })
      throw new Error(`Supabase ${operation} failed for ${pathname}: ${error.message}`)
    }

    if (attempt === maxAttempts) {
      throw new Error(`Supabase ${operation} failed after ${maxAttempts} attempts for ${pathname}: ${error.message}`)
    }

    const backoffMs = Math.pow(2, attempt) * 250
    logBlobDiagnostic('log', 'supabase-operation:backoff', { ...attemptMeta, backoffMs, recovery })
    await delay(backoffMs)
  }

  throw new Error(`Supabase ${operation} failed for ${pathname}`)
}

export function getBlobEnvironment() {
  assertSupabaseEnv({ note: 'Reporting Supabase storage environment' })
  return {
    provider: 'supabase' as const,
    configured: true as const,
    env: describeSupabaseEnvSnapshot(),
  }
}

export async function putBlobFromBuffer(
  path: string,
  buffer: Buffer,
  contentType: string,
  options: PutBlobOptions = {},
) {
  const targetPath = options.addRandomSuffix ? applyRandomSuffix(path) : normalizePath(path)
  const { client, bucket } = getClientAndBucket()
  logBlobDiagnostic('log', 'supabase-put:start', {
    path: targetPath,
    bucket,
    size: buffer.byteLength,
    options,
  })
  const { data, recovery } = await executeWithRecovery(
    'upload',
    bucket,
    targetPath,
    () =>
      client.storage.from(bucket).upload(targetPath, buffer, {
        contentType: contentType || 'application/octet-stream',
        cacheControl: options.cacheControlMaxAge ? `${options.cacheControlMaxAge}` : undefined,
        upsert: true,
      }),
  )
  const publicUrl = client.storage.from(bucket).getPublicUrl(targetPath).data.publicUrl
  logBlobDiagnostic('log', 'supabase-put:success', { path: targetPath, bucket, data, publicUrl, recovery })
  return {
    pathname: targetPath,
    url: publicUrl,
    downloadUrl: publicUrl,
    etag: data?.path ?? targetPath,
  }
}

export async function listBlobs(options: ListCommandOptions = {}): Promise<ListBlobResult> {
  const { client, bucket } = getClientAndBucket()
  logBlobDiagnostic('log', 'supabase-list:start', { bucket, options })
  if (options.cursor) {
    logBlobDiagnostic('error', 'supabase-list:cursor-unsupported', {
      cursor: options.cursor,
      note: 'Supabase storage API does not support cursor-based pagination; cursor will be ignored.',
    })
  }
  const { data } = await executeWithRecovery(
    'list',
    bucket,
    options.prefix ?? '',
    () => client.storage.from(bucket).list(options.prefix ?? '', { limit: options.limit ?? 100 }),
  )
  const blobs: ListedBlob[] = (data || []).map((entry) => {
    const pathname = normalizePath(`${options.prefix ?? ''}${options.prefix ? '/' : ''}${entry.name}`)
    const publicUrl = client.storage.from(bucket).getPublicUrl(pathname).data.publicUrl
    return {
      pathname,
      url: publicUrl,
      downloadUrl: publicUrl,
      uploadedAt: entry.created_at ? new Date(entry.created_at) : undefined,
      size: entry.metadata?.size ?? (entry as any).size,
      metadata: entry.metadata ?? undefined,
    }
  })
  logBlobDiagnostic('log', 'supabase-list:success', { bucket, count: blobs.length })
  return { blobs, nextCursor: null, hasMore: false }
}

export async function deleteBlobsByPrefix(prefix: string): Promise<number> {
  const normalized = normalizePath(prefix)
  const { client, bucket } = getClientAndBucket()
  const list = await listBlobs({ prefix: normalized, limit: 1000 })
  const paths = list.blobs.map((blob) => blob.pathname)
  logBlobDiagnostic('log', 'supabase-delete-prefix:start', { bucket, prefix: normalized, count: paths.length })
  if (!paths.length) return 0
  const { data } = await executeWithRecovery('delete-prefix', bucket, normalized, () => client.storage.from(bucket).remove(paths))
  logBlobDiagnostic('log', 'supabase-delete-prefix:success', { bucket, deleted: paths.length })
  return paths.length
}

export async function deleteBlob(pathOrUrl: string): Promise<boolean> {
  const pathname = pathFromUrl(pathOrUrl)
  const { client, bucket } = getClientAndBucket()
  logBlobDiagnostic('log', 'supabase-delete:start', { bucket, pathname })
  await executeWithRecovery('delete', bucket, pathname, () => client.storage.from(bucket).remove([pathname]))
  logBlobDiagnostic('log', 'supabase-delete:success', { bucket, pathname })
  return true
}

export async function readBlob(pathOrUrl: string): Promise<ReadBlobResult | null> {
  const pathname = pathFromUrl(pathOrUrl)
  const { client, bucket } = getClientAndBucket()
  logBlobDiagnostic('log', 'supabase-read:start', { bucket, pathname })
  const { data } = await executeWithRecovery('download', bucket, pathname, () => client.storage.from(bucket).download(pathname))
  if (!data) {
    throw new Error(`Supabase download returned empty payload for ${pathname}`)
  }
  const arrayBuffer = await data.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const contentType = (data as Blob).type || 'application/octet-stream'
  logBlobDiagnostic('log', 'supabase-read:success', { bucket, pathname, size: buffer.byteLength })
  return {
    buffer,
    contentType,
    size: buffer.byteLength,
  }
}

export async function blobHealth() {
  try {
    const { client, bucket } = getClientAndBucket()
    const { error } = await client.storage.from(bucket).list('', { limit: 1 })
    if (error) {
      logBlobDiagnostic('error', 'supabase-health:failure', { bucket, error: error.message })
      return { ok: false, mode: 'supabase', error: error.message }
    }
    logBlobDiagnostic('log', 'supabase-health:success', { bucket })
    return { ok: true, mode: 'supabase', bucket }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logBlobDiagnostic('error', 'supabase-health:exception', { error: message })
    return { ok: false, mode: 'supabase', error: message }
  }
}

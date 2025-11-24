import { assertSupabaseEnv, describeSupabaseEnvSnapshot, getSupabaseBucket, getSupabaseClient, logBlobDiagnostic } from '@/utils/blob-env'

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
}

export type ListBlobResult = {
  blobs: ListedBlob[]
  nextCursor: string | null
}

export type ReadBlobResult = {
  buffer: Buffer
  contentType: string
  uploadedAt?: string
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
  const { error, data } = await client.storage.from(bucket).upload(targetPath, buffer, {
    contentType: contentType || 'application/octet-stream',
    cacheControl: options.cacheControlMaxAge ? `${options.cacheControlMaxAge}` : undefined,
    upsert: true,
  })
  if (error) {
    logBlobDiagnostic('error', 'supabase-put:failure', { path: targetPath, bucket, error: error.message })
    throw new Error(`Supabase upload failed for ${targetPath}: ${error.message}`)
  }
  const publicUrl = client.storage.from(bucket).getPublicUrl(targetPath).data.publicUrl
  logBlobDiagnostic('log', 'supabase-put:success', { path: targetPath, bucket, data, publicUrl })
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
  const { data, error } = await client.storage.from(bucket).list(options.prefix ?? '', {
    limit: options.limit ?? 100,
  })
  if (error) {
    logBlobDiagnostic('error', 'supabase-list:failure', { bucket, error: error.message })
    throw new Error(`Supabase list failed: ${error.message}`)
  }
  const blobs: ListedBlob[] = (data || []).map((entry) => {
    const pathname = normalizePath(`${options.prefix ?? ''}${options.prefix ? '/' : ''}${entry.name}`)
    const publicUrl = client.storage.from(bucket).getPublicUrl(pathname).data.publicUrl
    return {
      pathname,
      url: publicUrl,
      downloadUrl: publicUrl,
      uploadedAt: entry.created_at ? new Date(entry.created_at) : undefined,
      size: entry.metadata?.size ?? entry.size,
      metadata: entry.metadata ?? undefined,
    }
  })
  logBlobDiagnostic('log', 'supabase-list:success', { bucket, count: blobs.length })
  return { blobs, nextCursor: null }
}

export async function deleteBlobsByPrefix(prefix: string): Promise<number> {
  const normalized = normalizePath(prefix)
  const { client, bucket } = getClientAndBucket()
  const list = await listBlobs({ prefix: normalized, limit: 1000 })
  const paths = list.blobs.map((blob) => blob.pathname)
  logBlobDiagnostic('log', 'supabase-delete-prefix:start', { bucket, prefix: normalized, count: paths.length })
  if (!paths.length) return 0
  const { error } = await client.storage.from(bucket).remove(paths)
  if (error) {
    logBlobDiagnostic('error', 'supabase-delete-prefix:failure', { bucket, error: error.message })
    throw new Error(`Supabase delete by prefix failed: ${error.message}`)
  }
  logBlobDiagnostic('log', 'supabase-delete-prefix:success', { bucket, deleted: paths.length })
  return paths.length
}

export async function deleteBlob(pathOrUrl: string): Promise<boolean> {
  const pathname = pathFromUrl(pathOrUrl)
  const { client, bucket } = getClientAndBucket()
  logBlobDiagnostic('log', 'supabase-delete:start', { bucket, pathname })
  const { error } = await client.storage.from(bucket).remove([pathname])
  if (error) {
    logBlobDiagnostic('error', 'supabase-delete:failure', { bucket, pathname, error: error.message })
    throw new Error(`Supabase delete failed for ${pathname}: ${error.message}`)
  }
  logBlobDiagnostic('log', 'supabase-delete:success', { bucket, pathname })
  return true
}

export async function readBlob(pathOrUrl: string): Promise<ReadBlobResult | null> {
  const pathname = pathFromUrl(pathOrUrl)
  const { client, bucket } = getClientAndBucket()
  logBlobDiagnostic('log', 'supabase-read:start', { bucket, pathname })
  const { data, error } = await client.storage.from(bucket).download(pathname)
  if (error) {
    logBlobDiagnostic('error', 'supabase-read:failure', { bucket, pathname, error: error.message })
    throw new Error(`Supabase download failed for ${pathname}: ${error.message}`)
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

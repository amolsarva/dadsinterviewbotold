"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { createSessionRecorder, type SessionRecorder } from '@/lib/session-recorder'
import { buildScopedPath, normalizeHandle } from '@/lib/user-scope'
import { resolveErrorMessage, type UploadResultPayload } from '@/types/error-types'

type BlobStatus = {
  env: any
  health: any
  fetchedAt: string
}

type BlobListItem = {
  pathname: string
  url: string
  downloadUrl: string
  uploadedAt?: string | Date
  size?: number
}

type BlobListResponse = {
  blobs: BlobListItem[]
  hasMore: boolean
  cursor?: string
}

type HistoryClearResult = {
  ok: boolean
  deleted?: number
}

type DebugPanelProps = {
  userHandle?: string
}

const DEFAULT_TEXT_SNIPPET = "Debug blob test from the DadsBot debugging console."

function encodeBlobPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function formatDate(input?: string | Date): string {
  if (!input) return 'unknown'
  const value = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(value.valueOf())) return 'unknown'
  return value.toLocaleString()
}

function formatBytes(input?: number): string {
  if (typeof input !== 'number' || !Number.isFinite(input)) return '—'
  if (input < 1024) return `${input} B`
  const units = ['KB', 'MB', 'GB']
  let size = input / 1024
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`
}

function buildDefaultPath(prefix: string, extension: string) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const normalizedPrefix = prefix.replace(/\s+/g, '').replace(/\/+$/, '')
  const safePrefix = normalizedPrefix.length ? `${normalizedPrefix}/` : ''
  return `${safePrefix}${ts}.${extension.replace(/^\.+/, '')}`
}

export function DebugPanel({ userHandle }: DebugPanelProps) {
  const [status, setStatus] = useState<BlobStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState<boolean>(true)

  const [textPath, setTextPath] = useState(() => buildDefaultPath('debug', 'txt'))
  const [textContent, setTextContent] = useState(DEFAULT_TEXT_SNIPPET)
  const [textResult, setTextResult] = useState<UploadResultPayload | null>(null)
  const [textUploading, setTextUploading] = useState(false)

  const [audioPath, setAudioPath] = useState(() => buildDefaultPath('debug', 'webm'))
  const [audioResult, setAudioResult] = useState<UploadResultPayload | null>(null)
  const [audioUploading, setAudioUploading] = useState(false)
  const [audioError, setAudioError] = useState<string | null>(null)
  const [audioDuration, setAudioDuration] = useState<number | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const audioBlobRef = useRef<Blob | null>(null)
  const audioMimeRef = useRef<string>('audio/webm')
  const recorderRef = useRef<SessionRecorder | null>(null)
  const [isRecording, setIsRecording] = useState(false)

  const [listPrefix, setListPrefix] = useState('debug/')
  const [listCursor, setListCursor] = useState<string | undefined>(undefined)
  const [listItems, setListItems] = useState<BlobListItem[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listHasMore, setListHasMore] = useState(false)

  const [historyTarget, setHistoryTarget] = useState(() => normalizeHandle(userHandle ?? undefined) || '')
  const [historyClearing, setHistoryClearing] = useState(false)
  const [historyResult, setHistoryResult] = useState<HistoryClearResult | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)

  const scopedListUrl = useMemo(() => {
    if (!userHandle) return '/history'
    return buildScopedPath('/history', userHandle)
  }, [userHandle])

  useEffect(() => {
    let cancelled = false
    const loadStatus = async () => {
      setStatusLoading(true)
      setStatusError(null)
      try {
        const response = await fetch('/api/debug/blob-status', { cache: 'no-store' })
        if (!response.ok) {
          throw new Error(`Status request failed (${response.status})`)
        }
        const data = (await response.json()) as BlobStatus
        if (!cancelled) {
          setStatus({ ...data, fetchedAt: new Date().toISOString() })
        }
      } catch (error: any) {
        if (!cancelled) {
          setStatus(null)
          setStatusError(error?.message || 'Failed to load status')
        }
      } finally {
        if (!cancelled) {
          setStatusLoading(false)
        }
      }
    }
    loadStatus()
    return () => {
      cancelled = true
    }
  }, [])

  const fetchList = useCallback(
    async (cursor?: string, reset: boolean = false) => {
      setListLoading(true)
      setListError(null)
      try {
        const params = new URLSearchParams()
        if (listPrefix.trim().length) {
          params.set('prefix', listPrefix.trim())
        }
        if (!reset && cursor) {
          params.set('cursor', cursor)
        }
        const response = await fetch(`/api/debug/blobs?${params.toString()}`, { cache: 'no-store' })
        if (!response.ok) {
          throw new Error(`List request failed (${response.status})`)
        }
        const data = (await response.json()) as BlobListResponse
        setListItems((prev) => (!reset && cursor ? [...prev, ...data.blobs] : data.blobs))
        setListCursor(data.cursor)
        setListHasMore(data.hasMore)
      } catch (error: any) {
        setListError(error?.message || 'Failed to list blobs')
        setListItems([])
        setListHasMore(false)
        setListCursor(undefined)
      } finally {
        setListLoading(false)
      }
    },
    [listPrefix],
  )

  useEffect(() => {
    fetchList(undefined, true)
  }, [fetchList])

  const ensureRecorder = useCallback(() => {
    if (recorderRef.current) return recorderRef.current
    try {
      const recorder = createSessionRecorder()
      recorderRef.current = recorder
      return recorder
    } catch (error: any) {
      setAudioError(error?.message || 'Recorder unavailable in this environment')
      return null
    }
  }, [])

  const startRecording = useCallback(async () => {
    setAudioError(null)
    const recorder = ensureRecorder()
    if (!recorder) return
    try {
      await recorder.start()
      setIsRecording(true)
      audioBlobRef.current = null
      setAudioDuration(null)
      setAudioUrl(null)
    } catch (error: any) {
      setAudioError(error?.message || 'Failed to start recording')
    }
  }, [ensureRecorder])

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    try {
      const result = await recorder.stop()
      audioBlobRef.current = result.blob
      audioMimeRef.current = result.mimeType || 'audio/webm'
      setAudioDuration(result.durationMs)
      setAudioUrl(URL.createObjectURL(result.blob))
      setIsRecording(false)
    } catch (error: any) {
      setAudioError(error?.message || 'Failed to capture recording')
      setIsRecording(false)
    }
  }, [])

  const handleAudioFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    audioBlobRef.current = file
    audioMimeRef.current = file.type || 'audio/webm'
    setAudioDuration(null)
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl)
    }
    setAudioUrl(URL.createObjectURL(file))
    setAudioError(null)
  }, [audioUrl])

  const uploadBlob = useCallback(async (path: string, body: BodyInit, contentType: string) => {
    const normalizedPath = path.replace(/^\/+/, '')
    if (!normalizedPath) {
      throw new Error('Path is required')
    }
    const response = await fetch(`/api/blob/${encodeBlobPath(normalizedPath)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
      },
      body,
    })
    const payload = (await response.json().catch(() => null)) as UploadResultPayload | null
    if (!response.ok) {
      const message = resolveErrorMessage(payload, `Upload failed (${response.status})`)
      const error = new Error(message)
      ;(error as any).status = response.status
      throw error
    }
    return payload ?? { ok: true, url: null, downloadUrl: null, status: response.status }
  }, [])

  const submitText = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setTextUploading(true)
      setTextResult(null)
      try {
        const body = new TextEncoder().encode(textContent)
        const result = await uploadBlob(textPath, body, 'text/plain; charset=utf-8')
        setTextResult({ ok: true, url: result?.url ?? null, downloadUrl: result?.downloadUrl ?? null })
        await fetchList(undefined, true)
      } catch (error: any) {
        setTextResult({ ok: false, message: error?.message, status: error?.status })
      } finally {
        setTextUploading(false)
      }
    },
    [fetchList, textContent, textPath, uploadBlob],
  )

  const submitAudio = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setAudioUploading(true)
      setAudioResult(null)
      try {
        const blob = audioBlobRef.current
        if (!blob || blob.size === 0) {
          throw new Error('Record audio or choose a file before uploading')
        }
        const arrayBuffer = await blob.arrayBuffer()
        const result = await uploadBlob(audioPath, arrayBuffer, audioMimeRef.current || 'audio/webm')
        setAudioResult({ ok: true, url: result?.url ?? null, downloadUrl: result?.downloadUrl ?? null })
        await fetchList(undefined, true)
      } catch (error: any) {
        setAudioResult({ ok: false, message: error?.message, status: error?.status })
      } finally {
        setAudioUploading(false)
      }
    },
    [audioPath, fetchList, uploadBlob],
  )

  const deleteBlob = useCallback(
    async (path: string) => {
      const normalizedPath = path.replace(/^\/+/, '')
      if (!normalizedPath) return
      const response = await fetch(`/api/blob/${encodeBlobPath(normalizedPath)}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) {
        const payload = await response.json().catch(() => null)
        const message = resolveErrorMessage(payload as UploadResultPayload | null, `Failed to delete (${response.status})`)
        throw new Error(message)
      }
    },
    [],
  )

  const deletePrefix = useCallback(
    async () => {
      if (!listPrefix.trim().length) return
      const params = new URLSearchParams()
      params.set('prefix', listPrefix.trim())
      const response = await fetch(`/api/debug/blobs?${params.toString()}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as UploadResultPayload | null
        const message = resolveErrorMessage(payload, `Failed to delete prefix (${response.status})`)
        throw new Error(message)
      }
      await fetchList(undefined, true)
    },
    [fetchList, listPrefix],
  )

  const handleHistoryClear = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setHistoryClearing(true)
      setHistoryResult(null)
      setHistoryError(null)
      try {
        const params = new URLSearchParams()
        const normalized = normalizeHandle(historyTarget || undefined)
        if (normalized) {
          params.set('handle', normalized)
        }
        const response = await fetch(`/api/history${params.toString() ? `?${params.toString()}` : ''}`, {
          method: 'DELETE',
        })
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as UploadResultPayload | null
          const message = resolveErrorMessage(payload, `Failed to clear history (${response.status})`)
          throw new Error(message)
        }
        const payload = (await response.json().catch(() => null)) as HistoryClearResult | null
        setHistoryResult(payload || { ok: true })
      } catch (error: any) {
        setHistoryError(error?.message || 'Failed to clear history')
      } finally {
        setHistoryClearing(false)
      }
    },
    [historyTarget],
  )

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl)
      }
    }
  }, [audioUrl])

  return (
    <div className="debug-page">
      <h2>Debug storage console</h2>
      <p>
        This workspace exercises the Netlify Blobs integration end-to-end. Record or upload artifacts, inspect the
        stored files, and clear history when the on-disk state drifts from the session logs.
      </p>

      <section className="panel-card debug-panel__section">
        <header>
          <h3>Environment snapshot</h3>
        </header>
        {statusLoading ? (
          <p>Loading storage status…</p>
        ) : statusError ? (
          <p className="error">{statusError}</p>
        ) : status ? (
          <div className="debug-status-grid">
            <div>
              <strong>Provider</strong>
              <div>{status.env?.provider || 'unknown'}</div>
            </div>
            <div>
              <strong>Store</strong>
              <div>{status.env?.store || '—'}</div>
            </div>
            <div>
              <strong>Site ID</strong>
              <div>{status.env?.siteId || '—'}</div>
            </div>
            <div>
              <strong>Health</strong>
              <div>{status.health?.ok ? 'OK' : `Unhealthy (${status.health?.reason || 'unknown'})`}</div>
            </div>
            <div>
              <strong>Fetched</strong>
              <div>{formatDate(status.fetchedAt)}</div>
            </div>
            {status.env?.error ? (
              <div className="debug-full-width">
                <strong>Latest error</strong>
                <pre>{JSON.stringify(status.env.error, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        ) : (
          <p>Storage status unavailable.</p>
        )}
        <p className="debug-note">
          Core prefixes used by this app: <code>sessions/</code> (session manifests &amp; turn audio), <code>transcripts/</code>{' '}
          (final transcripts), and <code>memory/primers/</code> (handle-specific primers). The panels below target the
          <code>debug/</code> namespace so you can validate writes without touching production artifacts.
        </p>
      </section>

      <section className="panel-card debug-panel__section">
        <header>
          <h3>Write text blob</h3>
        </header>
        <form onSubmit={submitText} className="debug-form-grid">
          <label>
            Blob path
            <input
              type="text"
              value={textPath}
              onChange={(event) => setTextPath(event.target.value)}
              placeholder="debug/example.txt"
              required
            />
          </label>
          <label className="full-width">
            Contents
            <textarea value={textContent} onChange={(event) => setTextContent(event.target.value)} rows={6} />
          </label>
          <div className="debug-form-actions">
            <button type="submit" disabled={textUploading}>
              {textUploading ? 'Uploading…' : 'Upload text sample'}
            </button>
            <button
              type="button"
              onClick={() => {
                setTextContent(DEFAULT_TEXT_SNIPPET)
                setTextPath(buildDefaultPath('debug', 'txt'))
              }}
              disabled={textUploading}
            >
              Reset sample
            </button>
          </div>
        </form>
        {textResult ? (
          <div className={`debug-result ${textResult.ok ? 'ok' : 'error'}`}>
            {textResult.ok ? (
              <>
                <strong>Upload succeeded.</strong>{' '}
                {textResult.downloadUrl ? (
                  <a href={textResult.downloadUrl} target="_blank" rel="noreferrer">
                    View blob
                  </a>
                ) : null}
              </>
            ) : (
              <>
                <strong>Upload failed.</strong> {textResult.message || 'Unknown error'}
              </>
            )}
          </div>
        ) : null}
      </section>

      <section className="panel-card debug-panel__section">
        <header>
          <h3>Write audio blob</h3>
        </header>
        <form onSubmit={submitAudio} className="debug-form-grid">
          <label>
            Blob path
            <input
              type="text"
              value={audioPath}
              onChange={(event) => setAudioPath(event.target.value)}
              placeholder="debug/recording.webm"
              required
            />
          </label>
          <div className="debug-button-row">
            <button type="button" onClick={isRecording ? stopRecording : startRecording}>
              {isRecording ? 'Stop recording' : 'Start recording'}
            </button>
            <label className="debug-file-input">
              <span>or choose audio file</span>
              <input type="file" accept="audio/*" onChange={handleAudioFileChange} />
            </label>
          </div>
          {audioUrl ? (
            <div className="debug-audio-preview">
              <audio src={audioUrl} controls />
              <div className="debug-audio-meta">
                {audioDuration ? <span>Recorded duration: {(audioDuration / 1000).toFixed(1)}s</span> : null}
                <span>MIME type: {audioMimeRef.current}</span>
              </div>
            </div>
          ) : null}
          {audioError ? <p className="debug-error">{audioError}</p> : null}
          <div className="debug-form-actions">
            <button type="submit" disabled={audioUploading}>
              {audioUploading ? 'Uploading…' : 'Upload audio sample'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAudioPath(buildDefaultPath('debug', 'webm'))
                if (audioUrl) {
                  URL.revokeObjectURL(audioUrl)
                }
                setAudioUrl(null)
                audioBlobRef.current = null
                setAudioDuration(null)
                setAudioResult(null)
                setAudioError(null)
              }}
              disabled={audioUploading}
            >
              Reset
            </button>
          </div>
        </form>
        {audioResult ? (
          <div className={`debug-result ${audioResult.ok ? 'ok' : 'error'}`}>
            {audioResult.ok ? (
              <>
                <strong>Upload succeeded.</strong>{' '}
                {audioResult.downloadUrl ? (
                  <a href={audioResult.downloadUrl} target="_blank" rel="noreferrer">
                    Listen
                  </a>
                ) : null}
              </>
            ) : (
              <>
                <strong>Upload failed.</strong> {audioResult.message || 'Unknown error'}
              </>
            )}
          </div>
        ) : null}
      </section>

      <section className="panel-card debug-panel__section">
        <header>
          <h3>Inspect stored blobs</h3>
        </header>
        <div className="debug-list-controls">
          <label>
            Prefix
            <input
              type="text"
              value={listPrefix}
              onChange={(event) => setListPrefix(event.target.value)}
              placeholder="debug/"
            />
          </label>
          <div className="debug-button-row">
            <button type="button" onClick={() => fetchList(undefined, true)} disabled={listLoading}>
              {listLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => {
                deletePrefix().catch((error) => setListError(error.message))
              }}
              disabled={listLoading || !listPrefix.trim().length}
            >
              Delete prefix
            </button>
          </div>
        </div>
        {listError ? <p className="debug-error">{listError}</p> : null}
        <div className="debug-scroll-container">
          <table>
            <thead>
              <tr>
                <th>Path</th>
                <th>Uploaded</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {listItems.length === 0 ? (
                <tr>
                  <td colSpan={4}>{listLoading ? 'Loading…' : 'No blobs found for this prefix.'}</td>
                </tr>
              ) : (
                listItems.map((item) => (
                  <tr key={item.pathname}>
                    <td>
                      <code>{item.pathname}</code>
                    </td>
                    <td>{formatDate(item.uploadedAt)}</td>
                    <td>{formatBytes(item.size)}</td>
                    <td>
                      <div className="debug-button-row">
                        <a href={item.downloadUrl || item.url} target="_blank" rel="noreferrer">
                          open
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            deleteBlob(item.pathname)
                              .then(() => fetchList(undefined, true))
                              .catch((error) => setListError(error.message))
                          }}
                        >
                          delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {listHasMore ? (
          <button
            type="button"
            onClick={() => fetchList(listCursor, false)}
            disabled={listLoading || !listCursor}
          >
            {listLoading ? 'Loading…' : 'Load more'}
          </button>
        ) : null}
      </section>

      <section className="panel-card debug-panel__section">
        <header>
          <h3>Session history cleanup</h3>
        </header>
        <p>
          When the manifest inventory and the blob store drift apart, use this tool to reset everything. It calls the
          same <code>DELETE /api/history</code> handler that the diagnostics suite uses to purge <code>sessions/</code>,{' '}
          <code>transcripts/</code>, and <code>memory/</code> data.
        </p>
        <form onSubmit={handleHistoryClear} className="debug-form-grid">
          <label>
            Limit to handle (optional)
            <input
              type="text"
              value={historyTarget}
              onChange={(event) => setHistoryTarget(event.target.value)}
              placeholder="Leave blank to clear all"
            />
          </label>
          <div className="debug-form-actions">
            <button type="submit" disabled={historyClearing}>
              {historyClearing ? 'Clearing…' : 'Clear stored history'}
            </button>
            <a href={scopedListUrl} target="_blank" rel="noreferrer" className="debug-secondary-link">
              Review recent sessions
            </a>
          </div>
        </form>
        {historyError ? <p className="debug-error">{historyError}</p> : null}
        {historyResult ? (
          <div className="debug-result ok">
            <strong>History cleared.</strong>{' '}
            {typeof historyResult.deleted === 'number'
              ? `${historyResult.deleted} sessions removed.`
              : 'The blob prefixes were purged.'}
          </div>
        ) : null}
      </section>
    </div>
  )
}

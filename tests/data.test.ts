import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFoxes, listFoxes } from '../lib/foxes'
import type { ListBlobResult } from '../lib/blob'

const putBlobMock = vi.fn(async (path: string, _buf: Buffer, _type: string, _options?: unknown) => ({
  url: `https://blob.test/${path}`,
}))
const listBlobsMock = vi.fn(
  async (_options?: { prefix?: string; limit?: number; cursor?: string }): Promise<ListBlobResult> => ({
    blobs: [],
    hasMore: false,
    nextCursor: null,
  }),
)
const deleteByPrefixMock = vi.fn(async (_prefix?: string): Promise<number> => 0)
const deleteBlobMock = vi.fn(async (_path?: string): Promise<boolean> => false)
const originalFetch = global.fetch
vi.mock('../lib/blob', () => ({
  putBlobFromBuffer: putBlobMock,
  listBlobs: listBlobsMock,
  deleteBlobsByPrefix: deleteByPrefixMock,
  deleteBlob: deleteBlobMock,
  primeNetlifyBlobContextFromHeaders: vi.fn(() => true),
}))

const sendEmailMock = vi.fn()
vi.mock('../lib/email', () => ({
  sendSummaryEmail: sendEmailMock,
}))

afterEach(() => {
  global.fetch = originalFetch
  listBlobsMock.mockImplementation(async () => ({ blobs: [], hasMore: false, nextCursor: null }))
})

describe('finalizeSession', () => {
  beforeEach(async () => {
    vi.resetModules()
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.SUPABASE_STORAGE_BUCKET = 'test-bucket'
    putBlobMock.mockReset()
    putBlobMock.mockImplementation(async (path: string, _buf: Buffer, _type: string, _options?: unknown) => ({
      url: `https://blob.test/${path}`,
      downloadUrl: `https://blob.test/${path}`,
    }))
    listBlobsMock.mockReset()
    listBlobsMock.mockImplementation(async (_options?: { prefix?: string; limit?: number; cursor?: string }): Promise<ListBlobResult> => ({
      blobs: [],
      hasMore: false,
      nextCursor: null,
    }))
    deleteByPrefixMock.mockReset()
    deleteBlobMock.mockReset()
    deleteBlobMock.mockImplementation(async (_path?: string): Promise<boolean> => false)
    sendEmailMock.mockReset()
    clearFoxes()
    const data = await import('../lib/data')
    data.__dangerousResetMemoryState()
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as any
  })

  it('reports success when email provider succeeds', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ ok: true, provider: 'resend' })
    const session = await data.createSession({ email_to: 'user@example.com' })
    await data.appendTurn(session.id, { role: 'user', text: 'hello' })

    const result = await data.finalizeSession(session.id, { clientDurationMs: 1000 })
    if (!('session' in result)) {
      throw new Error('Expected session result')
    }

    expect(result.emailed).toBe(true)
    expect(result.emailStatus).toEqual({ ok: true, provider: 'resend' })
    expect(result.session.title && result.session.title.length).toBeTruthy()
    expect(result.session.title?.toLowerCase()).not.toContain('untitled')
    const stored = await data.getSession(session.id)
    expect(stored?.status).toBe('emailed')
    expect(stored?.title && stored.title.length).toBeTruthy()
  })

  it('handles skipped email when no provider configured', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ skipped: true })
    const session = await data.createSession({ email_to: 'user@example.com' })
    await data.appendTurn(session.id, { role: 'assistant', text: 'hi again' })

    const result = await data.finalizeSession(session.id, { clientDurationMs: 200 })
    if (!('session' in result)) {
      throw new Error('Expected session result')
    }

    expect(result.emailed).toBe(false)
    expect(result.emailStatus).toEqual({ skipped: true })
    const stored = await data.getSession(session.id)
    expect(stored?.status).toBe('completed')
    expect(stored?.title && stored.title.length).toBeTruthy()
  })

  it('flags failures from the email provider', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ ok: false, provider: 'resend', error: 'bad' })
    const session = await data.createSession({ email_to: 'user@example.com' })
    await data.appendTurn(session.id, { role: 'user', text: 'hi there' })

    const result = await data.finalizeSession(session.id, { clientDurationMs: 0 })
    if (!('session' in result)) {
      throw new Error('Expected session result')
    }

    expect(result.emailed).toBe(false)
    expect(result.emailStatus).toEqual({ ok: false, provider: 'resend', error: 'bad' })
    const stored = await data.getSession(session.id)
    expect(stored?.status).toBe('error')
    expect(stored?.title && stored.title.length).toBeTruthy()
    const foxes = listFoxes()
    expect(foxes.some((fox) => fox.id === 'theory-4-email-status-error')).toBe(true)
  })

  it('skips summary email when the session has no recipient', async () => {
    const data = await import('../lib/data')
    const session = await data.createSession({ email_to: '' })
    await data.appendTurn(session.id, { role: 'assistant', text: 'hello there' })

    const result = await data.finalizeSession(session.id, { clientDurationMs: 10 })
    if (!('session' in result)) {
      throw new Error('Expected session result')
    }

    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(result.emailed).toBe(false)
    expect(result.emailStatus).toEqual({ skipped: true })
    expect(result.session.status).toBe('completed')
  })

  it('persists session audio artifacts when provided', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ skipped: true })
    const session = await data.createSession({ email_to: 'user@example.com' })

    await data.appendTurn(session.id, { role: 'assistant', text: 'hello again' })

    const result = await data.finalizeSession(session.id, {
      clientDurationMs: 1234,
      sessionAudioUrl: 'https://blob.test/sessions/123/session-audio.webm',
    })

    if (!('session' in result)) {
      throw new Error('Expected session result')
    }

    const stored = await data.getSession(session.id)
    expect(stored?.artifacts?.session_audio).toBe('https://blob.test/sessions/123/session-audio.webm')
  })

  it('updates the memory primer with highlights from the session', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ skipped: true })
    const session = await data.createSession({ email_to: '' })
    await data.appendTurn(session.id, { role: 'user', text: 'hello there from the porch' })
    await data.appendTurn(session.id, { role: 'assistant', text: 'thanks for sharing that scene' })

    await data.finalizeSession(session.id, { clientDurationMs: 500 })

    const primer = await data.getMemoryPrimer()
    expect(primer.text).toContain('### Additional Notes & Identity')
    expect(primer.text).toContain('Latest • Hello there from the porch')
    expect(putBlobMock.mock.calls.some(([path]) => path === 'memory/primers/unassigned.md')).toBe(true)
  })
})

describe('appendTurn API error handling', () => {
  beforeEach(async () => {
    vi.resetModules()
    putBlobMock.mockClear()
    listBlobsMock.mockClear()
    deleteByPrefixMock.mockClear()
    deleteBlobMock.mockClear()
    sendEmailMock.mockReset()
    clearFoxes()
    const data = await import('../lib/data')
    data.__dangerousResetMemoryState()
  })

  it('bubbles blob failures to the API with diagnostics without mutating memory', async () => {
    const data = await import('../lib/data')
    const session = await data.createSession({ email_to: 'user@example.com' })
    const blobError = new Error('forced blob failure')
    putBlobMock.mockRejectedValueOnce(blobError)

    const { POST } = await import('../app/api/session/[id]/turn/route')
    const payload = { role: 'user', text: 'hello there from diagnostics' }
    const req = { headers: new Headers(), json: async () => payload } as any

    const response = await POST(req, { params: { id: session.id } })
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toContain('session manifest persistence failed')
    expect(body.diagnostic?.env).toBeDefined()
    expect(body.diagnostic?.error?.cause?.message).toContain('forced blob failure')

    const stored = await data.getSession(session.id)
    expect(stored?.turns?.length ?? 0).toBe(0)
    expect(stored?.total_turns ?? 0).toBe(0)
  })
})

describe('session deletion helpers', () => {
  beforeEach(async () => {
    vi.resetModules()
    putBlobMock.mockClear()
    listBlobsMock.mockClear()
    deleteByPrefixMock.mockClear()
    deleteBlobMock.mockClear()
    sendEmailMock.mockReset()
    clearFoxes()
    const data = await import('../lib/data')
    data.__dangerousResetMemoryState()
    deleteByPrefixMock.mockImplementation(async () => 0)
    deleteBlobMock.mockImplementation(async () => true)
  })

  it('deletes a specific session and updates the primer state', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ skipped: true })
    const session = await data.createSession({ email_to: '' })
    await data.appendTurn(session.id, { role: 'user', text: 'memory highlight to remove' })
    await data.finalizeSession(session.id, { clientDurationMs: 100 })

    deleteByPrefixMock.mockImplementation(async (prefix?: string) => {
      if (typeof prefix === 'string' && prefix.startsWith('sessions/')) return 1
      if (typeof prefix === 'string' && prefix.startsWith('transcripts/')) return 1
      return 0
    })

    const result = await data.deleteSession(session.id)

    expect(result).toEqual({ ok: true, deleted: true })
    expect(deleteByPrefixMock).toHaveBeenCalledWith(`sessions/${session.id}/`)
    expect(deleteByPrefixMock).toHaveBeenCalledWith(`transcripts/${session.id}`)
    expect(deleteBlobMock).toHaveBeenCalledWith('memory/primers/unassigned.md')
    expect(deleteBlobMock).toHaveBeenCalledWith('memory/MemoryPrimer.txt')

    const primer = await data.getMemoryPrimer()
    expect(primer.text).not.toContain('memory highlight to remove')
  })

  it('clears all sessions and blob records', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ skipped: true })
    const session = await data.createSession({ email_to: '' })
    await data.appendTurn(session.id, { role: 'assistant', text: 'hello' })
    await data.finalizeSession(session.id, { clientDurationMs: 200 })

    deleteByPrefixMock.mockImplementation(async () => 1)

    await data.clearAllSessions()

    expect(deleteByPrefixMock).toHaveBeenCalledWith('sessions/')
    expect(deleteByPrefixMock).toHaveBeenCalledWith('transcripts/')
    expect(deleteByPrefixMock).toHaveBeenCalledWith('memory/primers/')
    expect(deleteBlobMock).toHaveBeenCalledWith('memory/MemoryPrimer.txt')

    const sessions = await data.listSessions()
    expect(sessions).toEqual([])
  })

  it('scopes listing and deletion by user handle', async () => {
    const data = await import('../lib/data')
    sendEmailMock.mockResolvedValue({ skipped: true })

    const defaultSession = await data.createSession({ email_to: '' })
    const handledSession = await data.createSession({ email_to: '', user_handle: 'Amol' })

    const defaultSessions = await data.listSessions()
    expect(defaultSessions.map((s) => s.id)).toContain(defaultSession.id)
    expect(defaultSessions.some((s) => s.id === handledSession.id)).toBe(false)

    const scopedSessions = await data.listSessions('amol')
    expect(scopedSessions.map((s) => s.id)).toEqual([handledSession.id])

    await data.deleteSessionsByHandle('amol')

    const afterDeletionScoped = await data.listSessions('amol')
    expect(afterDeletionScoped).toEqual([])

    const remainingDefault = await data.listSessions()
    expect(remainingDefault.map((s) => s.id)).toContain(defaultSession.id)
  })
})

describe('memory continuity across requests', () => {
  beforeEach(async () => {
    vi.resetModules()
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'
    process.env.SUPABASE_STORAGE_BUCKET = 'test-bucket'
    putBlobMock.mockReset()
    putBlobMock.mockImplementation(async (path: string, _buf: Buffer, _type: string, _options?: unknown) => ({
      url: `https://blob.test/${path}`,
      downloadUrl: `https://blob.test/${path}`,
    }))
    listBlobsMock.mockReset()
    listBlobsMock.mockImplementation(async (_options?: { prefix?: string; limit?: number; cursor?: string }): Promise<ListBlobResult> => ({
      blobs: [],
      hasMore: false,
      nextCursor: null,
    }))
    deleteByPrefixMock.mockReset()
    deleteBlobMock.mockReset()
    deleteBlobMock.mockImplementation(async (_path?: string): Promise<boolean> => false)
    sendEmailMock.mockReset()
    clearFoxes()
    const data = await import('../lib/data')
    data.__dangerousResetMemoryState()
    global.fetch = vi.fn(async () => new Response('not found', { status: 404 })) as any
  })
  it('overwrites manifests when appending multiple turns to the same session', async () => {
    const uploadedPaths = new Set<string>()
    deleteBlobMock.mockImplementation(async (path?: string): Promise<boolean> => {
      if (path) uploadedPaths.delete(path)
      return true
    })
    putBlobMock.mockImplementation(async (path: string, _buf: Buffer, _type: string) => {
      if (uploadedPaths.has(path)) {
        const err = new Error('duplicate upload prevented')
        ;(err as any).code = 'duplicate'
        throw err
      }
      uploadedPaths.add(path)
      return { url: `https://blob.test/${path}`, downloadUrl: `https://blob.test/${path}` }
    })

    const data = await import('../lib/data')
    const session = await data.createSession({ email_to: 'test@example.com' })
    const manifestPath = `sessions/${session.id}/session-${session.id}.json`

    await data.appendTurn(session.id, { role: 'user', text: 'First note' })
    await expect(data.appendTurn(session.id, { role: 'assistant', text: 'Second note' })).resolves.toBeTruthy()

    expect(deleteBlobMock).toHaveBeenCalledWith(manifestPath)
    expect(putBlobMock).toHaveBeenCalledTimes(3)
    const stored = await data.getSession(session.id)
    const manifestUrl = `https://blob.test/${manifestPath}`
    expect(stored?.artifacts?.session_manifest).toBe(manifestUrl)
    expect(stored?.artifacts?.manifest).toBe(manifestUrl)
  })

  it('rehydrates a stored session manifest before appending turns', async () => {
    const data = await import('../lib/data')
    const session = await data.createSession({ email_to: '', user_handle: 'Tester' })
    await data.appendTurn(session.id, { role: 'user', text: 'First memory shared' })

    const manifestCall = [...putBlobMock.mock.calls]
      .reverse()
      .find(([path]) => path === `sessions/${session.id}/session-${session.id}.json`)
    if (!manifestCall) {
      throw new Error('Expected session manifest upload')
    }
    const manifestBuffer = manifestCall[1] as Buffer
    const manifestJson = JSON.parse(manifestBuffer.toString('utf8'))

    const manifestUrl = `https://blob.test/sessions/${session.id}/session-${session.id}.json`
    const manifestEntry = {
      pathname: `sessions/${session.id}/session-${session.id}.json`,
      url: manifestUrl,
      downloadUrl: manifestUrl,
      uploadedAt: new Date(),
    }

    data.__dangerousResetMemoryState()

    listBlobsMock.mockImplementation(
      async (options?: { prefix?: string; limit?: number; cursor?: string }): Promise<ListBlobResult> => {
        if (!options) return { blobs: [], hasMore: false, nextCursor: null }
        if (options.prefix === 'sessions/' || options.prefix === `sessions/${session.id}/`) {
          return { blobs: [manifestEntry], hasMore: false, nextCursor: null }
        }
        return { blobs: [], hasMore: false, nextCursor: null }
      },
    )

    global.fetch = vi.fn(async (url: string) => {
      if (url === manifestUrl) {
        return new Response(JSON.stringify(manifestJson), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const appended = await data.appendTurn(session.id, { role: 'assistant', text: 'Glad to remember that with you.' })
    expect(appended.text).toBe('Glad to remember that with you.')

    const stored = await data.getSession(session.id)
    expect(stored?.turns?.length).toBeGreaterThanOrEqual(2)

    const foxes = listFoxes()
    expect(foxes.some((fox) => fox.id === 'theory-1-memory-miss')).toBe(false)
  })
})

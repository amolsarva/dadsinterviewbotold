import { getBlobEnvironment, listBlobs } from './blob'
import { normalizeHandle } from './user-scope'

type RawTurnBlob = { url: string; downloadUrl?: string; uploadedAt: string; name: string }

type StoredArtifacts = {
  manifest?: string | null
  transcript_txt?: string | null
  transcript_json?: string | null

  session_manifest?: string | null
  session_audio?: string | null

}

export type StoredTurn = {
  turn: number
  audio: string | null
  assistantAudio: string | null
  assistantAudioDurationMs: number
  manifest: string
  transcript: string
  assistantReply: string
  durationMs: number
  createdAt: string | null
}

export type StoredSession = {
  sessionId: string
  manifestUrl: string | null
  startedAt: string | null
  endedAt: string | null
  totalTurns: number
  totalDurationMs: number
  turns: StoredTurn[]
  artifacts?: StoredArtifacts
  userHandle: string | null
}

type SessionEntry = StoredSession & {
  turnBlobs: RawTurnBlob[]
  latestUploadedAt: string
  artifacts: StoredArtifacts
}

function ensureStorageConfigured() {
  const env = getBlobEnvironment()
  if (!env.configured) throw new Error('Supabase storage is not configured')
  return env
}

function normalizeUploadedAt(uploadedAt: unknown): string {
  if (!uploadedAt) return ''
  if (typeof uploadedAt === 'string') return uploadedAt
  if (uploadedAt instanceof Date) return uploadedAt.toISOString()
  try {
    return new Date(uploadedAt as string).toISOString()
  } catch {
    return String(uploadedAt)
  }
}

async function enrich(entry: SessionEntry): Promise<StoredSession> {
  entry.turnBlobs.sort((a, b) => a.name.localeCompare(b.name))
  const turns: StoredTurn[] = []
  let totalDuration = 0

  for (const turn of entry.turnBlobs) {
    try {
      const targetUrl = turn.downloadUrl || turn.url
      if (!targetUrl) continue
      const resp = await fetch(targetUrl)
      const json = await resp.json()
      const turnNumber = Number(json.turn) || turns.length + 1
      const created = json.createdAt || turn.uploadedAt || null
      if (created) {
        if (!entry.startedAt || created < entry.startedAt) entry.startedAt = created
        if (!entry.endedAt || created > entry.endedAt) entry.endedAt = created
      }
      const duration = Number(json.durationMs) || 0
      totalDuration += duration
      turns.push({
        turn: turnNumber,
        audio: typeof json.userAudioUrl === 'string' ? json.userAudioUrl : null,

        assistantAudio: typeof json.assistantAudioUrl === 'string' ? json.assistantAudioUrl : null,
        assistantAudioDurationMs: Number(json.assistantAudioDurationMs) || 0,

        manifest: targetUrl,
        transcript: typeof json.transcript === 'string' ? json.transcript : '',
        assistantReply: typeof json.assistantReply === 'string' ? json.assistantReply : '',
        durationMs: duration,
        createdAt: created,
      })
    } catch {
      // ignore malformed turn entries to preserve legacy resilience
    }
  }

  if (entry.manifestUrl) {
    try {
      const resp = await fetch(entry.manifestUrl)
      const json = await resp.json()
      if (!entry.startedAt && json.startedAt) entry.startedAt = json.startedAt
      if (!entry.endedAt && json.endedAt) entry.endedAt = json.endedAt
      const totalDurationFromManifest = Number(json?.totals?.durationMs)
      if (Number.isFinite(totalDurationFromManifest)) {
        entry.totalDurationMs = totalDurationFromManifest as number
      }
      const totalTurnsFromManifest = Number(json?.totals?.turns)
      if (Number.isFinite(totalTurnsFromManifest)) {
        entry.totalTurns = totalTurnsFromManifest as number
      }
      const manifestHandle = normalizeHandle(
        typeof json?.user_handle === 'string'
          ? json.user_handle
          : typeof json?.userHandle === 'string'
          ? json.userHandle
          : undefined,
      )
      if (manifestHandle) {
        entry.userHandle = manifestHandle
      }
      if (!entry.artifacts.transcript_txt && json?.artifacts?.transcript_txt) {
        entry.artifacts.transcript_txt = json.artifacts.transcript_txt
      }
      if (!entry.artifacts.transcript_json && json?.artifacts?.transcript_json) {
        entry.artifacts.transcript_json = json.artifacts.transcript_json
      }

      if (!entry.artifacts.session_audio && json?.artifacts?.session_audio) {
        entry.artifacts.session_audio = json.artifacts.session_audio
      }
      if (!entry.artifacts.session_manifest && json?.artifacts?.session_manifest) {
        entry.artifacts.session_manifest = json.artifacts.session_manifest
      }

    } catch {
      // ignore manifest parse errors
    }
  }

  if (!entry.totalDurationMs) entry.totalDurationMs = totalDuration
  entry.totalTurns = turns.length

  return {
    sessionId: entry.sessionId,
    manifestUrl: entry.manifestUrl,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    totalTurns: entry.totalTurns,
    totalDurationMs: entry.totalDurationMs,
    turns,
    artifacts: {
      manifest: entry.manifestUrl,
      transcript_txt: entry.artifacts.transcript_txt ?? null,
      transcript_json: entry.artifacts.transcript_json ?? null,

      session_audio: entry.artifacts.session_audio ?? null,
      session_manifest: entry.artifacts.session_manifest ?? entry.manifestUrl ?? null,

    },
    userHandle: entry.userHandle ?? null,
  }
}

function buildEntries(blobs: Awaited<ReturnType<typeof listBlobs>>['blobs']) {
  const sessions = new Map<string, SessionEntry>()

  for (const blob of blobs) {
    const match = blob.pathname.match(/^sessions\/([^/]+)\/(.+)$/)
    if (!match) continue
    const id = match[1]
    const name = match[2]
    const existing =
      sessions.get(id) ||
      ({
        sessionId: id,
        manifestUrl: null,
        startedAt: null,
        endedAt: null,
        totalTurns: 0,
        totalDurationMs: 0,
        turns: [],
        turnBlobs: [],
        latestUploadedAt: '0',
        artifacts: {},
        userHandle: null,
      } as SessionEntry)

    if (/^turn-\d+\.json$/.test(name)) {
      const uploadedAt = normalizeUploadedAt(blob.uploadedAt)
      const url = blob.downloadUrl || blob.url
      if (!url) continue
      existing.turnBlobs.push({ url, downloadUrl: blob.downloadUrl, uploadedAt, name })
      if (!existing.latestUploadedAt || uploadedAt > existing.latestUploadedAt) {
        existing.latestUploadedAt = uploadedAt
      }
    }

    if (/^session-.+\.json$/.test(name)) {
      const manifestUrl = blob.downloadUrl || blob.url
      existing.manifestUrl = manifestUrl
      const uploadedAt = normalizeUploadedAt(blob.uploadedAt)
      if (uploadedAt && (!existing.latestUploadedAt || uploadedAt > existing.latestUploadedAt)) {
        existing.latestUploadedAt = uploadedAt
      }
    }

    sessions.set(id, existing)
  }

  return Array.from(sessions.values())
}

export async function listSessions(): Promise<StoredSession[]> {
  ensureStorageConfigured()
  const { blobs } = await listBlobs({ prefix: 'sessions/', limit: 2000 })
  const entries = buildEntries(blobs)
  const sessions: StoredSession[] = []

  for (const entry of entries) {
    sessions.push(await enrich(entry))
  }

  sessions.sort((a, b) => {
    const aTime = a.endedAt || a.startedAt || '0'
    const bTime = b.endedAt || b.startedAt || '0'
    return new Date(bTime).getTime() - new Date(aTime).getTime()
  })

  return sessions
}

export async function fetchStoredSessions({
  page = 1,
  limit = 10,
  handle,
}: { page?: number; limit?: number; handle?: string | null } = {}): Promise<{ items: StoredSession[] }> {
  try {
    ensureStorageConfigured()
    const { blobs } = await listBlobs({ prefix: 'sessions/', limit: 2000 })
    const entries = buildEntries(blobs)
    const sorted = entries.sort(
      (a, b) => new Date(b.latestUploadedAt || '0').getTime() - new Date(a.latestUploadedAt || '0').getTime(),
    )

    const start = Math.max(0, (page - 1) * limit)
    const items: StoredSession[] = []
    const normalizedHandle = normalizeHandle(handle ?? undefined)
    let matched = 0
    for (const entry of sorted) {
      const enriched = await enrich(entry)
      if (normalizedHandle) {
        if (enriched.userHandle !== normalizedHandle) continue
      } else if (enriched.userHandle) {
        continue
      }
      if (matched >= start && items.length < limit) {
        items.push(enriched)
      }
      matched += 1
      if (items.length >= limit) break
    }
    return { items }
  } catch {
    return { items: [] }
  }
}

export async function fetchStoredSession(id: string): Promise<StoredSession | undefined> {
  try {
    ensureStorageConfigured()
    const { blobs } = await listBlobs({ prefix: `sessions/${id}/`, limit: 2000 })
    if (!blobs.length) return undefined
    const entries = buildEntries(blobs)
    const entry = entries.find((session) => session.sessionId === id)
    if (!entry) return undefined
    return await enrich(entry)
  } catch {
    return undefined
  }
}

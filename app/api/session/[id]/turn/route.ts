import { NextRequest, NextResponse } from 'next/server'
import { appendTurn, diagnosticEnvSummary, diagnosticTimestamp } from '@/lib/data'
import { primeNetlifyBlobContextFromHeaders } from '@/lib/blob'
import { z } from 'zod'

function describeApiError(err: unknown) {
  if (err instanceof Error) return { message: err.message, name: err.name, stack: err.stack }
  if (err && typeof err === 'object') return { ...(err as any), message: (err as any).message ?? String(err) }
  return { message: String(err) }
}

export async function POST(req: NextRequest, { params }: { params: { id: string }}) {
  primeNetlifyBlobContextFromHeaders(req.headers)
  try {
    const body = await req.json()
    const schema = z.object({
      role: z.enum(['user','assistant']),
      text: z.string().default(''),
      audio_blob_url: z.string().url().optional(),
    })
    const parsed = schema.parse(body)
    const turn = await appendTurn(params.id, parsed as any)
    return NextResponse.json(turn)
  } catch (e:any) {
    const diagnostic = {
      step: 'api:session:turn',
      sessionId: params.id,
      env: diagnosticEnvSummary(),
      error: { ...describeApiError(e), cause: (e as any)?.diagnostic?.error },
    }
    const timestamp = diagnosticTimestamp()
    console.error(`[diagnostic] ${timestamp} api:session:turn:failure ${JSON.stringify(diagnostic)}`)
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: 'invalid_turn_payload', diagnostic, issues: e.issues }, { status: 400 })
    }
    const status = e?.code === 'SESSION_NOT_FOUND' ? 404 : 500
    const message = e?.message || 'append_turn_failed'
    return NextResponse.json({ error: message, diagnostic }, { status })
  }
}

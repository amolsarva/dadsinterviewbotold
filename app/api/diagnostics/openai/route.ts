import { NextResponse } from 'next/server'
import OpenAI from 'openai'

export const runtime = 'nodejs'

type DiagnosticLevel = 'log' | 'error'

const hypotheses = [
  'OPENAI_API_KEY may be unset for diagnostics.',
  'OPENAI_MODEL could be missing or blank.',
  'The configured OpenAI model might be unavailable.',
]

function nowISO() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ? 'set' : 'missing',
    OPENAI_MODEL: process.env.OPENAI_MODEL?.trim() || null,
  }
}

function log(level: DiagnosticLevel, step: string, payload: Record<string, unknown> = {}) {
  const entry = {
    timestamp: nowISO(),
    step,
    env: envSummary(),
    ...payload,
  }
  const message = `[diagnostic] ${nowISO()} diagnostics:openai:${step} ${JSON.stringify(entry)}`
  level === 'error' ? console.error(message) : console.log(message)
}

function requireEnv(name: 'OPENAI_API_KEY' | 'OPENAI_MODEL'): string {
  const raw = process.env[name]
  const value = typeof raw === 'string' ? raw.trim() : ''

  if (!value) {
    const message = `${name} is required for OpenAI diagnostics. Define ${name} in your environment.`
    log('error', 'env-missing', { name, message })
    throw new Error(message)
  }

  return value
}

export async function GET() {
  log('log', 'request:start', { hypotheses })

  try {
    const apiKey = requireEnv('OPENAI_API_KEY')
    const model = requireEnv('OPENAI_MODEL')

    log('log', 'request:configured', { model })

    const client = new OpenAI({ apiKey })

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: 'You are verifying connectivity for diagnostics.' },
        { role: 'user', content: 'Reply with a brief confirmation that OpenAI connectivity works.' },
      ],
      max_tokens: 60,
    })

    const reply = completion.choices?.[0]?.message?.content?.trim() || ''

    log('log', 'request:success', { model, replyLength: reply.length })

    return NextResponse.json({
      ok: true,
      status: 200,
      model: { id: completion.model || model },
      reply,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenAI diagnostics failed'
    log('error', 'request:error', { message })

    return NextResponse.json(
      {
        ok: false,
        error: 'openai_diagnostics_failed',
        message,
        env: envSummary(),
      },
      { status: 500 }
    )
  }
}

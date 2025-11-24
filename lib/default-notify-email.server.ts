import { DEFAULT_NOTIFY_EMAIL_GLOBAL_KEY, isPlaceholderEmail, maskEmail } from './default-notify-email.shared'

function timestamp() {
  return new Date().toISOString()
}

function envSummary() {
  return {
    nodeEnv: process.env.NODE_ENV ?? null,
    platform: process.env.VERCEL ? 'vercel' : 'custom',
    totalKeys: Object.keys(process.env).length,
  }
}

type DiagnosticLevel = 'log' | 'error'

type DiagnosticPayload = Record<string, unknown>

function log(level: DiagnosticLevel, step: string, payload: DiagnosticPayload = {}) {
  const entry = { ...payload, envSummary: envSummary() }
  const message = `[diagnostic] ${timestamp()} ${step} ${JSON.stringify(entry)}`
  if (level === 'error') {
    console.error(message)
  } else {
    console.log(message)
  }
}

const hypotheses = [
  'DEFAULT_NOTIFY_EMAIL may be unset in the current deployment environment.',
  'DEFAULT_NOTIFY_EMAIL could still be using a placeholder fallback.',
  'Environment variable whitespace or formatting might be trimming to an empty string.',
]

export function resolveDefaultNotifyEmailServer(): string {
  log('log', 'default-email:resolve:start', { hypotheses })
  const raw = process.env.DEFAULT_NOTIFY_EMAIL
  if (typeof raw !== 'string') {
    log('error', 'default-email:resolve:missing', { reason: 'not_set' })
    throw new Error('DEFAULT_NOTIFY_EMAIL is required for server workflows but was not provided.')
  }
  const trimmed = raw.trim()
  if (!trimmed.length) {
    log('error', 'default-email:resolve:missing', { reason: 'empty_after_trim' })
    throw new Error('DEFAULT_NOTIFY_EMAIL is required for server workflows but was not provided.')
  }
  if (isPlaceholderEmail(trimmed)) {
    log('error', 'default-email:resolve:fallback', { emailPreview: maskEmail(trimmed) })
    throw new Error('DEFAULT_NOTIFY_EMAIL is using a fallback placeholder; configure a production address.')
  }
  log('log', 'default-email:resolve:success', { emailPreview: maskEmail(trimmed) })
  return trimmed
}

export function buildDefaultNotifyEmailBootstrapScript(): string {
  const email = resolveDefaultNotifyEmailServer()
  const masked = maskEmail(email)
  log('log', 'default-email:bootstrap-script:emit', { emailPreview: masked })
  const globalKey = JSON.stringify(DEFAULT_NOTIFY_EMAIL_GLOBAL_KEY)
  const emailLiteral = JSON.stringify(email)
  const maskedLiteral = JSON.stringify(masked)
  return `(() => {\n  const step = 'default-email:bootstrap:apply'\n  const now = new Date().toISOString()\n  const summary = typeof window === 'undefined'\n    ? { origin: '__no_window__', pathname: '__no_window__' }\n    : { origin: window.location.origin, pathname: window.location.pathname }\n  const email = ${emailLiteral}\n  const key = ${globalKey}\n  window[key] = email\n  const payload = { source: 'server-inline-script', emailPreview: ${maskedLiteral}, summary }\n  console.log('[diagnostic] ' + now + ' ' + step + ' ' + JSON.stringify(payload))\n  window.dispatchEvent(new CustomEvent('default-notify-email:ready', { detail: { email } }))\n})()`
}

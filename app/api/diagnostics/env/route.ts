export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Severity = 'ok' | 'warn' | 'error' | 'info'

type ValidationOutcome = {
  severity: Severity
  message?: string
  strictFailure?: boolean
}

type EnvCheck = {
  key: string
  label?: string
  description?: string
  required?: boolean
  validate?: (value: string | undefined) => ValidationOutcome
}

type EnvGroup = {
  cat: string
  checks: EnvCheck[]
}

type CheckOutcome = {
  key: string
  label: string
  description?: string
  value: string | null
  severity: Severity
  message?: string
  strictFailure: boolean
}

const looksLikeUUID = (v?: string) => !!v && /^[0-9a-fA-F-]{32,}$/.test(v)
const looksLikeURL = (v?: string) => !!v && /^https?:\/\//.test(v)
const looksLikeToken = (v?: string) => !!v && v.trim().length > 20
const looksLikeEmail = (v?: string) => !!v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)

const FALLBACK_EMAILS = new Set(['a@sarva.co', 'noreply@example.com'])
const FALLBACK_GOOGLE_MODEL = 'gemini-2.5-flash-lite'

const formatTimestamp = () => new Date().toISOString()

const envSummary = () => ({
  totalKeys: Object.keys(process.env).length,
  nodeEnv: process.env.NODE_ENV ?? null,
  platform: process.env.VERCEL ? 'vercel' : 'custom',
  vercelEnv: process.env.VERCEL_ENV ?? null,
})

function logStep(step: string, payload?: Record<string, unknown>) {
  const summary = envSummary()
  const merged = { ...payload, envSummary: summary }
  console.log(`[diagnostic] ${formatTimestamp()} ${step} ${JSON.stringify(merged)}`)
}

function logError(step: string, error: unknown, payload?: Record<string, unknown>) {
  const summary = envSummary()
  const normalizedError =
    error instanceof Error
      ? { message: error.message, name: error.name, stack: error.stack }
      : { message: 'Non-error rejection', value: error }
  const merged = { ...payload, envSummary: summary, error: normalizedError }
  console.error(`[diagnostic] ${formatTimestamp()} ${step} ${JSON.stringify(merged)}`)
}

const pass = (message?: string): ValidationOutcome => ({ severity: 'ok', message })
const warn = (message: string): ValidationOutcome => ({ severity: 'warn', message })
const fail = (message: string, strictFailure = true): ValidationOutcome => ({ severity: 'error', message, strictFailure })

const GROUPS: EnvGroup[] = [
  {
    cat: 'Vercel + Supabase storage',
    checks: [
      {
        key: 'VERCEL',
        label: 'Running on Vercel',
        validate: (value) => (value ? pass('VERCEL is set; Vercel platform detected.') : warn('VERCEL is not set.')),
      },
      {
        key: 'VERCEL_ENV',
        label: 'Vercel environment',
        validate: (value) => (value ? pass(`Environment: ${value}`) : warn('VERCEL_ENV missing; unable to label deploy context.')),
      },
      {
        key: 'STORAGE_MODE',
        label: 'Storage mode',
        required: true,
        validate: (value) => {
          if (value !== 'supabase') return fail(`STORAGE_MODE must be "supabase" on Vercel; received ${value ?? 'unset'}.`)
          return pass('Supabase storage selected.')
        },
      },
      {
        key: 'SUPABASE_URL',
        label: 'Supabase URL',
        required: true,
        validate: (value) => {
          if (!value) return fail('SUPABASE_URL is required for storage operations.')
          if (!looksLikeURL(value)) return fail('SUPABASE_URL must start with https:// and include the project ref host.', true)
          const host = (() => {
            try {
              return new URL(value).host
            } catch {
              return null
            }
          })()
          if (!host) return fail('SUPABASE_URL could not be parsed. Provide the full https://<project>.supabase.co URL.', true)
          if (!host.endsWith('.supabase.co') && !host.endsWith('.supabase.net')) {
            return fail(`SUPABASE_URL host must end with .supabase.co or .supabase.net. Received ${host}`, true)
          }
          return pass(`Host detected: ${host}`)
        },
      },
      {
        key: 'SUPABASE_SERVICE_ROLE_KEY',
        label: 'Supabase service role key',
        required: true,
        validate: (value) => {
          if (!value) return fail('SUPABASE_SERVICE_ROLE_KEY is required for writes.')
          return looksLikeToken(value)
            ? pass(`Length ${value.length} looks valid.`)
            : fail('Service role key is shorter than expected; verify copy/paste.', false)
        },
      },
      {
        key: 'SUPABASE_STORAGE_BUCKET',
        label: 'Supabase bucket name',
        required: true,
        validate: (value) => (value ? pass(`Bucket: ${value}`) : fail('SUPABASE_STORAGE_BUCKET is required.')),
      },
    ],
  },
  {
    cat: 'Turn storage + client Supabase diagnostics',
    checks: [
      {
        key: 'SUPABASE_TURNS_TABLE',
        label: 'Supabase turns table (server)',
        required: true,
        validate: (value) =>
          value
            ? pass(`Using server table ${value}.`)
            : fail('SUPABASE_TURNS_TABLE is required for turn writes; no fallback assumed.'),
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_TURNS_TABLE',
        label: 'Supabase turns table (client fallback)',
        required: true,
        validate: (value) => {
          if (value) {
            return pass(`Client turns table configured: ${value}`)
          }

          if (process.env.SUPABASE_TURNS_TABLE) {
            return warn('Client fallback missing; relying on server SUPABASE_TURNS_TABLE only.')
          }

          return fail('Both SUPABASE_TURNS_TABLE and NEXT_PUBLIC_SUPABASE_TURNS_TABLE are missing.')
        },
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_URL',
        label: 'Supabase URL (client)',
        required: true,
        validate: (value) =>
          value
            ? looksLikeURL(value)
              ? pass('Client Supabase URL detected.')
              : fail('NEXT_PUBLIC_SUPABASE_URL must be a full https:// URL.')
            : fail('NEXT_PUBLIC_SUPABASE_URL missing; client storage diagnostics cannot run.'),
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET',
        label: 'Supabase bucket (client)',
        required: true,
        validate: (value) =>
          value
            ? pass(`Client bucket: ${value}`)
            : fail('NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET missing; client diagnostics cannot mirror storage.'),
      },
      {
        key: 'NEXT_PUBLIC_VERCEL_ENV',
        label: 'Client Vercel environment',
        required: true,
        validate: (value) =>
          value
            ? pass(`Client-side environment: ${value}`)
            : warn('NEXT_PUBLIC_VERCEL_ENV missing; client env summary will be incomplete.'),
      },
      {
        key: 'NEXT_PUBLIC_DEFAULT_NOTIFY_EMAIL',
        label: 'Default notification email (client)',
        validate: (value) =>
          value
            ? looksLikeEmail(value)
              ? pass('Client default email configured.')
              : warn('Client default email present but format looks unusual.')
            : warn('NEXT_PUBLIC_DEFAULT_NOTIFY_EMAIL missing; diagnostics will rely on server value.'),
      },
    ],
  },
  {
    cat: 'Google AI',
    checks: [
      {
        key: 'GOOGLE_API_KEY',
        label: 'Google API key',
        required: true,
        validate: (value) => {
          if (!value) {
            return fail('GOOGLE_API_KEY is required to reach Gemini endpoints.')
          }
          return looksLikeToken(value)
            ? pass('Token length looks valid.')
            : warn('Key provided but shorter than expected; double-check copy/paste.')
        },
      },
      {
        key: 'GOOGLE_MODEL',
        label: 'Primary Gemini model',
        required: true,
        validate: (value) => {
          if (!value) {
            return fail('GOOGLE_MODEL must be configured to avoid fallback defaults.')
          }
          if (value === FALLBACK_GOOGLE_MODEL) {
            return fail('Using fallback Gemini model; set GOOGLE_MODEL explicitly.', true)
          }
          return pass('Custom model configured.')
        },
      },
    ],
  },
  {
    cat: 'OpenAI',
    checks: [
      {
        key: 'OPENAI_API_KEY',
        label: 'OpenAI API key',
        required: true,
        validate: (value) =>
          value
            ? looksLikeToken(value)
              ? pass('Token length looks valid.')
              : fail('Token present but shorter than expected; verify key.', false)
            : fail('OPENAI_API_KEY missing; OpenAI text and TTS calls will fail.'),
      },
    ],
  },
  {
    cat: 'Email delivery',
    checks: [
      {
        key: 'DEFAULT_NOTIFY_EMAIL',
        label: 'Default notification recipient',
        required: true,
        validate: (value) => {
          if (!value) {
            return fail('DEFAULT_NOTIFY_EMAIL is required; refusing to fallback to baked-in defaults.')
          }
          if (FALLBACK_EMAILS.has(value)) {
            return fail('DEFAULT_NOTIFY_EMAIL is using a fallback placeholder; configure a production address.', true)
          }
          return looksLikeEmail(value)
            ? pass('Valid email detected.')
            : warn('Email present but format looks unusual; confirm it is valid.')
        },
      },
      {
        key: 'MAIL_FROM',
        label: 'Sender address',
        required: true,
        validate: (value) => {
          if (!value) {
            return fail('MAIL_FROM missing; session summaries cannot be sent safely.')
          }
          if (FALLBACK_EMAILS.has(value)) {
            return warn('Using fallback MAIL_FROM; set a verified sender for production.')
          }
          return looksLikeEmail(value)
            ? pass('Sender address format looks valid.')
            : warn('MAIL_FROM set but format looks unusual.')
        },
      },
      {
        key: 'RESEND_API_KEY',
        label: 'Resend API key',
        validate: (value) =>
          value
            ? looksLikeToken(value)
              ? pass('Token length looks valid.')
              : warn('Token present but shorter than expected; verify key.')
            : warn('Missing; Resend email sending disabled.'),
      },
      {
        key: 'SENDGRID_API_KEY',
        label: 'SendGrid API key',
        validate: (value) =>
          value
            ? looksLikeToken(value)
              ? pass('Token length looks valid.')
              : warn('Token present but shorter than expected; verify key.')
            : warn('Missing; SendGrid email sending disabled.'),
      },
      {
        key: 'ENABLE_SESSION_EMAILS',
        label: 'Session email toggle',
        validate: (value) =>
          value
            ? pass(`Explicit toggle set to "${value}".`)
            : warn('Missing; defaults to false and emails will not auto-send.'),
      },
    ],
  },
  {
    cat: 'Deployment metadata + commits',
    checks: [
      {
        key: 'MY_DEPLOY_ID',
        label: 'Custom deploy id',
        validate: (value) => (value ? pass(`Custom deploy id ${value}.`) : warn('MY_DEPLOY_ID missing; custom deploy tracking disabled.')),
      },
      {
        key: 'DEPLOY_ID',
        label: 'Generic deploy id',
        validate: (value) => (value ? pass(`DEPLOY_ID ${value}.`) : warn('DEPLOY_ID missing.')),
      },
      {
        key: 'VERCEL_DEPLOYMENT_ID',
        label: 'Vercel deployment id',
        validate: (value) => (value ? pass(`Vercel deployment id ${value}.`) : warn('VERCEL_DEPLOYMENT_ID missing.')),
      },
      {
        key: 'VERCEL_DEPLOY_ID',
        label: 'Vercel deploy id',
        validate: (value) => (value ? pass(`Vercel deploy id ${value}.`) : warn('VERCEL_DEPLOY_ID missing.')),
      },
      {
        key: 'VERCEL_BUILD_ID',
        label: 'Vercel build id',
        validate: (value) => (value ? pass(`Vercel build id ${value}.`) : warn('VERCEL_BUILD_ID missing.')),
      },
      {
        key: 'NEXT_PUBLIC_DEPLOY_ID',
        label: 'Client deploy id',
        validate: (value) =>
          value ? pass(`Client deploy id ${value}.`) : warn('NEXT_PUBLIC_DEPLOY_ID missing; client deploy summary incomplete.'),
      },
      {
        key: 'SITE_NAME',
        label: 'Generic site name',
        validate: (value) => (value ? pass(`Site name ${value}.`) : warn('SITE_NAME missing; site metadata incomplete.')),
      },
      {
        key: 'NEXT_PUBLIC_GITHUB_REPOSITORY',
        label: 'Client GitHub repository',
        validate: (value) => (value ? pass(`Client repo ${value}.`) : warn('NEXT_PUBLIC_GITHUB_REPOSITORY missing.')),
      },
      {
        key: 'COMMIT_REF',
        label: 'Commit ref',
        validate: (value) => (value ? pass(`Commit ref ${value}.`) : warn('COMMIT_REF missing; deploy history unclear.')),
      },
      {
        key: 'GIT_COMMIT_SHA',
        label: 'Git commit SHA',
        validate: (value) => (value ? pass(`Git SHA ${value}.`) : warn('GIT_COMMIT_SHA missing.')),
      },
      {
        key: 'COMMIT_MESSAGE',
        label: 'Commit message',
        validate: (value) => (value ? pass('Commit message detected.') : warn('COMMIT_MESSAGE missing.')),
      },
      {
        key: 'GIT_COMMIT_MESSAGE',
        label: 'Git commit message',
        validate: (value) => (value ? pass('Git commit message detected.') : warn('GIT_COMMIT_MESSAGE missing.')),
      },
      {
        key: 'COMMIT_TIMESTAMP',
        label: 'Commit timestamp',
        validate: (value) => (value ? pass(`Commit timestamp ${value}.`) : warn('COMMIT_TIMESTAMP missing.')),
      },
      {
        key: 'GIT_COMMIT_TIMESTAMP',
        label: 'Git commit timestamp',
        validate: (value) => (value ? pass(`Git commit timestamp ${value}.`) : warn('GIT_COMMIT_TIMESTAMP missing.')),
      },
      {
        key: 'BRANCH',
        label: 'Branch name',
        validate: (value) => (value ? pass(`Branch ${value}.`) : warn('BRANCH missing.')),
      },
      {
        key: 'HEAD',
        label: 'HEAD ref',
        validate: (value) => (value ? pass(`HEAD ${value}.`) : warn('HEAD missing; unable to reference current ref.')),
      },
    ],
  },
  {
    cat: 'Runtime + upload diagnostics',
    checks: [
      {
        key: 'AWS_REGION',
        label: 'AWS region',
        validate: (value) => (value ? pass(`AWS region ${value}.`) : warn('AWS_REGION missing; upload logging may be incomplete.')),
      },
      {
        key: 'AWS_DEFAULT_REGION',
        label: 'AWS default region',
        validate: (value) =>
          value ? pass(`AWS default region ${value}.`) : warn('AWS_DEFAULT_REGION missing; upload logging may be incomplete.'),
      },
      {
        key: 'NEXT_RUNTIME',
        label: 'Next.js runtime',
        validate: (value) => (value ? pass(`NEXT_RUNTIME=${value}`) : pass('NEXT_RUNTIME not exported; assuming node runtime.')),
      },
    ],
  },
  {
    cat: 'Application & System',
    checks: [
      {
        key: 'PROVIDER',
        label: 'Audio provider override',
        required: true,
        validate: (value) => {
          if (!value) {
            return fail('PROVIDER must be set to "google" for audio diagnostics.')
          }
          if (value !== 'google') {
            return fail(`PROVIDER must be "google"; received "${value}".`)
          }
          return pass('Audio provider locked to google.')
        },
      },
      {
        key: 'NODE_VERSION',
        label: 'Node version',
        validate: (value) => (value ? pass(`Running Node ${value}.`) : warn('NODE_VERSION missing; runtime parity cannot be verified.')),
      },
      {
        key: 'NODE_ENV',
        label: 'Node environment',
        validate: (value) => (value ? pass(`NODE_ENV=${value}`) : warn('NODE_ENV missing; defaults to production on many platforms.')),
      },
      {
        key: 'CI',
        label: 'CI flag',
        validate: (value) => (value ? pass(`CI=${value}`) : pass('Not running in CI.')),
      },
      {
        key: 'SITE_ID',
        label: 'Site ID',
        validate: (value) => (value ? pass(`SITE_ID=${value}`) : warn('SITE_ID missing; some logs cannot correlate to site.')),
      },
      {
        key: 'CONTEXT',
        label: 'Build context',
        validate: (value) => (value ? pass(`CONTEXT=${value}`) : warn('CONTEXT missing; build context unknown.')),
      },
      {
        key: 'DEPLOY_URL',
        label: 'Published deploy URL',
        validate: (value) =>
          value
            ? looksLikeURL(value)
              ? pass('Deploy URL detected.')
              : fail('DEPLOY_URL should be a full URL starting with http(s)://', false)
            : warn('DEPLOY_URL missing; production links may not resolve.'),
      },
      {
        key: 'DEPLOY_PRIME_URL',
        label: 'Preview deploy URL',
        validate: (value) =>
          value
            ? looksLikeURL(value)
              ? pass('Preview URL detected.')
              : fail('DEPLOY_PRIME_URL should be a full URL starting with http(s)://', false)
            : warn('DEPLOY_PRIME_URL missing; preview deploy link unavailable.'),
      },
      {
        key: 'URL',
        label: 'Primary site URL',
        validate: (value) =>
          value
            ? looksLikeURL(value)
              ? pass('Site URL detected.')
              : fail('URL should be a full URL starting with http(s)://', false)
            : warn('Primary site URL missing; configure a production domain.'),
      },
      {
        key: 'GITHUB_REPOSITORY',
        label: 'GitHub repository',
        validate: (value) => (value ? pass(`Repository ${value}.`) : warn('GITHUB_REPOSITORY missing; commit links may break.')),
      },
      {
        key: 'PLAYWRIGHT_TEST_BASE_URL',
        label: 'Playwright base URL',
        validate: (value) => (value ? pass('Custom Playwright base URL configured.') : pass('Using default Playwright localhost.')),
      },
    ],
  },
]

const severityColors: Record<Severity, string> = {
  ok: '#3fb950',
  warn: '#e3b341',
  error: '#f85149',
  info: '#58a6ff',
}

const severityLabels: Record<Severity, string> = {
  ok: '✅ OK',
  warn: '⚠️ Check',
  error: '❌ Error',
  info: 'ℹ️ Info',
}

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

function runCheck(def: EnvCheck, env: NodeJS.ProcessEnv): CheckOutcome {
  const rawValue = env[def.key]
  const label = def.label ?? def.key
  const validation = def.validate?.(rawValue)
  let severity: Severity
  let message: string | undefined
  let strictFailure = Boolean(def.required)

  if (validation) {
    severity = validation.severity
    message = validation.message
    if (typeof validation.strictFailure === 'boolean') {
      strictFailure = validation.strictFailure
    } else if (severity !== 'error') {
      strictFailure = false
    }
  } else if (!rawValue) {
    severity = def.required ? 'error' : 'warn'
    message = def.required
      ? `${def.key} is required.`
      : `${def.key} not set; verify if this is intentional.`
  } else {
    severity = 'ok'
  }

  if (!rawValue) {
    strictFailure = strictFailure && severity === 'error'
  }

  return {
    key: def.key,
    label,
    description: def.description,
    value: rawValue ?? null,
    severity,
    message,
    strictFailure,
  }
}

function buildGroupOutcomes(env: NodeJS.ProcessEnv) {
  const resultMap = new Map<string, CheckOutcome>()
  const groups = GROUPS.map((group) => {
    const outcomes = group.checks.map((check) => {
      const outcome = runCheck(check, env)
      resultMap.set(outcome.key, outcome)
      return outcome
    })
    return { ...group, outcomes }
  })
  return { groups, resultMap }
}

export async function GET(request: Request) {
  try {
    logStep('env-diagnostics:start')
    const hypotheses = [
      'Required environment variables might be missing or using fallback placeholders.',
      'Blob storage credentials may not match the current Netlify site configuration.',
      'Email delivery could be disabled because provider API keys are absent.',
      'Google AI access may fail if the API key or model name is unset.',
    ]
    logStep('env-diagnostics:hypotheses', { hypotheses })
    const env = process.env
    const { groups, resultMap } = buildGroupOutcomes(env)

    const requestUrl = new URL(request.url)
    const requestedFormat = requestUrl.searchParams.get('format')
    const acceptHeader = request.headers.get('accept') ?? ''
    const wantsJson =
      (requestedFormat && requestedFormat.toLowerCase() === 'json') ||
      acceptHeader.toLowerCase().includes('application/json')

    const allEnvKeys = Object.keys(env).sort()
    const knownKeys = new Set(Array.from(resultMap.keys()))
    const unknownKeys = allEnvKeys.filter((key) => !knownKeys.has(key))
    const criticalFailures: string[] = []

    for (const outcome of resultMap.values()) {
      if (outcome.severity === 'error' && outcome.strictFailure) {
        criticalFailures.push(outcome.key)
      }
    }

    const collectIssues = (keys: string[]) =>
      keys
        .map((key) => resultMap.get(key))
        .filter((outcome): outcome is CheckOutcome => !!outcome && outcome.severity !== 'ok')

    const blobIssues = collectIssues([
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_STORAGE_BUCKET',
    ])
    const emailIssues = collectIssues([
      'DEFAULT_NOTIFY_EMAIL',
      'RESEND_API_KEY',
      'SENDGRID_API_KEY',
      'ENABLE_SESSION_EMAILS',
    ])
    const googleIssues = collectIssues(['GOOGLE_API_KEY', 'GOOGLE_MODEL'])

    const hypothesisEvaluations = [
      {
        hypothesis: hypotheses[0],
        confirmed: criticalFailures.length > 0,
        evidence: criticalFailures,
      },
      {
        hypothesis: hypotheses[1],
        confirmed: blobIssues.length > 0,
        evidence: blobIssues.map((issue) => ({ key: issue.key, severity: issue.severity })),
      },
      {
        hypothesis: hypotheses[2],
        confirmed: emailIssues.length > 0,
        evidence: emailIssues.map((issue) => ({ key: issue.key, severity: issue.severity })),
      },
      {
        hypothesis: hypotheses[3],
        confirmed: googleIssues.length > 0,
        evidence: googleIssues.map((issue) => ({ key: issue.key, severity: issue.severity })),
      },
    ]

    logStep('env-diagnostics:checks-complete', {
      totals: {
        groups: groups.length,
        knownKeys: knownKeys.size,
        unknownKeys: unknownKeys.length,
        criticalFailures,
      },
    })

    logStep('env-diagnostics:hypothesis-evaluation', {
      evaluations: hypothesisEvaluations,
    })

    const unknownOutcomes: CheckOutcome[] = unknownKeys.map((key) => ({
      key,
      label: key,
      value: env[key] ?? null,
      severity: 'ok',
      message: 'Not part of the curated diagnostics set.',
      strictFailure: false,
    }))

    const summaryCounts = {
      total: allEnvKeys.length,
      errors: criticalFailures.length,
      warnings:
        Array.from(resultMap.values()).filter((outcome) => outcome.severity === 'warn').length,
    }

    const allRows = [...groups.flatMap((group) => group.outcomes), ...unknownOutcomes]
    const sortedAllRows = [...allRows].sort((a, b) => a.key.localeCompare(b.key))
    const statusCode = criticalFailures.length ? 500 : 200

    if (wantsJson) {
      const jsonPayload = {
        ok: statusCode === 200,
        summary: {
          total: summaryCounts.total,
          errors: criticalFailures.length,
          warnings: summaryCounts.warnings,
        },
        env: sortedAllRows.map((outcome) => ({
          key: outcome.key,
          value: outcome.value ?? null,
          severity: outcome.severity,
          message: outcome.message ?? null,
        })),
      }

      logStep('env-diagnostics:json-rendered', {
        statusCode,
        criticalFailures,
        warnings: summaryCounts.warnings,
        total: jsonPayload.env.length,
      })

      return Response.json(jsonPayload, { status: statusCode })
    }

    const groupedHtml = groups
      .map((group) => {
        const rows = group.outcomes
          .map((outcome) => {
            const value = outcome.value ?? '(undefined)'
            const color = severityColors[outcome.severity]
            const label = severityLabels[outcome.severity]
            const message = outcome.message ? `<div class="note">${escapeHtml(outcome.message)}</div>` : ''
            return `
              <tr>
                <td>${escapeHtml(outcome.label)}</td>
                <td style="color:${color}; font-weight:bold">${label}</td>
                <td>${escapeHtml(value)}</td>
                <td>${message}</td>
              </tr>
            `
          })
          .join('')
        return `
          <section>
            <h2>${escapeHtml(group.cat)}</h2>
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Status</th>
                  <th>Value</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </section>
        `
      })
      .join('')

    const unknownHtml = unknownOutcomes.length
      ? `
        <section>
          <h2>Unclassified Environment Variables (${unknownOutcomes.length})</h2>
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Status</th>
                <th>Value</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              ${unknownOutcomes
                .map((outcome) => {
                  const value = outcome.value ?? '(undefined)'
                  const color = severityColors[outcome.severity]
                  const label = severityLabels[outcome.severity]
                  const message = outcome.message ? `<div class="note">${escapeHtml(outcome.message)}</div>` : ''
                  return `
                    <tr>
                      <td>${escapeHtml(outcome.label)}</td>
                      <td style="color:${color}; font-weight:bold">${label}</td>
                      <td>${escapeHtml(value)}</td>
                      <td>${message}</td>
                    </tr>
                  `
                })
                .join('')}
            </tbody>
          </table>
        </section>
      `
      : ''

    const allEnvHtml = `
      <section>
        <h2>All Environment Variables (${summaryCounts.total})</h2>
        <table class="all-env">
          <thead>
            <tr>
              <th>Key</th>
              <th>Status</th>
              <th>Value</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${sortedAllRows
              .map((outcome) => {
                const value = outcome.value ?? '(undefined)'
                const color = severityColors[outcome.severity]
                const label = severityLabels[outcome.severity]
                const message = outcome.message ? `<div class="note">${escapeHtml(outcome.message)}</div>` : ''
                return `
                  <tr>
                    <td>${escapeHtml(outcome.key)}</td>
                    <td style="color:${color}; font-weight:bold">${label}</td>
                    <td>${escapeHtml(value)}</td>
                    <td>${message}</td>
                  </tr>
                `
              })
              .join('')}
          </tbody>
        </table>
      </section>
    `

    const html = `
      <html>
      <head>
        <title>Full Environment Diagnostics</title>
        <style>
          body { font-family: 'Inter', 'Segoe UI', sans-serif; background:#0d1117; color:#f0f6fc; padding:24px; }
          h1 { font-size:28px; margin-bottom:16px; }
          h2 { border-bottom:1px solid #30363d; padding-bottom:6px; margin-top:32px; }
          table { border-collapse:collapse; width:100%; margin-top:12px; }
          th, td { border:1px solid #30363d; padding:8px 10px; text-align:left; vertical-align:top; }
          th { background:#161b22; }
          tr:nth-child(even) { background:#161b22; }
          .summary { padding:12px 16px; background:#161b22; border:1px solid #30363d; border-radius:6px; }
          .summary strong { display:inline-block; min-width:180px; }
          .note { color:#8b949e; font-size:12px; margin-top:4px; }
        </style>
      </head>
      <body>
        <h1>🧪 Environment Diagnostics</h1>
        <div class="summary">
          <div><strong>Total variables:</strong> ${summaryCounts.total}</div>
          <div><strong>Critical errors:</strong> ${criticalFailures.length}</div>
          <div><strong>Warnings:</strong> ${summaryCounts.warnings}</div>
          <div><strong>Generated at:</strong> ${escapeHtml(formatTimestamp())}</div>
        </div>
        ${criticalFailures.length ? `<p style="color:${severityColors.error}; margin-top:16px;">Critical configuration issues detected: ${criticalFailures
          .map((key) => escapeHtml(key))
          .join(', ')}. Response status set to ${statusCode}.</p>` : ''}
        ${groupedHtml}
        ${unknownHtml}
        ${allEnvHtml}
      </body>
      </html>
    `

    logStep('env-diagnostics:rendered', {
      statusCode,
      criticalFailures,
      warnings: summaryCounts.warnings,
    })

    return new Response(html, {
      status: statusCode,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  } catch (error) {
    logError('env-diagnostics:failed', error)
    const message = error instanceof Error ? error.message : 'Unknown diagnostics failure'
    const html = `
      <html>
      <head>
        <title>Diagnostics Failure</title>
        <style>
          body { font-family: 'Inter', 'Segoe UI', sans-serif; background:#0d1117; color:#f0f6fc; padding:24px; }
          pre { background:#161b22; padding:16px; border:1px solid #30363d; border-radius:6px; }
        </style>
      </head>
      <body>
        <h1>❌ Diagnostics Failure</h1>
        <p>The environment diagnostics route threw an error and returned early.</p>
        <pre>${escapeHtml(message)}</pre>
      </body>
      </html>
    `
    return new Response(html, {
      status: 500,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}

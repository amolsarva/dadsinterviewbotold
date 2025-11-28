import { NextResponse } from 'next/server'
import { jsonErrorResponse } from '@/lib/api-error'
import { sendSummaryEmail } from '@/lib/email'
import { resolveDefaultNotifyEmailServer } from '@/lib/default-notify-email.server'

export async function POST() {
  try {
    const to = resolveDefaultNotifyEmailServer()
    const subject = 'DadsBot – Test Email'
    const body = 'This is a test email from /api/diagnostics/email.'
    const status = await sendSummaryEmail(to, subject, body)

    if (status?.ok) {
      return NextResponse.json({ ok: true, status })
    }

    if (status?.skipped) {
      return NextResponse.json({ ok: false, status, error: 'email_skipped_no_provider' }, { status: 503 })
    }

    return NextResponse.json({ ok: false, status, error: status?.error || 'email_failed' }, { status: 502 })
  } catch (error) {
    return jsonErrorResponse(error, 'Email diagnostics failed')
  }
}



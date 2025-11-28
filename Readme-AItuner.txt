Project: DadsBot — Continuity True-Up (Drop-in Safe)

Keep invariant:
- Single state machine: Idle → Recording → Thinking → Playing → ReadyToContinue → DoneSuccess
  Labels: Start / Done / Cancel / Continue / Continue / Start Again
  Spacebar triggers primary unless typing; disabled blocks input.
- Secondary button: “Finish Session” calls finalize.
- Pages: /, /history, /session/[id], /settings, /diagnostics (do not rename).
- APIs & shapes (don’t break):
  POST /api/session/start → { id }
  POST /api/session/:id/turn → { id, role, text, audio_blob_url? }
  POST /api/session/:id/finalize → { ok, session, emailed }
  GET  /api/history → { items: [...] }
  GET  /api/health → { ok, env, blob, db }
  POST /api/diagnostics/smoke → { ok, sessionId, artifacts, emailed }
- Adapters depend on configured envs:
  Blob → Netlify store; Email → Resend when enabled; AI → provider keys required.
- UI behaviors to preserve:
  Greeting voice on Home (SpeechSynthesis).
  On-screen log on Home.
  Diagnostics page with Health + Smoke and copyable log.
- Shipping scaffolding:
  next.config.js (output: 'standalone'), vercel.json (outputDirectory: '.next').
  README must match behavior; include .env.local.example. No new routes without updating README & Diagnostics.

Deliver:
- A single zip drop-in that compiles with Next 14, uses Netlify-managed envs, and preserves everything above.
- Do not remove Diagnostics or the on-screen log.

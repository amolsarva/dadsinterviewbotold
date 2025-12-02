# DadsBot

DadsBot is a Next.js 14 app that captures long-form oral histories with warm, biographer-style prompts. This README consolidates the scattered docs across the repo so you can bootstrap, deploy, and debug without hunting for context.

## Product snapshot
- **Purpose:** capture long-form oral histories with the [Interview Guide](docs/interview-guide.md) tone.
- **Session flow:** one-button capture, automatic speech-to-text, assistant reply synthesis, and optional email summaries.
- **Continuity tools:** per-user memory primers, session manifests, fallbacks pulled from structured copy, and diagnostics surfaces for operators.
- **Interface highlights:** compact account selector with active-handle badge, inline status + debug log, and footer commit stamp linking to the deployed build.

## Experience map
1. **Pick an account** (or create a new handle) from the badge dropdown — history, settings, diagnostics, and primers scope to that handle.
2. **Start recording** from the hero button. The recorder calibrates noise, captures the user turn, and posts it to `/api/ask-audio`.
3. **Ask pipeline:**
   - Session memory (history, asked questions, primer) is fetched via `lib/data.ts`.
   - Google Gemini is prompted with the interview guide, primer snapshot, and recent turns. If it fails, curated fallbacks from `docs/fallback-texts.md` keep the interview moving.
   - The assistant reply plays through the recorder when available, otherwise falls back to browser SpeechSynthesis.
4. **Finalize session:** `/api/finalize-session` renders transcripts, emails the recap when configured, archives manifests, and rewrites the per-user memory primer.
5. **Review + iterate:** `/history`, `/settings`, and `/diagnostics` expose transcripts, account preferences, recent API errors, and locally cached debug payloads. Session manifests (the "Memory Log" view of each recording) are persisted under the `sessions/` blob prefix for download or inspection.

## Deployment & hosting
- **Reference hosting:** Netlify + Blobs/Functions was the previous target; Vercel + Supabase is now the reference deployment for Next.js 14 with App Router.
- **Netlify migration status:** Prior checklists referenced `docs/netlify-migration-guide.md`, but that file is absent. Use the hosting comparison below and the Supabase checklist to configure storage and diagnostics.
- **Platform comparison:**
  - **Vercel + Supabase (recommended):** zero-config Next.js deploys with Supabase storage. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` in every environment.
  - **Cloudflare Pages + Workers + R2:** replace `lib/blob.ts` with an R2 helper and supply R2 credentials explicitly.
  - **Render + S3-compatible storage:** wire `lib/blob.ts` to S3/B2/R2; preview deploys are manual.
  - **AWS Amplify Hosting + S3:** update `lib/blob.ts` for S3 and configure IAM roles explicitly.
  - **Fly.io + S3-compatible storage:** bring your own CI/CD; ensure storage env vars exist before boot.

## Environment variables
- **Supabase storage:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` (validated in `utils/blob-env.ts`).
- **Supabase tables:** `SUPABASE_TURNS_TABLE` (optional but recommended), `SUPABASE_SESSIONS_TABLE` (required). Client diagnostics expect `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET`, and `NEXT_PUBLIC_SUPABASE_TURNS_TABLE`.
- **Email:** `DEFAULT_NOTIFY_EMAIL` must be a real inbox; validated on server bootstrap.
- **Providers:** `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `SENDGRID_API_KEY` as applicable. No defaults are assumed. `GOOGLE_MODEL` must be set wherever Google calls are used.
- **Platform context:** diagnostics log `VERCEL`, `VERCEL_ENV`, and `NODE_ENV` for traceability.

## Supabase setup
- **Bucket readiness:** service role must be allowed to list/create buckets and objects; `lib/blob.ts` will attempt bucket creation (`public: false`). Storage policies must allow service-role uploads/list/deletes.
- **Sessions table:** use `docs/supabase-schema.sql` to create/align `public.sessions` with `id`, `created_at`, `email_to`, `status`, `duration_ms`, `total_turns`, and `artifacts` columns (UUID `id` is required).
- **Turns table:** ensure columns `session_id`, `turn`, and `transcript` exist alongside optional `assistant_reply`, `provider`, `manifest_url`, `user_audio_url`, `assistant_audio_url`, `duration_ms`, and `assistant_duration_ms`. Run the schema script to add indexes and uniqueness constraints.
- **RLS policies:** enable RLS on `public.conversation_turns` and add per-user or per-tenant policies (templates in `docs/conversation-turns-rls.md`). Keep service role access unless you adjust the code paths.
- **Network/domain:** `SUPABASE_URL` must end with `.supabase.co` or `.supabase.net`; allow outbound access from the hosting platform.

## Memory primer lifecycle
- A primer is maintained **per user handle** under `memory/primers/{normalized-handle}.md` (unassigned sessions use `memory/primers/unassigned.md`). Legacy single-primer blobs at `memory/MemoryPrimer.txt` are still cleaned up for backwards compatibility.
- After each finalize:
  1. Key sentences from the latest user turns are categorised by Interview Guide stage.
  2. All sessions for that handle are re-analysed, newest notes flagged as “Latest”, and a biography-style cheat sheet is rewritten.
  3. The markdown snapshot is uploaded to blob storage and cached in-memory for fast reuse.
- Inspect or download primers via the Netlify CLI: `netlify blobs:list --site $NETLIFY_BLOBS_SITE_ID --store memory --prefix primers/` and `netlify blobs:get --site $NETLIFY_BLOBS_SITE_ID --store memory --key primers/<HANDLE>.md`. Session manifests remain under `sessions/{id}/` alongside transcripts.

## Calibration & copy sources
- **Interview scaffolding:** `docs/interview-guide.md` and `lib/interview-guide.ts` load the guide at runtime.
- **Fallback copy system:** edit `docs/fallback-texts.md`, then run `pnpm fallback:sync` to refresh `lib/fallback-texts.ts` and `lib/fallback-texts.generated.ts`. Placeholders like `{DETAIL}` or `{DATE}` are replaced at runtime.
- **Memory primer engine:** `lib/data.ts` manages manifests, blob storage, and the per-handle biography builder.
- **UI copy & styling:** `app/page.tsx`, `app/globals.css`, and `app/layout.tsx` (footer shows commit + timestamp).
- **Automation scripts:** `scripts/extract-fallback-copy.mjs` and other helpers under `scripts/` for blob inspection.

## Diagnostics & audits
- **Diagnostics dashboard:** `/diagnostics` shows health checks, provider failures, and links to localStorage payloads (`DIAGNOSTIC_TRANSCRIPT_STORAGE_KEY`, `DIAGNOSTIC_PROVIDER_ERROR_STORAGE_KEY`). The home panel mirrors recent state transitions; browser storage keeps a rolling log per handle.
- **Blob helpers:** `app/api/blob/[...path]` surfaces inline blob contents using the site’s Netlify credentials. Use `netlify blobs:list`/`netlify blobs:get` to inspect `sessions/` and `memory/primers/` prefixes.
- **OpenAI diagnostics:** `/api/diagnostics/openai` now refuses to run unless both `OPENAI_API_KEY` and `OPENAI_DIAGNOSTICS_MODEL` are set; it logs hypotheses and fails fast with `missing_openai_api_key`/`missing_openai_model` errors when env vars are absent.
- **Google usage audit:**
  - Real Google calls occur in `app/api/ask-audio/route.ts` and `app/api/session/[id]/intro/route.ts` (REST) plus `app/api/diagnostics/google/route.ts` (SDK). All require `GOOGLE_API_KEY` and `GOOGLE_MODEL`.
  - `lib/google.ts` resolves `GOOGLE_MODEL` but ultimately calls OpenAI chat completions.
  - Removing Google: replace REST calls in `ask-audio` and session intro, remove diagnostics route, and drop Google env vars/dependency. Reintroducing Google should centralize client creation and add env validation.

## Hosting diagnostics & branch hygiene
- Diagnostics log platform context and env summaries so deploys fail fast when secrets are missing. Ensure `[diagnostic]` logs remain prefixed and include timestamps in any new tooling.
- Historical branch sync notes (see `docs/branch-sync-report.md`) showed only `main` existed at that time; recreate the branch locally if you need to mirror that baseline.

## ToDoLater highlights
Active backlog lives in [ToDoLater.txt](ToDoLater.txt). Key themes still open:
- **Flow resilience:** restore the richer multi-turn interview cadence, add heartbeat/timeout safeguards, and surface state-change logging for stuck turns.
- **Realtime polish:** integrate robust blob storage + authenticated email delivery, add audio playback diagnostics, and wire streaming/OpenAI voice providers with interruption handling.
- **Product extensions:** expand the history UI (per-turn media + playback), resume sessions with recaps, expose provider switches, and build end-to-end tests for the first-turn/finalize pipeline.

## Quick commands
- **Fallback sync:** `pnpm fallback:sync` after editing fallback copy.
- **Supabase schema:** run statements in `docs/supabase-schema.sql` to align tables and indexes.
- **Netlify blobs inspection:** `netlify blobs:list --site $NETLIFY_BLOBS_SITE_ID --store memory --prefix sessions/` and `netlify blobs:get --site $NETLIFY_BLOBS_SITE_ID --store memory --key sessions/<SESSION_ID>/session.json`.


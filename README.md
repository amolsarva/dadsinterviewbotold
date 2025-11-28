# DadsBot

## Product snapshot
- **Purpose:** capture long-form oral histories with a warm, biographer tone grounded in the [Interview Guide](docs/interview-guide.md).
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

## Calibration & copy sources
- **Interview scaffolding:** `docs/interview-guide.md` (full prompt guide) and `lib/interview-guide.ts` (runtime loader).
- **Fallback copy system:** edit `docs/fallback-texts.md`, then run `pnpm fallback:sync` to refresh `lib/fallback-texts.ts` and `lib/fallback-texts.generated.ts`.
- **Memory primer engine:** `lib/data.ts` — manages in-memory manifests, blob storage, and the per-handle biography builder that organises facts by guide stage.
- **UI copy & styling:** `app/page.tsx`, `app/globals.css`, and `app/layout.tsx` (footer commit/time metadata for continuity-first builds).
- **Automation scripts:** `scripts/extract-fallback-copy.mjs` (sync helper) and `scripts/` utilities for blob inspection.

## Hosting migration resources
- [Netlify migration checklist](docs/netlify-migration-guide.md) — step-by-step instructions for provisioning Netlify Blobs, wiring secrets, and verifying diagnostics after a deploy.
- [Hosting options for Netlify builds](docs/hosting-options.md) — side-by-side comparison of Netlify, Cloudflare, Render, AWS Amplify, and Fly.io for this Next.js build.

## Pages
- `/` Home — one-button flow + **Finish Session**, greeting voice, on-screen log.
- `/history`, `/session/[id]`, `/settings`
- `/diagnostics` — Health + Smoke; copyable log for support.

## Memory primer lifecycle
- A primer is maintained **per user handle** under `memory/primers/{normalized-handle}.md` (unassigned sessions use `memory/primers/unassigned.md`). Legacy single-primer blobs at `memory/MemoryPrimer.txt` are still cleaned up for backwards compatibility.
- After each finalize:
  1. Key sentences from the latest user turns are categorised by Interview Guide stage.
  2. All sessions for that handle are re-analysed, newest notes flagged as “Latest”, and a biography-style cheat sheet is rewritten.
  3. The markdown snapshot is uploaded to blob storage and cached in-memory for fast reuse.
- Inspect or download primers via the Netlify CLI: `netlify blobs:list --site $NETLIFY_BLOBS_SITE_ID --store memory --prefix primers/` and `netlify blobs:get --site $NETLIFY_BLOBS_SITE_ID --store memory --key primers/amol.md` (replace handle as needed). Session manifests remain under `sessions/{id}/` alongside transcripts.

## Diagnostics & operator tooling
- **Diagnostics dashboard:** `/diagnostics` shows recent health checks, captured provider failures, and links to localStorage payloads (`DIAGNOSTIC_TRANSCRIPT_STORAGE_KEY`, `DIAGNOSTIC_PROVIDER_ERROR_STORAGE_KEY`).
- **Logs:** the home panel card mirrors the most recent state transitions for quick triage. Browser storage keeps the rolling log per handle.
- **Blob helpers:** `app/api/blob/[...path]` exposes inline blob contents with the site’s Netlify credentials.
- **Commit stamp:** the footer (see `app/layout.tsx`) links to the active commit and renders the timestamp in US Eastern Time for release tracking.
- **Memory Log review:** use the Netlify CLI to inspect per-session manifests (`netlify blobs:list --site $NETLIFY_BLOBS_SITE_ID --store memory --prefix sessions/`) and fetch specific logs (`netlify blobs:get --site $NETLIFY_BLOBS_SITE_ID --store memory --key sessions/<SESSION_ID>/session.json`). Primers live beside them at `memory/primers/<HANDLE>.md`.

## Deployment & runtime notes
- **Netlify-first storage:** configure `NETLIFY_BLOBS_SITE_ID` (and optionally `NETLIFY_BLOBS_STORE`) so transcripts and manifests stream to Blobs.
- **Providers:** Google Gemini is the default; set `GOOGLE_API_KEY` and `GOOGLE_MODEL` for production. TTS falls back to the browser if `/api/tts` cannot return media.
- **Session storage:** manifests and transcripts stream to Netlify Blobs using the configured site ID and store name.
- **Handles:** normalised via `lib/user-scope.ts` to keep blob paths, localStorage keys, and URLs aligned.

## ToDoLater highlights
Active backlog lives in [ToDoLater.txt](ToDoLater.txt). Key themes still open:
- **Flow resilience:** restore the richer multi-turn interview cadence, add heartbeat/timeout safeguards, and surface state-change logging for stuck turns.
- **Realtime polish:** integrate robust blob storage + authenticated email delivery, add audio playback diagnostics, and wire streaming/OpenAI voice providers with interruption handling.
- **Product extensions:** expand the history UI (per-turn media + playback), resume sessions with recaps, expose provider switches, and build end-to-end tests for the first-turn/finalize pipeline.

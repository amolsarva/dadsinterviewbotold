# Supabase initialization checklist

This project will fail fast when Supabase is misconfigured. Use this list to make sure every dependency exists before hitting `/api/save-turn` or storage endpoints.

## Required environment variables (server)
- `SUPABASE_URL` — project URL (must be an https URL on a Supabase host).
- `SUPABASE_SERVICE_ROLE_KEY` — service role key (not the anon key) for database + storage writes.
- `SUPABASE_STORAGE_BUCKET` — bucket name to read/write audio and manifests.
- `SUPABASE_TURNS_TABLE` — turns table name (optional but recommended; otherwise discovery is attempted).
- `SUPABASE_SESSIONS_TABLE` — **required** sessions table name; no default is assumed.

## Required environment variables (client diagnostics)
- `NEXT_PUBLIC_SUPABASE_TURNS_TABLE` — public hint for the turns table name.
- `NEXT_PUBLIC_SUPABASE_URL` — needed for client-side diagnostics to match the server config.
- `NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET` — needed for client-side storage diagnostics.

## Supabase project prerequisites
1. **Bucket exists or can be created**
   - The service role key must be allowed to list/create buckets and objects.
   - If the bucket does not exist, `lib/blob.ts` will attempt to create it (`public: false`). Ensure your policies allow creation.
   - Storage policies should allow the service role to upload, list, and delete within the bucket.

2. **Turns table shape**
   - Table must include columns: `session_id`, `turn`, `transcript` (code expects these for discovery).
   - Additional columns used by inserts: `assistant_reply`, `provider`, `manifest_url`, `user_audio_url`, `assistant_audio_url`, `duration_ms`, `assistant_duration_ms`.
   - If you provide `SUPABASE_TURNS_TABLE`, it must point to a table with the above columns; otherwise requests will fail early with a clear error.
   - Use `docs/supabase-schema.sql` in the Supabase SQL editor to create or align the `conversation_turns` table and its indexes.

3. **Sessions table shape**
   - Table must include at least `id`, `created_at`, `email_to`, `status`, and `duration_ms` columns; optional columns include `user_handle`, `title`, `artifacts`, and `total_turns`.
   - `SUPABASE_SESSIONS_TABLE` must be set to this table name explicitly; diagnostics will fail fast if it is missing or misnamed.
   - Grant the service role read/write access so health checks and upserts do not return "Could not find the table public.<name>" errors.
   - Run the statements in `docs/supabase-schema.sql` to create the `sessions` table or patch an existing one with the expected defaults and status constraint.

4. **RLS / policies**
   - Database and storage operations rely on the service role; ensure the key is active and not restricted.
   - If you add RLS policies, keep service role access or adjust the code to use an allowed key.

5. **Network + domain expectations**
   - `SUPABASE_URL` host must end with `.supabase.co` or `.supabase.net`.
   - Outbound network access to Supabase must be allowed from the deployment platform.

## Runtime expectations during `/api/save-turn`
1. Env is validated when creating the Supabase client; missing URL/key/bucket throws immediately.
2. Turn table detection queries `information_schema.columns` using the service role. If metadata access is blocked, set `SUPABASE_TURNS_TABLE` explicitly.
3. Audio + manifest uploads go to the configured bucket and require storage write permissions.
4. Database insert uses the resolved turns table and requires insert privileges.

If any step above is missing, the code will emit `[diagnostic]` logs with the failing step and error message. Fix the environment or Supabase project before retrying.

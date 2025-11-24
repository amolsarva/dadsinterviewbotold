# Hosting options for Vercel + Supabase builds

The app is a Next.js 14 project with App Router routes and Supabase Storage for blobs. Vercel is the primary target, but these options explain how to adapt elsewhere.

| Platform | What you get | Gaps / what to configure |
| --- | --- | --- |
| **Vercel + Supabase (recommended)** | Zero-config Next.js deploys, preview URLs, edge network, and a managed Supabase backend for storage. Diagnostics stay green once `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` are set. | Ensure the three Supabase vars are present in every Vercel environment; no fallbacks are assumed. |
| **Cloudflare Pages + Workers + R2** | Automatic builds from Git, global edge execution, and R2 for S3-compatible object storage. | Replace `lib/blob.ts` with an R2-backed helper; supply R2 credentials explicitly. |
| **Render + S3-compatible storage** | Single dashboard for SSR Node services with optional Postgres. | Wire `lib/blob.ts` to S3/B2/R2 and inject credentials via environment variables. Preview deploys are manual. |
| **AWS Amplify Hosting + S3** | Managed Next.js builds and Lambda-backed SSR with first-party S3/SES. | Update `lib/blob.ts` for S3 and configure IAM roles explicitly; no default credentials. |
| **Fly.io + S3-compatible storage** | Regional containers with private networking; full control over topology. | Bring your own CI/CD and storage provider. Ensure all storage env vars are present before boot. |

Vercel + Supabase is now the reference deployment. Other platforms work if the storage helper is pointed at a compatible object store with explicit credentials and the diagnostics routes are updated accordingly.

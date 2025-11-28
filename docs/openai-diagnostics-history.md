# OpenAI diagnostics history

## Summary of behavior change
- **Earlier behavior (Sep 30, 2025)**: The diagnostics endpoint defaulted `OPENAI_DIAGNOSTICS_MODEL` to `gpt-4o-mini` when the env var was missing and returned a 503 only when `OPENAI_API_KEY` was absent. There were no explicit logs describing missing configuration. 【20a2ca†L1-L58】
- **Current behavior (Oct 24, 2025)**: The endpoint now logs explicit hypotheses, refuses to run unless both `OPENAI_API_KEY` and `OPENAI_DIAGNOSTICS_MODEL` are set, and returns a 500 with `missing_openai_api_key`/`missing_openai_model` errors. Each step is prefixed with `[diagnostic]` logging and includes an env summary. 【F:app/api/diagnostics/openai/route.ts†L7-L110】【14df03†L9-L110】

## Why OpenAI is failing now
The deployed diagnostics report `missing_openai_api_key`. That matches the tightened checks added on Oct 24, 2025, which require `OPENAI_API_KEY` (and `OPENAI_DIAGNOSTICS_MODEL`) to be populated before issuing any OpenAI call. Without those env vars, the handler exits early with a 500 error and logs the failure. 【F:app/api/diagnostics/openai/route.ts†L55-L110】

## Evidence from git history
- Initial implementation (Sep 30, 2025) accepted a missing diagnostics model by defaulting to `gpt-4o-mini` and only blocked when `OPENAI_API_KEY` was missing. 【20a2ca†L1-L58】
- The Oct 24, 2025 change introduced hypothesis logging, enforced both env vars, and replaced the default model with a required `OPENAI_DIAGNOSTICS_MODEL`, producing the `missing_openai_api_key`/`missing_openai_model` errors we see now. 【F:app/api/diagnostics/openai/route.ts†L7-L110】【14df03†L9-L110】

## Fix needed for deployment
Set the following env vars in the deployment (no defaults are assumed):
- `OPENAI_API_KEY`
- `OPENAI_DIAGNOSTICS_MODEL` (e.g., `gpt-4o-mini`)

Once both are configured, the diagnostics endpoint will proceed past the early exit and should succeed unless the upstream OpenAI service returns an error.

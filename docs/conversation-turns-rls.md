# conversation_turns Row Level Security (RLS) quickstart

The `public.conversation_turns` table must be locked down before accepting client traffic. Follow these steps in Supabase/Postgres to avoid leaking turns between users or tenants.

## Hypotheses to check first
- RLS is disabled on `public.conversation_turns`, so every authenticated user can see every turn.
- Policies reference the wrong ownership column (e.g., `user_id` vs `profile_id`), causing all queries to be denied.
- Multi-tenant JWTs are missing a `tenant_id` claim or the column is unindexed, making per-tenant filters slow or incorrect.
- Anonymous key is used for write paths, bypassing intended per-user policies.
- Indexes are missing on the policy columns, so even correct policies cause timeouts under load.

Only add or adjust policies after confirming which hypothesis matches your project shape.

## Baseline SQL (per-user ownership)
Run the following in the Supabase SQL editor or psql. Replace the `user_id` column name if your schema differs.

```sql
ALTER TABLE public.conversation_turns ENABLE ROW LEVEL SECURITY;

-- Temporary deny-all policy while you confirm the owner column
CREATE POLICY "deny_all_conversation_turns"
  ON public.conversation_turns
  FOR ALL TO PUBLIC
  USING (false);

-- Per-user read/write
CREATE POLICY "conversation_turns_user_select"
  ON public.conversation_turns
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "conversation_turns_user_insert"
  ON public.conversation_turns
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "conversation_turns_user_update"
  ON public.conversation_turns
  FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "conversation_turns_user_delete"
  ON public.conversation_turns
  FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE INDEX IF NOT EXISTS conversation_turns_user_id_idx
  ON public.conversation_turns (user_id);
```

## Multi-tenant variant
If JWTs include `tenant_id`, switch the checks to the tenant column and value extracted from the token.

```sql
ALTER TABLE public.conversation_turns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_turns_tenant_select"
  ON public.conversation_turns
  FOR SELECT TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "conversation_turns_tenant_insert"
  ON public.conversation_turns
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "conversation_turns_tenant_update"
  ON public.conversation_turns
  FOR UPDATE TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY "conversation_turns_tenant_delete"
  ON public.conversation_turns
  FOR DELETE TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE INDEX IF NOT EXISTS conversation_turns_tenant_id_idx
  ON public.conversation_turns (tenant_id);
```

## Testing expectations
- Use JWTs for anon/authenticated/admin roles to validate visibility and write paths for the chosen ownership model.
- Service-role traffic should still be allowed; adjust policies if you restrict the service role.
- If any test fails, inspect the JWT claims and ensure the expected column (`user_id` or `tenant_id`) exists and is indexed.

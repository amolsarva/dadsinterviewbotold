-- Supabase schema helpers for dadsbot
-- Use these statements to create or align the tables expected by the app.
-- Run them in the SQL editor on your Supabase project with service-role permissions.

-- Required for gen_random_uuid(); safe to run repeatedly.
create extension if not exists "pgcrypto";

-- Sessions table: minimal shape required by server/session-store.ts
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text,
  email_to text not null,
  user_handle text,
  status text not null default 'in_progress',
  duration_ms bigint not null default 0,
  total_turns integer not null default 0,
  artifacts jsonb not null default '{}'::jsonb
);

-- Align an existing sessions table to the expected shape.
alter table public.sessions
  add column if not exists title text,
  add column if not exists email_to text,
  add column if not exists user_handle text,
  add column if not exists status text,
  add column if not exists duration_ms bigint,
  add column if not exists total_turns integer,
  add column if not exists artifacts jsonb;

alter table public.sessions
  alter column id set default gen_random_uuid(),
  alter column created_at set default now(),
  alter column email_to set not null,
  alter column status set not null,
  alter column status set default 'in_progress',
  alter column duration_ms set not null,
  alter column duration_ms set default 0,
  alter column total_turns set not null,
  alter column total_turns set default 0,
  alter column artifacts set not null,
  alter column artifacts set default '{}'::jsonb;

-- Enforce valid status values used by the app.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_status_check') then
    alter table public.sessions
      add constraint sessions_status_check check (status in ('in_progress', 'completed', 'emailed', 'error'));
  end if;
end$$;

-- Conversation turns table: expected by turn-service.ts and types/turns.ts
create table if not exists public.conversation_turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  turn integer not null,
  transcript text not null,
  assistant_reply text,
  provider text,
  manifest_url text,
  user_audio_url text,
  assistant_audio_url text,
  duration_ms bigint,
  assistant_duration_ms bigint,
  created_at timestamptz not null default now()
);

-- Enforce uniqueness per session/turn ordering and helpful indexes.
create unique index if not exists conversation_turns_session_turn_key
  on public.conversation_turns(session_id, turn);
create index if not exists conversation_turns_session_id_idx
  on public.conversation_turns(session_id);

-- Optional foreign key to sessions (enable once sessions table is stable and access policies allow it).
alter table public.conversation_turns
  drop constraint if exists conversation_turns_session_id_fkey,
  add constraint conversation_turns_session_id_fkey foreign key (session_id)
    references public.sessions(id) on delete cascade;

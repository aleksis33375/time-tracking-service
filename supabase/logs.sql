-- Logs table
create table public.logs (
  id          uuid        primary key default gen_random_uuid(),
  timestamp   timestamptz not null default now(),
  level       text        not null check (level in ('info', 'warning', 'error')),
  source      text        not null,
  message     text        not null,
  meta        jsonb       default '{}'
);

-- Queries by time (most recent first)
create index idx_logs_timestamp on public.logs (timestamp desc);

-- Queries by level (e.g. only errors)
create index idx_logs_level on public.logs (level, timestamp desc);

-- Enable Row Level Security
alter table public.logs enable row level security;

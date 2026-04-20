-- Enable pgvector extension for face embeddings
create extension if not exists vector;

-- Employees table
create table public.employees (
  id               uuid          primary key default gen_random_uuid(),
  display_name     text          not null,
  position         text,
  team             text,
  daily_rate       numeric(10,2) not null default 0,
  hourly_rate      numeric(10,4) generated always as (daily_rate / 8) stored,
  face_embedding   vector(128),
  ref_photo_url    text,
  deleted_at       timestamptz   default null,
  created_at       timestamptz   not null default now()
);

-- Fast lookup of active employees (not deleted)
create index idx_employees_active on public.employees (id)
  where deleted_at is null;

-- Fast lookup by team
create index idx_employees_team on public.employees (team)
  where deleted_at is null;

-- Enable Row Level Security
alter table public.employees enable row level security;

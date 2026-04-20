-- Events table
create table public.events (
  id                     uuid          primary key default gen_random_uuid(),
  employee_id            uuid          references public.employees(id) on delete set null,
  photo_url              text,
  photo_timestamp        timestamptz,
  event_type             text          check (event_type in ('arrival', 'departure')),
  event_type_raw         text,
  status                 text          not null default 'pending'
                                       check (status in ('pending', 'processing', 'done', 'needs_review')),
  hours                  numeric(5,2),
  absent_reason          text,
  hours_transferred      numeric(5,2)  default 0,
  processing_started_at  timestamptz,
  name_from_photo        text,
  postcode_from_photo    text,
  fraud_flags            text[]        default '{}',
  created_at             timestamptz   not null default now()
);

-- Batch pickup: AI Worker берёт pending-записи пачками
create index idx_events_pending on public.events (created_at)
  where status = 'pending';

-- Восстановление зависших: записи со status=processing старше 15 минут
create index idx_events_processing on public.events (processing_started_at)
  where status = 'processing';

-- Запросы по сотруднику + дата (для табеля и Табель-страницы)
create index idx_events_employee_date on public.events (employee_id, photo_timestamp);

-- Enable Row Level Security
alter table public.events enable row level security;

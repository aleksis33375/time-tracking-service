-- ─── employees ───────────────────────────────────────────────────────────────
-- Чтение — разрешено authenticated (dashboard)
create policy "Authenticated users can read employees"
  on public.employees for select
  to authenticated
  using (true);

-- Обновление — разрешено authenticated (dashboard редактирует имена/ставки)
create policy "Authenticated users can update employees"
  on public.employees for update
  to authenticated
  using (true);

-- INSERT и DELETE — только через service_role (webhook, ai-worker)
-- Политики намеренно отсутствуют: service_role обходит RLS по умолчанию.

-- ─── events ──────────────────────────────────────────────────────────────────
-- Чтение — разрешено authenticated (dashboard)
create policy "Authenticated users can read events"
  on public.events for select
  to authenticated
  using (true);

-- Обновление — разрешено authenticated (dashboard меняет статус, часы)
create policy "Authenticated users can update events"
  on public.events for update
  to authenticated
  using (true);

-- INSERT и DELETE — только через service_role (webhook, ai-worker)
-- Политики намеренно отсутствуют: service_role обходит RLS по умолчанию.

-- ─── logs ────────────────────────────────────────────────────────────────────
create policy "Authenticated users can read logs"
  on public.logs for select
  to authenticated
  using (true);

create policy "Authenticated users can insert logs"
  on public.logs for insert
  to authenticated
  with check (true);

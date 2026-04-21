-- ─── employees ───────────────────────────────────────────────────────────────
create policy "Authenticated users can read employees"
  on public.employees for select
  to authenticated
  using (true);

create policy "Authenticated users can insert employees"
  on public.employees for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update employees"
  on public.employees for update
  to authenticated
  using (true);

create policy "Authenticated users can delete employees"
  on public.employees for delete
  to authenticated
  using (true);

-- ─── events ──────────────────────────────────────────────────────────────────
create policy "Authenticated users can read events"
  on public.events for select
  to authenticated
  using (true);

create policy "Authenticated users can insert events"
  on public.events for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update events"
  on public.events for update
  to authenticated
  using (true);

create policy "Authenticated users can delete events"
  on public.events for delete
  to authenticated
  using (true);

-- ─── logs ────────────────────────────────────────────────────────────────────
create policy "Authenticated users can read logs"
  on public.logs for select
  to authenticated
  using (true);

create policy "Authenticated users can insert logs"
  on public.logs for insert
  to authenticated
  with check (true);

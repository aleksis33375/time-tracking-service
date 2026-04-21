-- Storage RLS policies for ref-photos bucket
-- Run in Supabase SQL Editor after creating buckets

-- Allow authenticated users to upload/update reference photos
create policy "Authenticated users can upload ref photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'ref-photos');

create policy "Authenticated users can update ref photos"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'ref-photos');

create policy "Authenticated users can read ref photos"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'ref-photos');

create policy "Authenticated users can delete ref photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'ref-photos');

-- Allow authenticated users to manage event photos
create policy "Authenticated users can upload event photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'photos');

create policy "Authenticated users can read event photos"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'photos');

create policy "Authenticated users can delete event photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'photos');

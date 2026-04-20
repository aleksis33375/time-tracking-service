-- Storage buckets for photos
-- photos: incoming photos from Telegram (private)
-- ref-photos: reference photos for face recognition (private)

insert into storage.buckets (id, name, public)
values
  ('photos', 'photos', false),
  ('ref-photos', 'ref-photos', false);

-- Diecast Vault — cloud sync schema.
-- Paste this whole file into Supabase → SQL Editor → New query, then press Run. Safe to run again.

-- ─── Cars ───────────────────────────────────────────────────────────────────
-- One row per model. The model itself lives in `data` (the same shape as the app's JSON backup),
-- so new fields like `year` or `chase` never need a schema change.
create table if not exists public.cars (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at bigint      not null,                  -- edit time from the app (ms since epoch), used for last-write-wins
  deleted    boolean     not null default false,    -- tombstone, so deletions reach your other devices
  synced_at  timestamptz not null default clock_timestamp(), -- server time, the cursor devices pull from
  primary key (user_id, id)
);

create index if not exists cars_user_synced_idx on public.cars (user_id, synced_at);

-- Stamp every write with server time, and ignore writes older than what's stored
-- (a device that was offline can't overwrite a newer edit made elsewhere).
create or replace function public.cars_before_write() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists cars_before_write on public.cars;
create trigger cars_before_write before insert or update on public.cars
  for each row execute function public.cars_before_write();

-- Only you can see or change your rows.
alter table public.cars enable row level security;

drop policy if exists "cars: owner reads" on public.cars;
drop policy if exists "cars: owner inserts" on public.cars;
drop policy if exists "cars: owner updates" on public.cars;
create policy "cars: owner reads"   on public.cars for select using (user_id = auth.uid());
create policy "cars: owner inserts" on public.cars for insert with check (user_id = auth.uid());
create policy "cars: owner updates" on public.cars for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates: a car added on your phone shows up on your laptop without a refresh.
do $$
begin
  alter publication supabase_realtime add table public.cars;
exception when duplicate_object then null;
end $$;

-- ─── Photos ─────────────────────────────────────────────────────────────────
-- Public bucket: photos load like normal images and get cached by the browser.
-- Each file sits under a random, unguessable path; only you can upload or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos: owner uploads" on storage.objects;
drop policy if exists "photos: owner updates" on storage.objects;
drop policy if exists "photos: owner deletes" on storage.objects;
create policy "photos: owner uploads" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: owner updates" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "photos: owner deletes" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ─── Keep-alive ─────────────────────────────────────────────────────────────
-- A tiny public function the scheduled GitHub Action calls every few days so the free project
-- never counts as inactive. It reads nothing.
create or replace function public.keepalive() returns integer
language sql stable as $$ select 1 $$;
grant execute on function public.keepalive() to anon;

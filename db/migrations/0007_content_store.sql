-- 0007: content store bucket + storage policies for creator uploads
insert into storage.buckets (id, name, public)
values ('content-store', 'content-store', false)
on conflict (id) do nothing;

-- creators can upload into their own folder: content-store/<auth.uid>/...
create policy "creator upload own folder"
on storage.objects for insert to authenticated
with check (bucket_id = 'content-store' and (storage.foldername(name))[1] = auth.uid()::text);

-- creators can read their own uploads
create policy "creator read own files"
on storage.objects for select to authenticated
using (bucket_id = 'content-store' and (storage.foldername(name))[1] = auth.uid()::text);

-- creators can delete their own uploads
create policy "creator delete own files"
on storage.objects for delete to authenticated
using (bucket_id = 'content-store' and (storage.foldername(name))[1] = auth.uid()::text);

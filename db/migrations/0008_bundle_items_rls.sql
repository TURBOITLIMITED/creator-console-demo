-- 0008: creators can add items to their own bundles
create policy creator_own_bundle_items on bundle_items
  for all to authenticated
  using (exists (select 1 from content_bundles b where b.id = bundle_id and b.creator_id = auth.uid()::text))
  with check (exists (select 1 from content_bundles b where b.id = bundle_id and b.creator_id = auth.uid()::text));

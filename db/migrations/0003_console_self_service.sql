-- 0003: creator self-service policies for the console (browser path)
-- The console logs creators in with Supabase auth; their creators.id equals auth.uid()::text.
-- Admins keep their existing is_console_admin() read policies.

-- creators: read + insert your own row (id = auth uid)
create policy creator_self_read on creators
  for select to authenticated
  using (id = auth.uid()::text);

create policy creator_self_insert on creators
  for insert to authenticated
  with check (id = auth.uid()::text);

create policy creator_self_update on creators
  for update to authenticated
  using (id = auth.uid()::text)
  with check (id = auth.uid()::text);

-- own-row access on the operational tables the console reads/writes
create policy creator_own_media on media_items
  for all to authenticated
  using (creator_id = auth.uid()::text)
  with check (creator_id = auth.uid()::text);

create policy creator_own_bundles on content_bundles
  for all to authenticated
  using (creator_id = auth.uid()::text)
  with check (creator_id = auth.uid()::text);

create policy creator_own_purchases on bundle_purchases
  for select to authenticated
  using (creator_id = auth.uid()::text);

create policy creator_own_conversations on conversations
  for select to authenticated
  using (creator_id = auth.uid()::text);

create policy creator_own_messages on messages
  for all to authenticated
  using (creator_id = auth.uid()::text)
  with check (creator_id = auth.uid()::text);

create policy creator_own_customers on customers
  for select to authenticated
  using (creator_id = auth.uid()::text);

create policy creator_own_ai_profiles on ai_profiles
  for all to authenticated
  using (creator_id = auth.uid()::text)
  with check (creator_id = auth.uid()::text);

create policy creator_own_connections on business_connections
  for select to authenticated
  using (creator_id = auth.uid()::text);

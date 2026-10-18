-- 0004: let creators manage their own telegram accounts and business connections
create policy creator_own_tg_accounts on telegram_accounts
  for all to authenticated
  using (creator_id = auth.uid()::text)
  with check (creator_id = auth.uid()::text);

create policy creator_own_connections_write on business_connections
  for insert to authenticated
  with check (creator_id = auth.uid()::text);

create policy creator_own_connections_update on business_connections
  for update to authenticated
  using (creator_id = auth.uid()::text)
  with check (creator_id = auth.uid()::text);

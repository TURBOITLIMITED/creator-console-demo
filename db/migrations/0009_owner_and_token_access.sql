-- 0009: owner-write access + token-gated creator content RPCs

-- Owner (console admin) can write everything on behalf of creators
create policy admin_write_media on media_items
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_bundles on content_bundles
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_bundle_items on bundle_items
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_ai_profiles on ai_profiles
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_tg_accounts on telegram_accounts
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_connections on business_connections
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_conversations on conversations
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_customers on customers
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

create policy admin_write_creators on creators
  for all to authenticated
  using (is_console_admin()) with check (is_console_admin());

-- ---------------------------------------------------------------
-- Token-gated creator content access (dashboard_token = the credential)
-- SECURITY DEFINER so the caller needs no auth session.
-- ---------------------------------------------------------------

create or replace function creator_id_for_token(t text)
returns text language sql security definer set search_path = public as $$
  select id from creators where dashboard_token = t limit 1;
$$;

create or replace function creator_list_media(t text)
returns setof media_items language sql security definer set search_path = public as $$
  select m.* from media_items m
  where m.creator_id = creator_id_for_token(t)
  order by m.uploaded_at desc;
$$;

create or replace function creator_add_media(t text, p_title text, p_desc text, p_kind text,
                                            p_media_key text, p_media_type text, p_media_size bigint,
                                            p_price_ton numeric)
returns media_items language plpgsql security definer set search_path = public as $$
declare
  cid text;
  row media_items;
begin
  cid := creator_id_for_token(t);
  if cid is null then raise exception 'invalid token'; end if;
  insert into media_items (creator_id, title, description, kind, media_key, media_type, media_size, price_ton, visible)
  values (cid, p_title, nullif(p_desc, ''), p_kind, p_media_key, p_media_type, p_media_size, nullif(p_price_ton, 0), true)
  returning * into row;
  return row;
end $$;

create or replace function creator_delete_media(t text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare cid text;
begin
  cid := creator_id_for_token(t);
  if cid is null then raise exception 'invalid token'; end if;
  delete from media_items where id = p_id and creator_id = cid;
end $$;

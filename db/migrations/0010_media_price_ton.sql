-- 0010: per-item pricing on media_items (console library form collects price_ton)
alter table media_items add column if not exists price_ton numeric;

-- RLS already covers admin write via admin_write_media (0009) and owner read.

-- creator_add_media RPC gains the price (drop + recreate with price param)
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

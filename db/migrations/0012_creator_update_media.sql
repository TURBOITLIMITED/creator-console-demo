-- 0012: creator-side edit of own content (title/description/file only; price stays owner-controlled)
create or replace function creator_update_media(t text, p_id uuid, p_title text, p_desc text,
                                               p_media_key text default null, p_media_type text default null,
                                               p_media_size bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare cid text;
begin
  cid := creator_id_for_token(t);
  if cid is null then raise exception 'invalid token'; end if;
  update media_items set
    title = p_title,
    description = nullif(p_desc, ''),
    media_key = coalesce(p_media_key, media_key),
    media_type = coalesce(p_media_type, media_type),
    media_size = coalesce(p_media_size, media_size)
  where id = p_id and creator_id = cid;
end $$;

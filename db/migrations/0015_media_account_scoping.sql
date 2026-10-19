-- 0015: per-girl content scoping.
-- Both bot accounts currently sit under one creator row, so every upload
-- showed in every girl's library. Media and bundles now carry the telegram
-- account they belong to; the owner creator stays the RLS/owner bucket.

begin;

alter table media_items
  add column if not exists telegram_account_id uuid
  references telegram_accounts(id) on delete set null;
create index if not exists media_items_account_idx on media_items (telegram_account_id);

alter table content_bundles
  add column if not exists telegram_account_id uuid
  references telegram_accounts(id) on delete set null;
create index if not exists content_bundles_account_idx on content_bundles (telegram_account_id);

-- Existing uploads under the owner creator were made in Michelle's context.
update media_items
  set telegram_account_id = '09f528ff-95aa-411c-b0a9-1ecc0fb9be9b'
  where creator_id = '7fbec2db-de5a-4829-8d4c-c23fc950eca1'
    and telegram_account_id is null;

commit;

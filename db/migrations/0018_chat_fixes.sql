-- 0018: creator chat fixes (OPUS-PLAN.md, 2026-10-28).
--
-- Schema and NON-destructive backfills only. Apply this BEFORE deploying the
-- worker that goes with it: the code reads price_gbp only, writes
-- conversations.declined_at / memory / owner_tg_user_id, and inserts messages
-- with kind 'paid_media' / 'payment'.
--
-- The conversation row-merge (Fix 5) is at the very end, COMMENTED OUT. Run its
-- dry-run SELECTs first, read the output, and only then decide whether to run it.
--
-- Wrapped in one transaction: any failed assertion rolls the whole file back.

begin;

-- ---------------------------------------------------------------------------
-- Fix 2: the decline crash. onMessage PATCHes declined_at; the column did not
-- exist, PostgREST returned 400, and the reply was never sent.
-- ---------------------------------------------------------------------------
alter table conversations add column if not exists declined_at timestamptz;

-- ---------------------------------------------------------------------------
-- Fix 6/7: per-conversation memory (owner + chat scoped, so it can never cross
-- personas or creators). Written on events by code, never by a model.
-- ---------------------------------------------------------------------------
alter table conversations add column if not exists memory jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Fix 4: only the owner's own Telegram can be claimed.
-- telegram_accounts.tg_user_id is the BOT's id; owner_tg_user_id is the human
-- allowed to connect this bot to their Telegram.
-- ---------------------------------------------------------------------------
alter table telegram_accounts add column if not exists owner_tg_user_id bigint;

-- Unclaimed connections are recorded with creator_id NULL (onConnection). The
-- repo's 0001 declares it NOT NULL; dropping it is a no-op if live already allows NULL.
alter table business_connections alter column creator_id drop not null;

-- Backfill the three known owners. Each is matched on id prefix AND bot
-- username, and must hit exactly one row or the migration aborts.
do $$
declare n int;
begin
  update telegram_accounts set owner_tg_user_id = 8886532645
   where id::text like '1b285c3a-%' and lower(username) = 'michelle0161bot';
  get diagnostics n = row_count;
  if n <> 1 then raise exception '0018: Michelle0161bot (1b285c3a) matched % rows, expected 1', n; end if;

  update telegram_accounts set owner_tg_user_id = 1712186662
   where id::text like '73f34fea-%' and lower(username) = 'littlemissmia_bot';
  get diagnostics n = row_count;
  if n <> 1 then raise exception '0018: LittleMissMia_bot (73f34fea) matched % rows, expected 1', n; end if;

  update telegram_accounts set owner_tg_user_id = 8886532645
   where id::text like '3943cd88-%' and lower(username) = 'michaela39bot';
  get diagnostics n = row_count;
  if n <> 1 then raise exception '0018: Michaela39bot (3943cd88) matched % rows, expected 1', n; end if;
end $$;

-- Preview: the connections the next statement switches off. Expected: only the
-- Turbo IT Team connections (tg_user 8380225719: iyGw…, zD6j…, 5Gcs…).
select bc.id, bc.tg_user_id, ta.username as bot, ta.owner_tg_user_id, bc.creator_id, bc.is_enabled
  from business_connections bc
  join telegram_accounts ta on ta.id = bc.telegram_account_id
 where ta.owner_tg_user_id is not null
   and bc.tg_user_id <> ta.owner_tg_user_id
   and bc.is_enabled;

-- Switch off connections whose human is not the account's owner. creator_id is
-- deliberately NOT touched (left as is for the owner to review); the worker
-- skips is_enabled = false connections and never claims a non-owner again.
update business_connections bc
   set is_enabled = false,
       revoked_at = coalesce(bc.revoked_at, now()),
       updated_at = now()
  from telegram_accounts ta
 where ta.id = bc.telegram_account_id
   and ta.owner_tg_user_id is not null
   and bc.tg_user_id <> ta.owner_tg_user_id
   and bc.is_enabled;

-- ---------------------------------------------------------------------------
-- Fix 3: record the sale. The Stars wall row and the purchase row used kinds
-- the CHECK did not allow, so neither was ever written.
-- ---------------------------------------------------------------------------
alter table messages drop constraint if exists messages_kind_check;
alter table messages add constraint messages_kind_check
  check (kind in ('text','photo','video','document','audio','voice','animation',
                  'sticker','media_group','other','paid_media','payment'));

-- ---------------------------------------------------------------------------
-- Fix 9: price_ton always held POUNDS. The code now reads price_gbp only.
-- No-op for the legacy rows where both are NULL.
-- ---------------------------------------------------------------------------
update media_items set price_gbp = price_ton
 where price_gbp is null and price_ton is not null;
comment on column media_items.price_ton is
  'DEPRECATED (0018): always held pounds. The worker reads price_gbp only; the console writes both.';

-- ---------------------------------------------------------------------------
-- Fix 5: conversation continuity across reconnects.
-- A private business chat is (her Telegram user id, his chat id). The
-- connection id changes on every reconnect; her user id does not.
-- ---------------------------------------------------------------------------
alter table conversations add column if not exists owner_tg_user_id bigint;
alter table conversations add column if not exists merged_into uuid
  references conversations(id) on delete set null;

-- Backfill the owner on ONE row per (owner, chat): the newest. Older duplicates
-- stay NULL, which keeps them out of the unique index until the (optional)
-- merge below folds them in. Nothing is moved or deleted here.
with ranked as (
  select c.id, bc.tg_user_id as owner, c.chat_id,
         row_number() over (partition by bc.tg_user_id, c.chat_id
                            order by c.last_message_at desc nulls last, c.id desc) as rn
    from conversations c
    join business_connections bc on bc.id = c.business_connection_id
   where c.owner_tg_user_id is null
     and c.merged_into is null
     and bc.tg_user_id is not null
)
update conversations c
   set owner_tg_user_id = r.owner
  from ranked r
 where r.id = c.id
   and r.rn = 1
   and not exists (select 1 from conversations x
                    where x.owner_tg_user_id = r.owner and x.chat_id = r.chat_id);

-- FULL (not partial) unique index: PostgREST cannot target a partial index in
-- on_conflict (this repo already hit 42P10). NULL owners are distinct, so
-- merged / not-yet-merged rows drop out of it.
create unique index if not exists conversations_owner_chat_uniq
  on conversations (owner_tg_user_id, chat_id);

commit;

-- ===========================================================================
-- Fix 5 MERGE: DRY RUN. Safe, read-only. Run these and read the output first.
-- ===========================================================================

-- 1. Groups that would merge (expected ~13 on 2026-10-28, e.g. Andy's 2, H's 3).
select bc.tg_user_id as owner, c.chat_id, count(*) as rows,
       array_agg(c.id order by c.last_message_at desc nulls last) as conversation_ids
  from conversations c
  join business_connections bc on bc.id = c.business_connection_id
 where c.merged_into is null
 group by bc.tg_user_id, c.chat_id
having count(*) > 1
 order by rows desc;

-- 2. Message collisions the move would cause on the dedupe index
--    (conversation_id, tg_message_id, direction). MUST return zero rows before
--    the merge is run; any row here would make the UPDATE fail.
with grp as (
  select c.id, k.id as canonical
    from conversations c
    join business_connections bc on bc.id = c.business_connection_id
    join conversations k on k.owner_tg_user_id = bc.tg_user_id and k.chat_id = c.chat_id
   where c.id <> k.id and c.owner_tg_user_id is null and c.merged_into is null
)
select coalesce(g.canonical, m.conversation_id) as target, m.tg_message_id, m.direction, count(*) as n
  from messages m
  left join grp g on g.id = m.conversation_id
 where m.tg_message_id is not null
   and (g.id is not null
        or m.conversation_id in (select canonical from grp))
 group by 1, 2, 3
having count(*) > 1;

-- ===========================================================================
-- Fix 5 MERGE: DESTRUCTIVE. COMMENTED OUT ON PURPOSE. Owner runs it by hand,
-- after the dry run above returns the expected groups and zero collisions.
-- Old rows are KEPT (merged_into set) so v1|<conv>|<item> paid-media payloads
-- and console deep links still resolve; the worker follows merged_into.
-- Other tables keyed by conversation_id (payments, consents, drafts) are left
-- pointing at the old rows.
-- ===========================================================================
-- begin;
-- create temp table _merge on commit drop as
--   select c.id, k.id as canonical
--     from conversations c
--     join business_connections bc on bc.id = c.business_connection_id
--     join conversations k on k.owner_tg_user_id = bc.tg_user_id and k.chat_id = c.chat_id
--    where c.id <> k.id and c.owner_tg_user_id is null and c.merged_into is null;
-- update messages m set conversation_id = g.canonical from _merge g where m.conversation_id = g.id;
-- update conversations c set merged_into = g.canonical from _merge g where c.id = g.id;
-- -- Carry the earliest purchase intent / decline onto the canonical row.
-- update conversations k
--    set purchase_intent_at = coalesce(k.purchase_intent_at, o.pi),
--        declined_at        = greatest(k.declined_at, o.da)
--   from (select g.canonical, max(c.purchase_intent_at) pi, max(c.declined_at) da
--           from _merge g join conversations c on c.id = g.id group by g.canonical) o
--  where k.id = o.canonical;
-- commit;

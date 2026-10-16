-- 0001_telegram_platform.sql
-- Turbo Creator Assistant: multi-account Telegram Business + AI chat.
--
-- STATUS: DRAFT - NOT YET APPLIED.
-- Two items are pending confirmation from the live Telegram Bot API docs and are
-- marked [PENDING-API] below. Everything else is settled.
--
-- Additive only. Creates new tables and ADDs columns to `conversations`.
-- Nothing is dropped or rewritten, so rollback is `drop table` + `drop column`.
-- Existing rows (12 junk creators, 1 console admin) are untouched.

begin;

-- ---------------------------------------------------------------------------
-- 1. The connected personal Telegram accounts
-- ---------------------------------------------------------------------------
-- Keyed on tg_user_id, NOT username: usernames are mutable and must never be an
-- identity (brief s6). One personal account maps to exactly one creator.

create table if not exists telegram_accounts (
  id             uuid primary key default gen_random_uuid(),
  creator_id     text not null references creators(id) on delete cascade,
  tg_user_id     bigint not null,
  username       text,                       -- display only, may change
  first_name     text,
  last_name      text,
  photo_url      text,
  connected      boolean not null default false,
  last_activity_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint telegram_accounts_tg_user_unique unique (tg_user_id)
);
create index if not exists telegram_accounts_creator_idx on telegram_accounts (creator_id);

-- ---------------------------------------------------------------------------
-- 2. Business connections
-- ---------------------------------------------------------------------------
-- PK is Telegram's own business_connection_id. `rights` holds the granular
-- BusinessBotRights object verbatim so we never lose a field Telegram adds.
-- [PENDING-API] whether `rights` is an object or legacy flat can_reply decides
-- whether can_reply_cached stays a stored column or becomes generated.

create table if not exists business_connections (
  id                   text primary key,          -- business_connection_id
  creator_id           text not null references creators(id) on delete cascade,
  telegram_account_id  uuid references telegram_accounts(id) on delete cascade,
  tg_user_id           bigint not null,           -- the account owner
  user_chat_id         bigint,                    -- required to send back
  rights               jsonb not null default '{}'::jsonb,
  can_reply_cached     boolean not null default false,
  is_enabled           boolean not null default false,
  connected_at         timestamptz,
  revoked_at           timestamptz,
  last_verified_at     timestamptz,               -- last getBusinessConnection check
  raw                  jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists business_connections_creator_idx on business_connections (creator_id);
create index if not exists business_connections_active_idx
  on business_connections (creator_id) where is_enabled and revoked_at is null;

-- ---------------------------------------------------------------------------
-- 3. Customers (per creator - the CRM spine)
-- ---------------------------------------------------------------------------
-- The unique constraint IS the tenant boundary: the same human messaging two
-- creators is two independent customer rows with no shared history.

create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  creator_id    text not null references creators(id) on delete cascade,
  tg_user_id    bigint not null,
  username      text,
  first_name    text,
  last_name     text,
  language_code text,
  notes         text,
  flags         jsonb not null default '{}'::jsonb,
  support_flag  boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,
  deleted_at    timestamptz,                      -- GDPR erasure, soft first
  constraint customers_creator_tg_unique unique (creator_id, tg_user_id)
);
create index if not exists customers_creator_idx on customers (creator_id);

-- ---------------------------------------------------------------------------
-- 4. conversations - EXTEND the existing table
-- ---------------------------------------------------------------------------
-- The composite key (business_connection_id, chat_id) is load-bearing. chat_id
-- alone COLLIDES across accounts, and that collision is a cross-account data
-- leak. This rule is inherited from telegram-dm-bot and must not be relaxed.

alter table conversations add column if not exists business_connection_id text
  references business_connections(id) on delete set null;
alter table conversations add column if not exists chat_id          bigint;
alter table conversations add column if not exists customer_id      uuid references customers(id) on delete set null;
alter table conversations add column if not exists mode             text not null default 'assisted';
alter table conversations add column if not exists mode_changed_at  timestamptz;
alter table conversations add column if not exists mode_changed_by  uuid;
alter table conversations add column if not exists last_inbound_at  timestamptz;  -- drives the 24h window
alter table conversations add column if not exists last_outbound_at timestamptz;
alter table conversations add column if not exists disclosure_sent_at timestamptz;
alter table conversations add column if not exists escalated_at     timestamptz;
alter table conversations add column if not exists summary          text;

-- Default is 'assisted', never 'ai': brief s7 forbids unrestricted automation
-- by default, and an un-reviewed reply to a real customer is the one mistake
-- this system must not make on its own.
alter table conversations drop constraint if exists conversations_mode_check;
alter table conversations add constraint conversations_mode_check
  check (mode in ('ai','human','assisted'));

create unique index if not exists conversations_connection_chat_unique
  on conversations (business_connection_id, chat_id)
  where business_connection_id is not null and chat_id is not null;
create index if not exists conversations_creator_idx on conversations (creator_id, last_message_at desc);

-- ---------------------------------------------------------------------------
-- 5. messages - the table that did not exist at all
-- ---------------------------------------------------------------------------

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  creator_id      text not null references creators(id) on delete cascade,
  tg_message_id   bigint,
  direction       text not null check (direction in ('in','out')),
  sender          text not null check (sender in ('customer','ai','human','system')),
  kind            text not null default 'text'
                    check (kind in ('text','photo','video','document','audio','voice','animation','sticker','media_group','other')),
  body            text,
  media_key       text,                           -- R2 key in creator-media
  raw             jsonb,
  sent_at         timestamptz not null default now(),
  edited_at       timestamptz,                    -- edited_business_message
  deleted_at      timestamptz,                    -- deleted_business_messages
  delivered       boolean not null default false,
  error           text
);
-- Telegram retries on timeout; this makes an inbound message exactly-once.
create unique index if not exists messages_dedupe_unique
  on messages (conversation_id, tg_message_id, direction)
  where tg_message_id is not null;
create index if not exists messages_conversation_idx on messages (conversation_id, sent_at desc);
create index if not exists messages_creator_idx on messages (creator_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- 6. webhook_events - dedupe before any work happens
-- ---------------------------------------------------------------------------
-- PK on update_id is the idempotency guarantee. Insert-first, work-second.

create table if not exists webhook_events (
  update_id              bigint primary key,
  kind                   text,
  business_connection_id text,
  received_at            timestamptz not null default now(),
  processed_at           timestamptz,
  error                  text,
  raw                    jsonb
);
create index if not exists webhook_events_unprocessed_idx
  on webhook_events (received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- 7. ai_profiles - one persona per creator
-- ---------------------------------------------------------------------------

create table if not exists ai_profiles (
  creator_id      text primary key references creators(id) on delete cascade,
  display_name    text,
  tone            text,
  message_length  text not null default 'short',
  emoji_level     text not null default 'light',
  system_prompt   text,
  faq             jsonb not null default '[]'::jsonb,
  approved_links  jsonb not null default '[]'::jsonb,
  boundaries      text,
  escalation_rules jsonb not null default '{}'::jsonb,
  memory_enabled  boolean not null default true,
  memory_retention_days int not null default 90,
  model_provider  text not null default 'workers-ai',   -- see compliance verdict
  model_id        text,
  enabled         boolean not null default false,       -- off until tested
  version         int not null default 1,
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 8. customer_memories - isolated per creator
-- ---------------------------------------------------------------------------

create table if not exists customer_memories (
  id          uuid primary key default gen_random_uuid(),
  creator_id  text not null references creators(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  kind        text not null check (kind in ('preference','summary','fact','purchase')),
  content     text not null,
  source_message_id uuid references messages(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);
create index if not exists customer_memories_customer_idx on customer_memories (customer_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 9. ai_jobs - async generation, retries, and the assisted-mode draft queue
-- ---------------------------------------------------------------------------

create table if not exists ai_jobs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  creator_id      text not null references creators(id) on delete cascade,
  trigger_message_id uuid references messages(id) on delete set null,
  status          text not null default 'queued'
                    check (status in ('queued','running','suggested','sent','failed','cancelled','superseded')),
  attempts        int not null default 0,
  suggestion      text,                 -- assisted mode: awaits human approval
  approved_by     uuid,
  approved_at     timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
create index if not exists ai_jobs_pending_idx on ai_jobs (status, created_at)
  where status in ('queued','running','suggested');

-- ---------------------------------------------------------------------------
-- 10. audit_log - index the existing table for the owner-facing view
-- ---------------------------------------------------------------------------
-- Developer ToS obliges us to show an account owner what was sent in their
-- name. That view reads this table, so it needs to be queryable by creator.

create index if not exists audit_log_creator_idx on audit_log (creator_id, at desc);

-- ---------------------------------------------------------------------------
-- 11. RLS: deny by default on every new table
-- ---------------------------------------------------------------------------
-- The worker uses SUPABASE_SERVICE_KEY and bypasses RLS, so these policies are
-- defence in depth for the browser path. Enabling RLS with no policy = deny all,
-- which is the correct posture for tables holding private DMs.

alter table telegram_accounts   enable row level security;
alter table business_connections enable row level security;
alter table customers           enable row level security;
alter table messages            enable row level security;
alter table webhook_events      enable row level security;
alter table ai_profiles         enable row level security;
alter table customer_memories   enable row level security;
alter table ai_jobs             enable row level security;

-- Console admins may READ operational tables. No INSERT/UPDATE/DELETE policy is
-- granted to anyone: all writes go through the worker's service key.
create policy admins_read_tg_accounts on telegram_accounts
  for select to authenticated using (is_console_admin());
create policy admins_read_connections on business_connections
  for select to authenticated using (is_console_admin());
create policy admins_read_customers on customers
  for select to authenticated using (is_console_admin());
create policy admins_read_messages on messages
  for select to authenticated using (is_console_admin());
create policy admins_read_ai_profiles on ai_profiles
  for select to authenticated using (is_console_admin());
create policy admins_read_ai_jobs on ai_jobs
  for select to authenticated using (is_console_admin());

-- customer_memories and webhook_events get NO read policy: raw update payloads
-- and inferred personal facts stay service-key only (data minimisation).

commit;

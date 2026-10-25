-- Migration 0017: FabSwingers integration
--
-- One FabSwingers login per Telegram account (one account = one girl), with that
-- account's own auto-reply persona. Written to match how the console actually
-- scopes data: FabSwingers hangs off telegram_accounts, and console access is
-- granted through console_admins.
--
-- The first draft of this file referenced creators.creator_id, a column that does
-- not exist in this database, so it could never run. It has never been applied;
-- this version replaces it. Every statement is idempotent.

create table if not exists fabswingers_accounts (
  id                  uuid primary key default gen_random_uuid(),
  telegram_account_id uuid not null references telegram_accounts(id) on delete cascade,
  creator_id          text,                                  -- owner's auth uid, denormalised for scoping
  username            text not null,                         -- FabSwingers login
  password_enc        text not null,                         -- SHA-256 hex (no plaintext at rest)
  password_nonce      text not null,
  telegram_username   text not null,                         -- her PERSONAL handle customers message
  enabled             boolean not null default true,
  last_poll_at        timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint fabswingers_accounts_one_per_account unique (telegram_account_id),
  constraint fabswingers_accounts_username_key unique (username)
);

create table if not exists fabswingers_personas (
  id                     uuid primary key default gen_random_uuid(),
  fabswingers_account_id uuid not null unique references fabswingers_accounts(id) on delete cascade,
  tone                   text,
  emoji_level            text,
  message_length         text,
  system_prompt          text,
  pivot_message          text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table if not exists fabswingers_conversations (
  id                     uuid primary key default gen_random_uuid(),
  fabswingers_account_id uuid not null references fabswingers_accounts(id) on delete cascade,
  fs_user_id             text not null,
  fs_user_name           text,
  message_count          integer not null default 0,
  last_message_at        timestamptz,
  tg_pivoted             boolean not null default false,
  tg_user_id             text,
  conversation_summary   text,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint fabswingers_conversations_unique unique (fabswingers_account_id, fs_user_id)
);

create index if not exists idx_fs_conversations_account on fabswingers_conversations (fabswingers_account_id);
create index if not exists idx_fs_conversations_open on fabswingers_conversations (fabswingers_account_id) where tg_pivoted = false;

-- RLS: the console owner (console_admins) gets full access, a creator gets their own
-- rows through the Telegram account they own.
alter table fabswingers_accounts       enable row level security;
alter table fabswingers_personas       enable row level security;
alter table fabswingers_conversations  enable row level security;

drop policy if exists fs_accounts_admin on fabswingers_accounts;
create policy fs_accounts_admin on fabswingers_accounts for all
  using (exists (select 1 from console_admins ca where ca.user_id = auth.uid()))
  with check (exists (select 1 from console_admins ca where ca.user_id = auth.uid()));

drop policy if exists fs_accounts_creator on fabswingers_accounts;
create policy fs_accounts_creator on fabswingers_accounts for all
  using (auth.uid()::text = (select ta.creator_id from telegram_accounts ta where ta.id = telegram_account_id))
  with check (auth.uid()::text = (select ta.creator_id from telegram_accounts ta where ta.id = telegram_account_id));

drop policy if exists fs_personas_admin on fabswingers_personas;
create policy fs_personas_admin on fabswingers_personas for all
  using (exists (select 1 from console_admins ca where ca.user_id = auth.uid()))
  with check (exists (select 1 from console_admins ca where ca.user_id = auth.uid()));

drop policy if exists fs_personas_creator on fabswingers_personas;
create policy fs_personas_creator on fabswingers_personas for all
  using (exists (
    select 1 from fabswingers_accounts fa
    join telegram_accounts ta on ta.id = fa.telegram_account_id
    where fa.id = fabswingers_account_id and ta.creator_id = auth.uid()::text
  ))
  with check (exists (
    select 1 from fabswingers_accounts fa
    join telegram_accounts ta on ta.id = fa.telegram_account_id
    where fa.id = fabswingers_account_id and ta.creator_id = auth.uid()::text
  ));

drop policy if exists fs_conv_admin on fabswingers_conversations;
create policy fs_conv_admin on fabswingers_conversations for all
  using (exists (select 1 from console_admins ca where ca.user_id = auth.uid()))
  with check (exists (select 1 from console_admins ca where ca.user_id = auth.uid()));

drop policy if exists fs_conv_creator on fabswingers_conversations;
create policy fs_conv_creator on fabswingers_conversations for all
  using (exists (
    select 1 from fabswingers_accounts fa
    join telegram_accounts ta on ta.id = fa.telegram_account_id
    where fa.id = fabswingers_account_id and ta.creator_id = auth.uid()::text
  ))
  with check (exists (
    select 1 from fabswingers_accounts fa
    join telegram_accounts ta on ta.id = fa.telegram_account_id
    where fa.id = fabswingers_account_id and ta.creator_id = auth.uid()::text
  ));

-- updated_at triggers
create or replace function fs_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_fs_accounts_touch on fabswingers_accounts;
create trigger trg_fs_accounts_touch before update on fabswingers_accounts
  for each row execute function fs_touch_updated_at();

drop trigger if exists trg_fs_personas_touch on fabswingers_personas;
create trigger trg_fs_personas_touch before update on fabswingers_personas
  for each row execute function fs_touch_updated_at();

drop trigger if exists trg_fs_conversations_touch on fabswingers_conversations;
create trigger trg_fs_conversations_touch before update on fabswingers_conversations
  for each row execute function fs_touch_updated_at();

-- PostgREST reads these with the authenticated role; make the grants explicit so a
-- fresh project cannot 404 them from the console while the SQL itself looks fine.
grant select, insert, update, delete on fabswingers_accounts      to anon, authenticated, service_role;
grant select, insert, update, delete on fabswingers_personas      to anon, authenticated, service_role;
grant select, insert, update, delete on fabswingers_conversations to anon, authenticated, service_role;

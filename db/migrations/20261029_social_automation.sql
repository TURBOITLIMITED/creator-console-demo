-- Migration: social automation (Reddit + Twitter posting funnels)
--
-- One social account per platform login, sealed credentials (the Worker must
-- replay them, so they are sealed with the app KEK exactly like FabSwingers
-- passwords), and a queue of posts the Worker's cron publishes when due.
--
-- Written to match how the console actually scopes data: social hangs off
-- telegram_accounts, and console access is granted through console_admins.
-- Every statement is idempotent.

create table if not exists social_accounts (
  id                  uuid primary key default gen_random_uuid(),
  telegram_account_id uuid references telegram_accounts(id) on delete cascade,
  creator_id          text,                    -- owner's auth uid, denormalised for scoping
  platform            text not null check (platform in ('reddit','twitter')),
  username            text not null,           -- site handle, no @
  creds_enc           text not null,            -- sealed json, KEK lives in Worker secrets
  enabled             boolean not null default true,
  posts_total         integer not null default 0,
  last_post_at        timestamptz,
  last_error          text,
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint social_accounts_platform_username unique (platform, username)
);

create table if not exists social_posts (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references social_accounts(id) on delete cascade,
  platform    text not null check (platform in ('reddit','twitter')),
  subreddit   text,                            -- reddit only, no r/
  title       text,                             -- reddit title / twitter lead line
  body        text,                            -- reddit selftext / tweet text
  media_key   text,                            -- R2 key in creator-media (optional)
  link_url    text,                            -- reddit link post target (optional)
  state       text not null default 'draft' check (state in ('draft','scheduled','posting','posted','failed')),
  tries       integer not null default 0,
  scheduled_at timestamptz,
  posted_at   timestamptz,
  post_url    text,
  score       integer,                          -- upvotes (reddit) / likes (twitter)
  error_message text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_social_accounts_platform on social_accounts(platform);
create index if not exists idx_social_posts_account on social_posts(account_id);
create index if not exists idx_social_posts_state on social_posts(state);
create index if not exists idx_social_posts_scheduled on social_posts(scheduled_at);

-- RLS: same posture as the rest of the estate. The Worker talks with the
-- service key and bypasses RLS; these policies cover the console's browser
-- path (anon key + the signed-in admin's JWT).
alter table social_accounts enable row level security;
alter table social_posts   enable row level security;

drop policy if exists social_accounts_admin on social_accounts;
create policy social_accounts_admin on social_accounts for all
  using (exists (select 1 from console_admins ca where ca.user_id = auth.uid()))
  with check (exists (select 1 from console_admins ca where ca.user_id = auth.uid()));

drop policy if exists social_accounts_creator on social_accounts;
create policy social_accounts_creator on social_accounts for all
  using (auth.uid()::text = (select ta.creator_id from telegram_accounts ta where ta.id = telegram_account_id))
  with check (auth.uid()::text = (select ta.creator_id from telegram_accounts ta where ta.id = telegram_account_id));

drop policy if exists social_posts_admin on social_posts;
create policy social_posts_admin on social_posts for all
  using (exists (select 1 from console_admins ca where ca.user_id = auth.uid()))
  with check (exists (select 1 from console_admins ca where ca.user_id = auth.uid()));

drop policy if exists social_posts_creator on social_posts;
create policy social_posts_creator on social_posts for all
  using (exists (
    select 1 from social_accounts sa
    join telegram_accounts ta on ta.id = sa.telegram_account_id
    where sa.id = social_posts.account_id and ta.creator_id = auth.uid()::text
  ))
  with check (exists (
    select 1 from social_accounts sa
    join telegram_accounts ta on ta.id = sa.telegram_account_id
    where sa.id = social_posts.account_id and ta.creator_id = auth.uid()::text
  ));

-- updated_at triggers (reuse the function migration 0017 created)
drop trigger if exists trg_social_accounts_touch on social_accounts;
create trigger trg_social_accounts_touch
  before update on social_accounts
  for each row execute function fs_touch_updated_at();

drop trigger if exists trg_social_posts_touch on social_posts;
create trigger trg_social_posts_touch
  before update on social_posts
  for each row execute function fs_touch_updated_at();

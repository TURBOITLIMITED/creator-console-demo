-- 0002_media_bundles.sql
-- Media library and content bundles for Turbo Creator

begin;

-- ---------------------------------------------------------------------------
-- 1. media_items - videos, images, documents per creator
-- ---------------------------------------------------------------------------

create table if not exists media_items (
  id              uuid primary key default gen_random_uuid(),
  creator_id      text not null references creators(id) on delete cascade,
  kind            text not null 
    check (kind in ('image', 'video', 'document', 'audio')),
  title           text,
  description     text,
  media_key       text not null,              -- R2 key in creator-media bucket
  media_type      text,                       -- MIME type
  media_size      bigint,                     -- bytes
  duration_secs   int,                        -- for video/audio
  thumbnail_key   text,                       -- R2 key for thumbnail
  width           int,                        -- for images/video
  height          int,
  visible         boolean not null default true,
  uploaded_at     timestamptz not null default now(),
  uploaded_by     uuid,                       -- console admin who uploaded
  metadata        jsonb not null default '{}'::jsonb
);

create index if not exists media_items_creator_idx on media_items (creator_id, uploaded_at desc);
create index if not exists media_items_visible_idx on media_items (creator_id, visible) where visible;

-- ---------------------------------------------------------------------------
-- 2. content_bundles - sellable groups of media
-- ---------------------------------------------------------------------------

create table if not exists content_bundles (
  id              uuid primary key default gen_random_uuid(),
  creator_id      text not null references creators(id) on delete cascade,
  name            text not null,
  description     text,
  price_ton       numeric(18,6) not null default 0,  -- TON cryptocurrency
  price_usd       numeric(10,2),                     -- optional USD equivalent
  thumbnail_key   text,                              -- bundle preview image
  position        int not null default 0,            -- sort order
  active          boolean not null default true,
  purchase_limit  int,                               -- max purchases per customer (null = unlimited)
  expires_at      timestamptz,                       -- bundle availability expiry
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  metadata        jsonb not null default '{}'::jsonb
);

create index if not exists content_bundles_creator_idx on content_bundles (creator_id, active, position);

-- ---------------------------------------------------------------------------
-- 3. bundle_items - links media to bundles (many-to-many)
-- ---------------------------------------------------------------------------

create table if not exists bundle_items (
  bundle_id       uuid not null references content_bundles(id) on delete cascade,
  media_id        uuid not null references media_items(id) on delete cascade,
  position        int not null default 0,            -- order within bundle
  created_at      timestamptz not null default now(),
  primary key (bundle_id, media_id)
);

create index if not exists bundle_items_media_idx on bundle_items (media_id);

-- ---------------------------------------------------------------------------
-- 4. bundle_purchases - customers buying bundles
-- ---------------------------------------------------------------------------

create table if not exists bundle_purchases (
  id              uuid primary key default gen_random_uuid(),
  bundle_id       uuid not null references content_bundles(id) on delete cascade,
  creator_id      text not null references creators(id) on delete cascade,
  customer_id     uuid references customers(id) on delete set null,
  tg_user_id      bigint not null,                  -- customer's Telegram ID
  price_paid_ton  numeric(18,6) not null,           -- price at time of purchase
  payment_ref     text,                              -- TON transaction hash or payment processor ref
  status          text not null default 'pending'
    check (status in ('pending', 'completed', 'refunded', 'failed')),
  purchased_at    timestamptz not null default now(),
  completed_at    timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  constraint bundle_purchases_customer_unique unique (bundle_id, tg_user_id)
);

create index if not exists bundle_purchases_bundle_idx on bundle_purchases (bundle_id, purchased_at desc);
create index if not exists bundle_purchases_customer_idx on bundle_purchases (tg_user_id, purchased_at desc);
create index if not exists bundle_purchases_creator_idx on bundle_purchases (creator_id, purchased_at desc);

-- ---------------------------------------------------------------------------
-- 5. RLS policies
-- ---------------------------------------------------------------------------

alter table media_items         enable row level security;
alter table content_bundles     enable row level security;
alter table bundle_items        enable row level security;
alter table bundle_purchases    enable row level security;

create policy admins_read_media on media_items
  for select to authenticated using (is_console_admin());

create policy admins_read_bundles on content_bundles
  for select to authenticated using (is_console_admin());

create policy admins_read_bundle_items on bundle_items
  for select to authenticated using (is_console_admin());

create policy admins_read_purchases on bundle_purchases
  for select to authenticated using (is_console_admin());

commit;

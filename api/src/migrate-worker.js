
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === "/migrate" && request.method === "POST") {
      const key = env.SUPABASE_SERVICE_KEY;
      const baseUrl = "https://xsgvdlgmhuxozjlbjzxy.supabase.co";
      
      // First create the helper function
      const createFunc = `CREATE OR REPLACE FUNCTION exec_sql(sql_text text) RETURNS text AS $$ DECLARE result text; BEGIN EXECUTE sql_text; RETURN 'OK'; END; $$ LANGUAGE plpgsql;`;
      
      try {
        await fetch(`${baseUrl}/rest/v1/rpc/exec_sql`, {
          method: 'POST',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          body: JSON.stringify({ sql_text: createFunc })
        });
      } catch (e) {
        console.log("Function creation skipped (may already exist)");
      }
      
      // SQL to execute
      const sql = `
create table if not exists media_items (
  id uuid primary key default gen_random_uuid(),
  creator_id text not null references creators(id) on delete cascade,
  kind text not null check (kind in ('image', 'video', 'document', 'audio')),
  title text, description text,
  media_key text not null, media_type text, media_size bigint,
  duration_secs int, thumbnail_key text, width int, height int,
  visible boolean not null default true,
  uploaded_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists media_items_creator_idx on media_items (creator_id, uploaded_at desc);

create table if not exists content_bundles (
  id uuid primary key default gen_random_uuid(),
  creator_id text not null references creators(id) on delete cascade,
  name text not null, description text,
  price_ton numeric(18,6) not null default 0, price_usd numeric(10,2),
  thumbnail_key text, position int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists content_bundles_creator_idx on content_bundles (creator_id, active, position);

create table if not exists bundle_items (
  bundle_id uuid not null references content_bundles(id) on delete cascade,
  media_id uuid not null references media_items(id) on delete cascade,
  position int not null default 0,
  primary key (bundle_id, media_id)
);

create table if not exists bundle_purchases (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references content_bundles(id) on delete cascade,
  creator_id text not null references creators(id) on delete cascade,
  tg_user_id bigint not null,
  price_paid_ton numeric(18,6) not null,
  status text not null default 'pending',
  purchased_at timestamptz not null default now(),
  unique (bundle_id, tg_user_id)
);

alter table media_items enable row level security;
alter table content_bundles enable row level security;
alter table bundle_items enable row level security;
alter table bundle_purchases enable row level security;

create policy admins_read_media on media_items for select to authenticated using (is_console_admin());
create policy admins_read_bundles on content_bundles for select to authenticated using (is_console_admin());
create policy admins_read_bundle_items on bundle_items for select to authenticated using (is_console_admin());
create policy admins_read_purchases on bundle_purchases for select to authenticated using (is_console_admin());
`;

      const statements = sql.split(';').filter(s => s.trim() && !s.trim().startsWith('--'));
      let success = 0;
      
      for (const stmt of statements) {
        try {
          const resp = await fetch(`${baseUrl}/rest/v1/rpc/exec_sql`, {
            method: 'POST',
            headers: {
              'apikey': key,
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
              'User-Agent': 'Mozilla/5.0'
            },
            body: JSON.stringify({ sql_text: stmt.trim() })
          });
          if (resp.ok) success++;
        } catch (e) {
          console.error("Failed:", e.message);
        }
      }
      
      return new Response(JSON.stringify({ success, total: statements.length }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    
    return new Response("Migration Worker Ready", { status: 200 });
  }
};

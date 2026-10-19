-- 0013: per-account AI personality overrides.
-- Every account can now carry its own persona. The creator-level ai_profiles
-- row stays the fallback/default; an account_persona row REPLACES it wholesale
-- for that account when present (no per-field merge: a persona is one voice,
-- mixing half of two voices is how a bot starts sounding like a bot).
-- Column set mirrors ai_profiles minus the wallet (money config is per creator,
-- not per voice) and minus model_provider/model_id (infrastructure stays central).

begin;

create table if not exists account_personas (
  telegram_account_id uuid primary key references telegram_accounts(id) on delete cascade,
  creator_id          text not null references creators(id) on delete cascade,
  -- persona fields, same meaning as ai_profiles
  display_name        text,
  tone                text check (tone in ('warm','playful','professional','concise')),
  message_length      text,
  emoji_level         text,
  system_prompt       text,
  faq                 jsonb,
  approved_links      jsonb,
  boundaries          text,
  escalation_rules    text,
  memory_enabled      boolean not null default true,
  first_contact_line  text,
  disclose_on_first_contact boolean not null default false,
  bot_answer_variants jsonb,
  enabled             boolean not null default true,
  version             integer not null default 1,
  updated_at          timestamptz not null default now()
);
create index if not exists account_personas_creator_idx on account_personas (creator_id);

-- RLS: same posture as the rest of the estate. The console talks through the
-- API worker (service key, bypasses RLS); these policies cover direct
-- anon/authenticated access from the console fallback path.
alter table account_personas enable row level security;

drop policy if exists "account_personas read" on account_personas;
create policy "account_personas read" on account_personas
  for select using (
    creator_id in (select id from creators)
    and creator_id = auth.uid()::text
  );

drop policy if exists "account_personas write" on account_personas;
create policy "account_personas write" on account_personas
  for all using (
    creator_id = auth.uid()::text
  ) with check (
    creator_id = auth.uid()::text
  );

commit;

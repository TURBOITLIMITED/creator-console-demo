-- 0014: columns the account.html edit tab expects, and the per-account
-- persona fallback column the other console path uses.
-- bio/avatar_url: display fields for the bot profile (edit tab).
-- bot_token: never surfaced in the console UI input (readonly there), kept
--   for parity; the API worker remains the only writer that matters.
-- ai_profiles.telegram_account_id: alternate per-account persona storage used
--   by console Data.getAIForAccount/saveAIForAccount. Nullable, so the
--   creator-level default rows stay valid.

begin;

alter table telegram_accounts
  add column if not exists bio text,
  add column if not exists avatar_url text,
  add column if not exists bot_token text;

alter table ai_profiles
  add column if not exists telegram_account_id uuid references telegram_accounts(id) on delete cascade;

create unique index if not exists ai_profiles_account_idx
  on ai_profiles (telegram_account_id)
  where telegram_account_id is not null;

commit;

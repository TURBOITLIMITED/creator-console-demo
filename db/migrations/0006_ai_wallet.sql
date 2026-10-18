-- 0006: wallet address on ai_profiles (creator earnings destination)
alter table ai_profiles
  add column if not exists wallet_address text;

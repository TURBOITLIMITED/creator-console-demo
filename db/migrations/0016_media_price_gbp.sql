-- 0016: GBP price shown to customers. price_ton stays as the internal
-- value the console already collects; price_gbp overrides what the customer
-- is quoted when set, otherwise GBP falls back to the TON number.
alter table media_items add column if not exists price_gbp numeric;

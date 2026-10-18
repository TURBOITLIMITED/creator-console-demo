-- 0005: default ids on business_connections so console inserts work
alter table business_connections
  alter column id set default ('bc-' || gen_random_uuid()::text);

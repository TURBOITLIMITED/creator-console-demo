-- 0011: console can create draft library items without a file yet
alter table media_items alter column media_key drop not null;

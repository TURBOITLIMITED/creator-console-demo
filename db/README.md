# Database Setup

## Project Details
- **Project**: turbo-creator-assistant
- **Project Ref**: `xsgvdlgmhuxozjlbjzxy`
- **URL**: https://xsgvdlgmhuxoxozjlbjzxy.supabase.co
- **Organization**: Turbo IT (second org)

## Migrations

### List of migrations:
1. `0001_telegram_platform.sql` - Core Telegram platform tables (accounts, connections, customers, conversations, messages, AI profiles, etc.)
2. `0002_media_bundles.sql` - Media library and content bundles (media_items, content_bundles, bundle_items, bundle_purchases)

### Apply migrations via Supabase Dashboard:

1. Go to https://supabase.com/dashboard/project/xsgvdlgmhuxozjlbjzxy/editor
2. Run each migration file in order

### Apply migrations via CLI:

```bash
cd /home/ops/repos/turbo-creator
./apply-migrations.sh
```

You'll need your service_role key. Find it at:
https://supabase.com/dashboard/project/xsgvdlgmhuxozjlbjzxy/settings/database

### Apply migrations via psql:

```bash
export SUPABASE_SERVICE_KEY="your-service-role-key-here"
psql "postgresql://postgres:${SUPABASE_SERVICE_KEY}@db.xsgvdlgmhuxozjlbjzxy.supabase.co:6543/postgres?sslmode=require" -f db/migrations/0001_telegram_platform.sql
psql "postgresql://postgres:${SUPABASE_SERVICE_KEY}@db.xsgvdlgmhuxozjlbjzxy.supabase.co:6543/postgres?sslmode=require" -f db/migrations/0002_media_bundles.sql
```

## Current Database State

The database currently has:
- `creators` table with 12 test rows
- `console_admins` table with 1 admin
- Most other tables from the schema are empty or don't exist yet

## Tables to be created by migrations:

### Migration 0001 (Telegram Platform):
- `telegram_accounts` - Connected personal Telegram accounts
- `business_connections` - Telegram Business API connections
- `customers` - Customer CRM per creator
- `conversations` - Extended with business_connection_id, chat_id, etc.
- `messages` - Message storage (encrypted bodies)
- `webhook_events` - Telegram webhook deduplication
- `ai_profiles` - AI persona per creator
- `customer_memories` - Per-customer memory storage
- `ai_jobs` - Async AI job queue
- `consents` - GDPR consent tracking
- `account_keys` - Per-creator encryption keys

### Migration 0002 (Media & Bundles):
- `media_items` - Videos, images, documents per creator
- `content_bundles` - Sellable bundle groups
- `bundle_items` - Links media to bundles
- `bundle_purchases` - Customer purchase history

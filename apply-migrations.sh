#!/bin/bash
# Apply migrations to turbo-creator-assistant Supabase project
# Usage: ./apply-migrations.sh

set -e

PROJECT_REF="xsgvdlgmhuxozjlbjzxy"
PROJECT_URL="https://${PROJECT_REF}.supabase.co"

echo "=== Turbo Creator Migration Script ==="
echo "Project: turbo-creator-assistant (${PROJECT_REF})"
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo "Error: psql not found. Install postgresql-client."
    exit 1
fi

# Get service key from user if not provided
if [ -z "$SUPABASE_SERVICE_KEY" ]; then
    echo "Please provide your Supabase service_role key:"
    echo "Find it at: https://supabase.com/dashboard/project/${PROJECT_REF}/settings/database"
    read -sp "SUPABASE_SERVICE_KEY: " SERVICE_KEY
    echo ""
else
    SERVICE_KEY="$SUPABASE_SERVICE_KEY"
fi

echo ""
echo "Applying migrations..."
echo ""

# Apply migrations
for migration in /home/ops/repos/turbo-creator/db/migrations/*.sql; do
    if [ -f "$migration" ]; then
        echo "Applying: $(basename $migration)"
        psql "postgresql://postgres:${SERVICE_KEY}@db.${PROJECT_REF}.supabase.co:6543/postgres?sslmode=require" -f "$migration"
        echo "  ✓ Complete"
        echo ""
    fi
done

echo "=== All migrations applied successfully ==="

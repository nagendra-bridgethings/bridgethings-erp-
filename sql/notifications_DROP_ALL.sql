-- ============================================================
-- ONE-TIME cleanup: drop everything notification-related.
-- ============================================================
-- Run this ONCE in the Supabase SQL editor to remove the
-- notifications scaffolding (table + function + secrets table)
-- that was created earlier. After running this, the project's
-- email-notification code is fully wiped on both the app and DB
-- sides.
--
-- The pg_net extension is left enabled — it's harmless and may
-- be used by other features later. Drop it manually if you really
-- want it gone:
--     DROP EXTENSION IF EXISTS pg_net;
-- ============================================================

-- Function first (it depends on the tables).
DROP FUNCTION IF EXISTS bridgethings_send_notification(
  TEXT, TEXT, UUID, TEXT, JSONB, UUID, UUID
);

-- Audit table — drops its RLS policies + indexes automatically.
DROP TABLE IF EXISTS bridgethings_notifications;

-- Private secrets table.
DROP TABLE IF EXISTS bridgethings_app_secrets;

-- Verify everything is gone (each query should return 0 rows).
SELECT 'bridgethings_notifications' AS obj, count(*) AS still_exists
FROM pg_tables WHERE tablename = 'bridgethings_notifications'
UNION ALL
SELECT 'bridgethings_app_secrets',        count(*)
FROM pg_tables WHERE tablename = 'bridgethings_app_secrets'
UNION ALL
SELECT 'bridgethings_send_notification',  count(*)
FROM pg_proc WHERE proname = 'bridgethings_send_notification';

-- ============================================================
-- Bridge Things ERP — Protect dashboard credentials behind paid coverage
-- Run in: Supabase Dashboard > SQL Editor (safe to re-run).
--
-- PROBLEM
-- The partner "My Devices" page selected * on bridgethings_order_unit_details,
-- which includes the plaintext dashboard_username/dashboard_password columns.
-- Postgres RLS is row-level only, so once a unit passed the owns-it row check,
-- the password shipped in the network payload for EVERY device the partner
-- owns — regardless of subscription status. An expired-subscription partner
-- could read the password in DevTools and keep using the paid dashboard,
-- bypassing the request→pay→activate paywall.
--
-- FIX
-- The frontend now stops selecting dashboard_password (username stays — it's a
-- login id, useless without the password, and drives the "search by login"
-- feature). The password is fetched on demand through this SECURITY DEFINER
-- RPC, which re-checks ownership AND active paid coverage before returning it.
-- ============================================================

CREATE OR REPLACE FUNCTION bridgethings_get_dashboard_credentials(p_unit_id UUID)
RETURNS TABLE(dashboard_username TEXT, dashboard_password TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Staff set the credentials, so they can always read them.
  IF bridgethings_current_role() IN ('admin','employee','accountant') THEN
    RETURN QUERY
      SELECT u.dashboard_username, u.dashboard_password
      FROM bridgethings_order_unit_details u
      WHERE u.id = p_unit_id;
    RETURN;
  END IF;

  -- Partner: must own the unit's order …
  IF NOT EXISTS (
    SELECT 1
    FROM bridgethings_order_unit_details u
    JOIN bridgethings_order_items i ON i.id = u.order_item_id
    JOIN bridgethings_orders      o ON o.id = i.order_id
    WHERE u.id = p_unit_id
      AND o.partner_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to view these credentials';
  END IF;

  -- … AND have active paid coverage right now (status 'active' with an
  -- end_date today or later — i.e. active or expiring_soon, NOT expired).
  IF NOT EXISTS (
    SELECT 1
    FROM bridgethings_unit_subscriptions s
    WHERE s.unit_id = p_unit_id
      AND s.status = 'active'
      AND s.end_date >= CURRENT_DATE
  ) THEN
    RAISE EXCEPTION 'Subscription is not active for this device';
  END IF;

  RETURN QUERY
    SELECT u.dashboard_username, u.dashboard_password
    FROM bridgethings_order_unit_details u
    WHERE u.id = p_unit_id;
END;
$$;

REVOKE ALL     ON FUNCTION bridgethings_get_dashboard_credentials(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION bridgethings_get_dashboard_credentials(UUID) TO authenticated;

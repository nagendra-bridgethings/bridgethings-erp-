-- ============================================================
-- Fix: accountant can't save dashboard credentials
-- ============================================================
-- Accounts activate the device dashboard and capture the username/password
-- to hand to the partner. setDashboardCredentials() wrote directly to
-- bridgethings_order_unit_details, but that table's RLS allows writes only
-- to admin/employee — the accountant is neither, so the UPDATE silently
-- matched 0 rows and the credentials never saved (partner's "Login" column
-- stayed "—").
--
-- This adds a SECURITY DEFINER helper that updates ONLY the two credential
-- columns, gated to admin / accountant / employee. The app calls it via
-- supabase.rpc instead of a direct table update. Surgical (can't touch
-- serials, status, etc.) and bypasses the table RLS for just these fields.
-- ============================================================
CREATE OR REPLACE FUNCTION bridgethings_set_dashboard_credentials(
  p_unit_id  UUID,
  p_username TEXT,
  p_password TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF bridgethings_current_role() NOT IN ('admin', 'accountant', 'employee') THEN
    RAISE EXCEPTION 'not authorized to set dashboard credentials';
  END IF;

  UPDATE bridgethings_order_unit_details
  SET dashboard_username = NULLIF(btrim(COALESCE(p_username, '')), ''),
      dashboard_password = NULLIF(COALESCE(p_password, ''), ''),  -- passwords kept verbatim (may contain spaces)
      updated_at         = NOW()
  WHERE id = p_unit_id;
END;
$$;

REVOKE ALL ON FUNCTION bridgethings_set_dashboard_credentials(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION bridgethings_set_dashboard_credentials(UUID, TEXT, TEXT) TO authenticated;

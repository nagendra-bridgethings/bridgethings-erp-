-- ============================================================
-- Lock the partner discount_percent so only admins can change it.
-- ============================================================
-- The existing RLS policy lets partners update their own row (so they
-- can edit name/phone/address from the Profile page). That same policy
-- would let a determined partner POST a direct API call to bump their
-- own discount_percent.
--
-- This trigger rejects any UPDATE that touches discount_percent unless
-- the caller's role is 'admin'. Editing other profile fields still works
-- for partners.
-- ============================================================

CREATE OR REPLACE FUNCTION bridgethings_protect_partner_discount()
RETURNS TRIGGER AS $$
BEGIN
  -- IS DISTINCT FROM is NULL-safe equality. If the value isn't being
  -- changed at all, allow the update unconditionally.
  IF NEW.discount_percent IS DISTINCT FROM OLD.discount_percent
     AND bridgethings_current_role() != 'admin' THEN
    RAISE EXCEPTION 'Only admins can change discount_percent'
      USING ERRCODE = '42501'; -- insufficient_privilege
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bridgethings_protect_partner_discount_trg
  ON bridgethings_channelpartners;

CREATE TRIGGER bridgethings_protect_partner_discount_trg
  BEFORE UPDATE ON bridgethings_channelpartners
  FOR EACH ROW
  EXECUTE FUNCTION bridgethings_protect_partner_discount();

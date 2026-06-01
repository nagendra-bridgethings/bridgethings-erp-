-- ============================================================
-- Team assignment for employee users.
-- ============================================================
-- Each employee is either on the Operations team (fills unit details,
-- marks items ready) or the Dispatch team (verifies + ships). The
-- field stays NULL for unassigned users — they get the manual team
-- picker at login as a fallback during initial setup.
--
-- Assign teams from Supabase Table Editor:
--   UPDATE bridgethings_employees SET team = 'operations' WHERE email = '…';
--   UPDATE bridgethings_employees SET team = 'dispatch'   WHERE email = '…';
-- ============================================================

ALTER TABLE bridgethings_employees
  ADD COLUMN IF NOT EXISTS team TEXT
    CHECK (team IS NULL OR team IN ('operations','dispatch'));

CREATE INDEX IF NOT EXISTS idx_employees_team
  ON bridgethings_employees(team);

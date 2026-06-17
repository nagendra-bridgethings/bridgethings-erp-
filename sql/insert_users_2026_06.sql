-- ============================================================
-- Add role rows for existing auth.users  (run in Supabase SQL editor)
-- Date: 2026-06-17
-- ============================================================
-- These auth users already exist (Authentication > Users). This file
-- maps each to its role by inserting into the matching team table.
-- An auth user MUST live in exactly ONE team table.
-- ============================================================

-- CHANNEL PARTNER — bonumukkalanagendrareddy@gmail.com
-- Only email is required; name/company/GST/address are nullable and the
-- partner can fill them later from the Profile page (or set them here).
INSERT INTO bridgethings_channelpartners (id, email)
SELECT id, email
FROM auth.users
WHERE email = 'bonumukkalanagendrareddy@gmail.com'
ON CONFLICT (id) DO NOTHING;

-- ACCOUNTANT — br3909@srmist.edu.in
INSERT INTO bridgethings_accountants (id, email)
SELECT id, email
FROM auth.users
WHERE email = 'br3909@srmist.edu.in'
ON CONFLICT (id) DO NOTHING;

-- EMPLOYEE (Operations) — dev@gmail.com
INSERT INTO bridgethings_employees (id, email, team)
SELECT id, email, 'operations'
FROM auth.users
WHERE email = 'dev@gmail.com'
ON CONFLICT (id) DO UPDATE SET team = EXCLUDED.team;

-- EMPLOYEE (Dispatch) — test@gmail.com
INSERT INTO bridgethings_employees (id, email, team)
SELECT id, email, 'dispatch'
FROM auth.users
WHERE email = 'test@gmail.com'
ON CONFLICT (id) DO UPDATE SET team = EXCLUDED.team;

-- ============================================================
-- Verify (optional): confirm each landed in exactly one table.
-- ============================================================
-- SELECT 'partner'    AS role, email FROM bridgethings_channelpartners WHERE email = 'bonumukkalanagendrareddy@gmail.com'
-- UNION ALL SELECT 'accountant', email FROM bridgethings_accountants    WHERE email = 'br3909@srmist.edu.in'
-- UNION ALL SELECT 'employee:'||COALESCE(team,'(none)'), email FROM bridgethings_employees WHERE email IN ('dev@gmail.com','test@gmail.com');

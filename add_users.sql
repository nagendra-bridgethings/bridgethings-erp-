-- ============================================================
-- HOW TO ADD USERS TO Bridge Things ERP   (v2: NO profiles)
-- Run AFTER your main schema.sql
-- ============================================================
--
-- STEP 1: Create the user in Supabase Auth
--   Go to: Supabase Dashboard > Authentication > Users > Add User
--   Enter their email + password and click "Create User".
--   (No trigger fires anymore — the user just sits in auth.users
--    until you INSERT them into the right team table below.)
--
-- STEP 2: Run the INSERT for whichever role they should have.
--   The user's role is determined by which team table they belong
--   to. The same email/auth user MUST NOT appear in more than one
--   team table — login will pick the first match and the others
--   will be unreachable.
-- ============================================================

-- ADMIN
INSERT INTO bridgethings_admins (id, email)
SELECT id, email
FROM auth.users
WHERE email = 'nagendra@bridgethings.com'
ON CONFLICT (id) DO NOTHING;

-- EMPLOYEE
INSERT INTO bridgethings_employees (id, email)
SELECT id, email
FROM auth.users
WHERE email = 'ravi@bridgethings.com'
ON CONFLICT (id) DO NOTHING;

-- ACCOUNTANT
INSERT INTO bridgethings_accountants (id, email)
SELECT id, email
FROM auth.users
WHERE email = 'priya@bridgethings.com'
ON CONFLICT (id) DO NOTHING;

-- PARTNER
INSERT INTO bridgethings_channelpartners (id, email, name, phone, company_name, gst_number, address, city, state, pincode)
SELECT id, email, 'ABC Solutions', '9876543210', 'ABC Solutions Pvt Ltd',
       '29ABCDE1234F1Z5', '123, MG Road', 'Bangalore', 'Karnataka', '560001'
FROM auth.users
WHERE email = 'partner@abcsolutions.com'
ON CONFLICT (id) DO UPDATE
SET name         = EXCLUDED.name,
    phone        = EXCLUDED.phone,
    company_name = EXCLUDED.company_name,
    gst_number   = EXCLUDED.gst_number,
    address      = EXCLUDED.address,
    city         = EXCLUDED.city,
    state        = EXCLUDED.state,
    pincode      = EXCLUDED.pincode;

-- ============================================================
-- HOW LOGIN WORKS (v2):
-- 1. User selects their role (Admin / Employee / Accountant / Partner)
-- 2. Enters email + password
-- 3. Supabase authenticates and returns auth.users.id
-- 4. App looks the id up across the 4 team tables, in order
-- 5. Whichever team table contains the id IS the user's role
-- 6. If the discovered role matches the selected role  -> logged in
-- 7. Otherwise -> login is rejected with a clear error
-- ============================================================

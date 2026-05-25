-- ============================================================
-- Bridge Things ERP — Complete Database Setup  (v2: NO profiles)
-- Run this ONCE in: Supabase Dashboard > SQL Editor > New Query
--
-- Every database object is prefixed with `bridgethings_` so it
-- can safely coexist alongside other apps inside the SAME
-- Supabase project (one Supabase project = one Postgres DB).
--
-- v2 DESIGN CHANGES (vs the old profiles-based design):
--   - `bridgethings_profiles` is REMOVED.
--   - Each of the 4 roles now lives in its own self-contained
--     table. The PK is `id` and equals the auth.users.id directly.
--     The user's "role" is IMPLICIT: whichever team table contains
--     a row for the auth user IS their role. An email/auth user
--     must appear in EXACTLY ONE team table.
--   - The `bridgethings_on_auth_user_created` trigger is REMOVED,
--     so signups from OTHER apps in the same Supabase project no
--     longer pollute this app's tables. Users are added manually
--     to the right team table — see add_users.sql.
--
-- TABLES CREATED:
--   1. bridgethings_admins         → Admin team members
--   2. bridgethings_employees      → Operational employees
--   3. bridgethings_accountants    → Finance / accounting team
--   4. bridgethings_channelpartners       → Channel partners (customers)
--   5. bridgethings_products       → Product catalog
--   6. bridgethings_orders         → POs from channel partners
--   7. bridgethings_order_items    → Line items inside each order
--   8. bridgethings_devices        → Physical devices (serial, MAC)
--   9. bridgethings_subscriptions  → Device subscriptions per end-customer
--   10. bridgethings_audit_logs    → Auto-recorded activity trail
--
-- ENUM TYPES CREATED:
--   bridgethings_user_role, bridgethings_order_status,
--   bridgethings_fulfillment_status, bridgethings_payment_status
--
-- TRIGGERS CREATED:
--   bridgethings_orders_audit   (on bridgethings_orders)
--   bridgethings_devices_audit  (on bridgethings_devices)
--
-- FUNCTIONS CREATED:
--   bridgethings_current_role(), bridgethings_log_audit_event()
--
-- WARNING — this script is DESTRUCTIVE for the v1 profiles design:
--   It DROPs `bridgethings_profiles` (CASCADE) plus the v1 auth.users
--   trigger and the v1 team tables (which were keyed by profile_id).
--   If you have important data in any of those, MIGRATE IT FIRST.
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── ENUM Types (prefixed) ───────────────────────────────────
DO $$ BEGIN
  CREATE TYPE bridgethings_user_role AS ENUM ('admin', 'employee', 'accountant', 'partner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bridgethings_order_status AS ENUM ('draft', 'pending_approval', 'active', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bridgethings_fulfillment_status AS ENUM ('in_process', 'calibration', 'ready_to_ship', 'shipped', 'delivered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bridgethings_payment_status AS ENUM ('pending', 'partial', 'completed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Clean up the OLD v1 profiles-based design ───────────────
-- The v1 auth.users trigger inserted a row into profiles for EVERY
-- signup in the Supabase project — even users belonging to other
-- apps. We don't want that anymore.
DROP TRIGGER  IF EXISTS bridgethings_on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS bridgethings_handle_new_user();

-- Drop the old team tables (they were keyed by `profile_id`) so we
-- can recreate them with the new shape: PK `id` = auth.users.id.
DROP TABLE IF EXISTS bridgethings_admins      CASCADE;
DROP TABLE IF EXISTS bridgethings_employees   CASCADE;
DROP TABLE IF EXISTS bridgethings_accountants CASCADE;
DROP TABLE IF EXISTS bridgethings_channelpartners    CASCADE;

-- Drop the old profiles table. CASCADE removes only the FK
-- *constraints* on orders.partner_id, subscriptions.partner_id and
-- audit_logs.user_id — the columns themselves are preserved. We
-- re-add the FKs (pointing at bridgethings_channelpartners / auth.users)
-- further down.
DROP TABLE    IF EXISTS bridgethings_profiles CASCADE;
DROP FUNCTION IF EXISTS bridgethings_current_role() CASCADE;

-- ============================================================
-- TABLE 1: bridgethings_admins   (Team: Admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_admins (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE 2: bridgethings_employees   (Team: Employees)
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_employees (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE 3: bridgethings_accountants   (Team: Accountants)
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_accountants (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE 4: bridgethings_channelpartners   (Team: Channel Partners)
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_channelpartners (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  phone        TEXT,
  company_name TEXT,
  gst_number   TEXT,
  address      TEXT,
  city         TEXT,
  state        TEXT,
  pincode      TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Helper function — returns the caller's role by checking which
-- team table they live in. Used by RLS policies. SECURITY DEFINER
-- so it bypasses RLS on the team tables (avoiding recursion when
-- a team-table policy itself calls this function).
CREATE OR REPLACE FUNCTION bridgethings_current_role()
RETURNS bridgethings_user_role
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM bridgethings_admins      WHERE id = auth.uid()) THEN 'admin'::bridgethings_user_role
    WHEN EXISTS (SELECT 1 FROM bridgethings_employees   WHERE id = auth.uid()) THEN 'employee'::bridgethings_user_role
    WHEN EXISTS (SELECT 1 FROM bridgethings_accountants WHERE id = auth.uid()) THEN 'accountant'::bridgethings_user_role
    WHEN EXISTS (SELECT 1 FROM bridgethings_channelpartners    WHERE id = auth.uid()) THEN 'partner'::bridgethings_user_role
  END;
$$;

-- ============================================================
-- TABLE 5: bridgethings_products
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_products (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  description TEXT,
  features    TEXT[] DEFAULT '{}',
  image_url   TEXT,
  base_price  DECIMAL(12,2) DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE 6: bridgethings_orders
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_orders (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  partner_id         UUID REFERENCES bridgethings_channelpartners(id) ON DELETE SET NULL,
  status             bridgethings_order_status DEFAULT 'draft',
  fulfillment_status bridgethings_fulfillment_status DEFAULT 'in_process',
  total_amount       DECIMAL(12,2) DEFAULT 0,
  amount_paid        DECIMAL(12,2) DEFAULT 0,
  payment_status     bridgethings_payment_status DEFAULT 'pending',
  employee_notes     TEXT,
  delivery_method    TEXT,
  tracking_number    TEXT,
  delivered_date     DATE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- If the table already existed from v1, its partner_id FK was
-- pointing at profiles (and the constraint was dropped by the
-- CASCADE above). Re-point it at bridgethings_channelpartners.
ALTER TABLE bridgethings_orders
  DROP CONSTRAINT IF EXISTS bridgethings_orders_partner_id_fkey;
ALTER TABLE bridgethings_orders
  ADD  CONSTRAINT bridgethings_orders_partner_id_fkey
  FOREIGN KEY (partner_id) REFERENCES bridgethings_channelpartners(id) ON DELETE SET NULL;

-- ============================================================
-- TABLE 7: bridgethings_order_items
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_order_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        UUID REFERENCES bridgethings_orders(id) ON DELETE CASCADE,
  product_id      UUID REFERENCES bridgethings_products(id) ON DELETE SET NULL,
  qty             INTEGER DEFAULT 1,
  unit_price      DECIMAL(12,2) DEFAULT 0,
  requested_date  DATE,
  confirmed_date  DATE,
  serial_number   TEXT,
  mac_id          TEXT,
  notes           TEXT
);

-- ============================================================
-- TABLE 8: bridgethings_devices
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_devices (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_item_id      UUID REFERENCES bridgethings_order_items(id) ON DELETE SET NULL,
  serial_number      TEXT UNIQUE,
  mac_id             TEXT UNIQUE,
  fulfillment_status bridgethings_fulfillment_status DEFAULT 'in_process',
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE 9: bridgethings_subscriptions
-- ============================================================
CREATE TABLE IF NOT EXISTS bridgethings_subscriptions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  device_id        UUID REFERENCES bridgethings_devices(id) ON DELETE SET NULL,
  partner_id       UUID REFERENCES bridgethings_channelpartners(id) ON DELETE SET NULL,
  order_id         UUID REFERENCES bridgethings_orders(id) ON DELETE SET NULL,
  customer_name    TEXT NOT NULL,
  customer_contact TEXT,
  customer_address TEXT,
  plan_type        TEXT NOT NULL DEFAULT '1Y',
  start_date       DATE NOT NULL,
  end_date         DATE NOT NULL,
  payment_status   bridgethings_payment_status DEFAULT 'pending',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bridgethings_subscriptions
  DROP CONSTRAINT IF EXISTS bridgethings_subscriptions_partner_id_fkey;
ALTER TABLE bridgethings_subscriptions
  ADD  CONSTRAINT bridgethings_subscriptions_partner_id_fkey
  FOREIGN KEY (partner_id) REFERENCES bridgethings_channelpartners(id) ON DELETE SET NULL;

-- ============================================================
-- TABLE 10: bridgethings_audit_logs
-- ============================================================
-- The acting user can come from ANY of the 4 team tables, so
-- `user_id` references auth.users(id) directly. `user_role` is
-- captured at write time by the trigger for easy filtering.
CREATE TABLE IF NOT EXISTS bridgethings_audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type TEXT NOT NULL,
  target_id   UUID,
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_name   TEXT,
  user_role   bridgethings_user_role,
  action      TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  timestamp   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bridgethings_audit_logs
  ADD COLUMN IF NOT EXISTS user_role bridgethings_user_role;
ALTER TABLE bridgethings_audit_logs
  DROP CONSTRAINT IF EXISTS bridgethings_audit_logs_user_id_fkey;
ALTER TABLE bridgethings_audit_logs
  ADD  CONSTRAINT bridgethings_audit_logs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Auto-log trigger function (looks the acting user up across the
-- 4 team tables to capture their name AND role at write time).
CREATE OR REPLACE FUNCTION bridgethings_log_audit_event()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acting_name TEXT;
  acting_role bridgethings_user_role;
BEGIN
  SELECT u.name, u.role INTO acting_name, acting_role FROM (
    SELECT id, email AS name, 'admin'::bridgethings_user_role      AS role FROM bridgethings_admins
    UNION ALL
    SELECT id, email AS name, 'employee'::bridgethings_user_role   AS role FROM bridgethings_employees
    UNION ALL
    SELECT id, email AS name, 'accountant'::bridgethings_user_role AS role FROM bridgethings_accountants
    UNION ALL
    SELECT id, name, 'partner'::bridgethings_user_role    AS role FROM bridgethings_channelpartners
  ) AS u WHERE u.id = auth.uid();

  INSERT INTO bridgethings_audit_logs (entity_type, target_id, user_id, user_name, user_role, action, old_value, new_value)
  VALUES (
    REPLACE(TG_TABLE_NAME, 'bridgethings_', ''),
    NEW.id,
    auth.uid(),
    COALESCE(acting_name, 'System'),
    acting_role,
    REPLACE(TG_TABLE_NAME, 'bridgethings_', '') || ' updated',
    row_to_json(OLD)::TEXT,
    row_to_json(NEW)::TEXT
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bridgethings_orders_audit  ON bridgethings_orders;
DROP TRIGGER IF EXISTS bridgethings_devices_audit ON bridgethings_devices;

CREATE TRIGGER bridgethings_orders_audit
  AFTER UPDATE ON bridgethings_orders
  FOR EACH ROW EXECUTE FUNCTION bridgethings_log_audit_event();

CREATE TRIGGER bridgethings_devices_audit
  AFTER UPDATE ON bridgethings_devices
  FOR EACH ROW EXECUTE FUNCTION bridgethings_log_audit_event();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================
ALTER TABLE bridgethings_admins        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_employees     ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_accountants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_channelpartners      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_order_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_devices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bridgethings_audit_logs    ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid duplicates on re-run
DO $$ DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies
    WHERE tablename IN (
      'bridgethings_admins','bridgethings_employees','bridgethings_accountants','bridgethings_channelpartners',
      'bridgethings_products','bridgethings_orders','bridgethings_order_items',
      'bridgethings_devices','bridgethings_subscriptions','bridgethings_audit_logs'
    )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ── Team tables ────────────────────────────────────────────
-- Each user can read/update their own row.
-- Staff (admin/employee/accountant) can read every team table.
-- Only admins can INSERT new team members (bootstrap the first
-- admin via the SQL editor / service_role — that bypasses RLS).
--
-- NOTE: every login flow uses .maybeSingle() on the 4 team tables.
-- The read_own policy is what lets a freshly-signed-in user find
-- their own row.

-- admins
CREATE POLICY "bridgethings_admins_read_own"    ON bridgethings_admins FOR SELECT USING (id = auth.uid());
CREATE POLICY "bridgethings_admins_read_staff"  ON bridgethings_admins FOR SELECT USING (
  bridgethings_current_role() IN ('admin','employee','accountant')
);
CREATE POLICY "bridgethings_admins_update_own"  ON bridgethings_admins FOR UPDATE USING (id = auth.uid());
CREATE POLICY "bridgethings_admins_insert"      ON bridgethings_admins FOR INSERT WITH CHECK (
  bridgethings_current_role() = 'admin'
);

-- employees
CREATE POLICY "bridgethings_employees_read_own"   ON bridgethings_employees FOR SELECT USING (id = auth.uid());
CREATE POLICY "bridgethings_employees_read_staff" ON bridgethings_employees FOR SELECT USING (
  bridgethings_current_role() IN ('admin','employee','accountant')
);
CREATE POLICY "bridgethings_employees_update_own" ON bridgethings_employees FOR UPDATE USING (id = auth.uid());
CREATE POLICY "bridgethings_employees_insert"     ON bridgethings_employees FOR INSERT WITH CHECK (
  bridgethings_current_role() = 'admin'
);

-- accountants
CREATE POLICY "bridgethings_accountants_read_own"   ON bridgethings_accountants FOR SELECT USING (id = auth.uid());
CREATE POLICY "bridgethings_accountants_read_staff" ON bridgethings_accountants FOR SELECT USING (
  bridgethings_current_role() IN ('admin','employee','accountant')
);
CREATE POLICY "bridgethings_accountants_update_own" ON bridgethings_accountants FOR UPDATE USING (id = auth.uid());
CREATE POLICY "bridgethings_accountants_insert"     ON bridgethings_accountants FOR INSERT WITH CHECK (
  bridgethings_current_role() = 'admin'
);

-- partners
CREATE POLICY "bridgethings_channelpartners_read_own"   ON bridgethings_channelpartners FOR SELECT USING (id = auth.uid());
CREATE POLICY "bridgethings_channelpartners_read_staff" ON bridgethings_channelpartners FOR SELECT USING (
  bridgethings_current_role() IN ('admin','employee','accountant')
);
CREATE POLICY "bridgethings_channelpartners_update_own" ON bridgethings_channelpartners FOR UPDATE USING (id = auth.uid());
CREATE POLICY "bridgethings_channelpartners_insert"     ON bridgethings_channelpartners FOR INSERT WITH CHECK (
  bridgethings_current_role() IN ('admin','employee')
);

-- products
CREATE POLICY "bridgethings_products_read"   ON bridgethings_products FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "bridgethings_products_insert" ON bridgethings_products FOR INSERT WITH CHECK (
  bridgethings_current_role() IN ('admin','employee')
);
CREATE POLICY "bridgethings_products_update" ON bridgethings_products FOR UPDATE USING (
  bridgethings_current_role() IN ('admin','employee')
);
CREATE POLICY "bridgethings_products_delete" ON bridgethings_products FOR DELETE USING (
  bridgethings_current_role() IN ('admin','employee')
);

-- orders
CREATE POLICY "bridgethings_orders_read"   ON bridgethings_orders FOR SELECT USING (
  partner_id = auth.uid() OR
  bridgethings_current_role() IN ('admin','employee','accountant')
);
CREATE POLICY "bridgethings_orders_insert" ON bridgethings_orders FOR INSERT WITH CHECK (partner_id = auth.uid());
CREATE POLICY "bridgethings_orders_update" ON bridgethings_orders FOR UPDATE USING (
  bridgethings_current_role() IN ('admin','employee','accountant')
  OR partner_id = auth.uid()
);

-- order_items
CREATE POLICY "bridgethings_order_items_read"   ON bridgethings_order_items FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "bridgethings_order_items_insert" ON bridgethings_order_items FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "bridgethings_order_items_update" ON bridgethings_order_items FOR UPDATE USING (
  bridgethings_current_role() IN ('admin','employee')
);

-- devices
CREATE POLICY "bridgethings_devices_read"  ON bridgethings_devices FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "bridgethings_devices_write" ON bridgethings_devices FOR ALL USING (
  bridgethings_current_role() IN ('admin','employee')
);

-- subscriptions
CREATE POLICY "bridgethings_subs_read"   ON bridgethings_subscriptions FOR SELECT USING (
  partner_id = auth.uid() OR
  bridgethings_current_role() IN ('admin','employee','accountant')
);
CREATE POLICY "bridgethings_subs_insert" ON bridgethings_subscriptions FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "bridgethings_subs_update" ON bridgethings_subscriptions FOR UPDATE USING (
  bridgethings_current_role() IN ('admin','employee')
);

-- audit_logs  (read-only via RLS; writes only via trigger)
CREATE POLICY "bridgethings_audit_read" ON bridgethings_audit_logs FOR SELECT USING (
  bridgethings_current_role() IN ('admin','employee')
);

-- ============================================================
-- DONE — 10 prefixed tables created (no profiles).
--
-- NEXT STEPS:
--   1. Authentication > Users > Add User  (create email + password)
--   2. Run add_users.sql to INSERT each user into the correct team table
--   3. Storage > New Bucket
--        Name: bridgethings-product-images   |   Public: YES
-- ============================================================

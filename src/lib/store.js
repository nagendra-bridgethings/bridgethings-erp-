// src/lib/store.js — Role string constants.
// The historical MOCK_* arrays that lived here were removed once the app
// migrated to Supabase. ROLES is kept because MainLayout still uses it
// to decide which sidebar nav to show.

export const ROLES = {
  ADMIN:      'admin',
  EMPLOYEE:   'employee',
  ACCOUNTANT: 'accountant',
  PARTNER:    'partner',
};

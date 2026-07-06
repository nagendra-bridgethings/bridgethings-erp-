// src/lib/auth.jsx — Supabase Auth with role validation
// The user's role is implicit: whichever of the 4 team tables contains their
// auth.users.id IS their role. There is no `bridgethings_profiles` table.
import { createContext, useContext, useState, useEffect, useRef } from 'react';
import { supabase } from './supabase';

const AuthContext = createContext(null);

const ROLE_TABLE = {
  admin:      'bridgethings_admins',
  employee:   'bridgethings_employees',
  accountant: 'bridgethings_accountants',
  partner:    'bridgethings_channelpartners',
};

const ROLE_LABEL = {
  admin: 'Admin',
  employee: 'Operations',
  accountant: 'Accountant',
  partner: 'Channel Partner',
};

// We cache the user's role + profile in localStorage so session restore can
// (a) skip the loading spinner entirely by hydrating from cache, and (b) do
// ONE targeted table query in the background instead of scanning all 4 role
// tables. Cache is namespaced with user id so it remains correct across logouts.
const cachedRoleKey    = (userId) => `bridgethings.role.${userId}`;
const cachedProfileKey = (userId) => `bridgethings.profile.${userId}`;

const readCachedRole = (userId) => {
  try {
    const v = localStorage.getItem(cachedRoleKey(userId));
    return ROLE_TABLE[v] ? v : null;
  } catch { return null; }
};
const writeCachedRole = (userId, role) => {
  try { localStorage.setItem(cachedRoleKey(userId), role); } catch { /* ignore */ }
};
const readCachedProfile = (userId) => {
  try {
    const raw = localStorage.getItem(cachedProfileKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && ROLE_TABLE[parsed.role] ? parsed : null;
  } catch { return null; }
};
const writeCachedProfile = (userId, profile) => {
  try { localStorage.setItem(cachedProfileKey(userId), JSON.stringify(profile)); } catch { /* ignore */ }
};
const clearCachedRole = (userId) => {
  try {
    localStorage.removeItem(cachedRoleKey(userId));
    localStorage.removeItem(cachedProfileKey(userId));
  } catch { /* ignore */ }
};

// Read the session user directly from Supabase's localStorage entry without
// hitting the network. Lets us hydrate user state synchronously at mount.
// Supabase's storage shape has varied across versions; check several paths.
const readPersistedSupabaseUser = () => {
  try {
    const keys = Object.keys(localStorage);
    const supabaseKey = keys.find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
    if (!supabaseKey) return null;
    const raw = localStorage.getItem(supabaseKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (
      parsed?.user ||
      parsed?.currentSession?.user ||
      parsed?.session?.user ||
      parsed?.data?.session?.user ||
      null
    );
  } catch { return null; }
};

// Remove Supabase's persisted session from localStorage. Used when a
// server-side signOut fails or times out: supabase-js does NOT clear the
// stored session on network failure, so without this a "signed out" user
// is silently signed back in on the next page load — a real exposure on
// shared machines.
const removePersistedSupabaseSession = () => {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sb-') && (k.endsWith('-auth-token') || k.endsWith('-auth-token-code-verifier'))) {
        localStorage.removeItem(k);
      }
    }
  } catch { /* ignore */ }
};

const withTimeout = (promise, ms, label = 'request') =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);

// Look the user up in ONE specific role table. Returns { ...row, role } or null.
const fetchProfileFromTable = async (userId, role) => {
  const table = ROLE_TABLE[role];
  if (!table) return null;
  try {
    const { data, error } = await withTimeout(
      supabase.from(table).select('*').eq('id', userId).maybeSingle(),
      5000,
      `${table} lookup`
    );
    if (error) {
      console.error(`[auth] ${table} query error:`, error.message);
      return null;
    }
    return data ? { ...data, role } : null;
  } catch (e) {
    console.error(`[auth] ${table} timed out:`, e.message);
    return null;
  }
};

// Session-restore lookup: we don't know which table they're in, so query all 4
// IN PARALLEL (not sequentially) and take whichever returns a row.
const fetchProfileAcrossTables = async (userId) => {
  const roles = Object.keys(ROLE_TABLE);
  const results = await Promise.all(roles.map(r => fetchProfileFromTable(userId, r)));
  return results.find(r => r !== null) || null;
};

// Fast path used on session restore: if we've cached the role from a previous
// successful login, hit just that one table — and KEEP querying it on
// transient failures instead of falling back to a different role.
//
// Why no fallback when cached role's table is empty? In dev we have one user
// across multiple role tables. The cross-table scan returns the first match
// (admin), so a transient partner-table failure would cause a partner login
// to briefly flash the admin dashboard. Trusting the cache prevents that.
//
// The cross-table scan still runs for genuinely-unknown users (no cache,
// e.g. very first session with imported data).
const fetchProfileWithRetry = async (userId) => {
  const cachedRole = readCachedRole(userId);
  if (cachedRole) {
    const first = await fetchProfileFromTable(userId, cachedRole);
    if (first) return first;
    // One quick retry for transient failures (network, RLS slow path).
    await new Promise(r => setTimeout(r, 500));
    const retry = await fetchProfileFromTable(userId, cachedRole);
    if (retry) return retry;
    // Two consecutive misses → cached role is genuinely stale. Clear it
    // and fall through to the cross-table scan as a last resort.
    clearCachedRole(userId);
  }

  let data = await fetchProfileAcrossTables(userId);
  if (data) return data;
  await new Promise(r => setTimeout(r, 500));
  data = await fetchProfileAcrossTables(userId);
  return data;
};

export function AuthProvider({ children }) {
  // Hydrate from localStorage synchronously so a reload doesn't show the
  // global "Loading Bridge Things ERP..." spinner if we have cached data.
  // Supabase persists the session in localStorage already; we just read it.
  //
  // Three hydration tiers, in order of preference:
  //   1. Full cached profile — best, renders the whole UI from cache
  //   2. Cached role only    — stub profile {role} so MainLayout can pick nav
  //   3. Nothing             — fall back to the legacy spinner+network path
  const initialUser = readPersistedSupabaseUser();
  let initialProfile = null;
  if (initialUser) {
    initialProfile = readCachedProfile(initialUser.id);
    if (!initialProfile) {
      const cachedRole = readCachedRole(initialUser.id);
      if (cachedRole) {
        // Stub profile: enough for currentUser to be non-null and for the
        // sidebar to pick the right nav. The background fetch fills in
        // name/phone/etc shortly after.
        initialProfile = { role: cachedRole };
      }
    }
  }
  const hadCachedHydration = !!(initialUser && initialProfile);

  const [user, setUser]       = useState(initialUser);
  const [profile, setProfile] = useState(initialProfile);
  // If we hydrated from cache, we don't need to block render on the network.
  // The onAuthStateChange listener still runs and will reconcile the cache
  // with the server in the background.
  const [loading, setLoading] = useState(!hadCachedHydration);

  // Tracks the auth.users.id whose profile is already loaded into React
  // state. If the listener fires SIGNED_IN/INITIAL_SESSION for the same
  // user, we skip the expensive cross-table refetch.
  //
  // Initialised from a FULL hydrated profile (one with at least name/email
  // fields, not just the `{role}` stub). When that's available it IS the
  // source of truth for this session — the listener should not silently
  // re-fetch and potentially return a different role for users with
  // multi-table test data. For stub hydration (role only), we leave the ref
  // null so the listener still completes the fetch to fill in details.
  const hasFullCachedProfile = !!(initialProfile && (initialProfile.id || initialProfile.name || initialProfile.email));
  const loadedUserIdRef = useRef(hasFullCachedProfile ? initialUser?.id ?? null : null);

  // Set to true while login() is running. The onAuthStateChange listener
  // checks this and skips its own profile fetch — otherwise the listener
  // would race login() and (if the same email exists in multiple role
  // tables) briefly show the wrong dashboard before login() corrects it.
  const loginInFlightRef = useRef(false);
  // Handle of the delayed release below — cleared at the start of the next
  // login() so a leftover timer from a failed attempt can't drop the flag
  // in the middle of a fresh attempt.
  const loginReleaseTimerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    // Hard safety net. 30s is well above the worst-case 4×5s parallel
    // queries plus a retry, so it only fires if something is truly stuck.
    const safetyTimer = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 30000);

    // In supabase-js v2 the listener fires once with INITIAL_SESSION on
    // subscribe, so we don't need a separate getSession() call.
    // Dispatch by event name so a token-refresh hiccup or USER_UPDATED
    // event can't accidentally clear authenticated state.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (cancelled) return;

      // Only an EXPLICIT sign-out clears state. Don't infer it from a null
      // session on any other event — that's how phantom logouts happen.
      if (event === 'SIGNED_OUT') {
        loadedUserIdRef.current = null;
        setUser(null);
        setProfile(null);
        setLoading(false);
        return;
      }

      // Token refresh / user-updated events already carry a fresh session.
      // The profile didn't change; just refresh the supabase user object.
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (session?.user) setUser(session.user);
        return;
      }

      // INITIAL_SESSION / SIGNED_IN / PASSWORD_RECOVERY
      if (session?.user) {
        // login() is actively setting up state for THIS user — let it own
        // the profile. Otherwise our generic cross-table scan can return a
        // different role first (admin matches before accountant) and cause
        // a brief flash of the wrong dashboard.
        if (loginInFlightRef.current) {
          setUser(session.user);
          if (!cancelled) setLoading(false);
          return;
        }

        // If this user is already loaded (e.g. login() just populated state
        // and supabase is now firing the delayed SIGNED_IN), just refresh
        // the user object and skip the profile re-fetch entirely.
        if (loadedUserIdRef.current === session.user.id) {
          setUser(session.user);
          if (!cancelled) setLoading(false);
          return;
        }

        setUser(session.user);
        const data = await fetchProfileWithRetry(session.user.id);
        if (cancelled) return;
        if (data) {
          loadedUserIdRef.current = session.user.id;
          writeCachedRole(session.user.id, data.role);
          writeCachedProfile(session.user.id, data);
        }
        setProfile(data);
      } else {
        // INITIAL_SESSION with no session = genuinely not logged in.
        loadedUserIdRef.current = null;
        setUser(null);
        setProfile(null);
      }
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, []);

  /**
   * login(email, password, selectedRole)
   * selectedRole: 'admin' | 'employee' | 'accountant' | 'partner'
   * Only the table matching `selectedRole` is queried — picking the wrong
   * role fails even if the credentials are valid for a different role.
   */
  const login = async (email, password, selectedRole) => {
    if (!ROLE_TABLE[selectedRole]) {
      throw new Error('Please select a role before signing in.');
    }

    // Suppress the auth-state listener for the entire login flow so it
    // can't race us and briefly set the wrong role. Clear any pending
    // release timer from a previous attempt first — it would otherwise
    // fire mid-flow and un-suppress the listener too early.
    if (loginReleaseTimerRef.current) clearTimeout(loginReleaseTimerRef.current);
    loginInFlightRef.current = true;

    try {
      let signInResult;
      try {
        signInResult = await withTimeout(
          supabase.auth.signInWithPassword({ email, password }),
          10000,
          'sign in'
        );
      } catch {
        throw new Error('Connection timed out. Please check your network and try again.');
      }

      const { data, error } = signInResult;
      if (error || !data?.user) throw new Error('Incorrect email or password.');

      // Claim ownership of this user.id so any future SIGNED_IN event after
      // we release the flag still hits the fast path.
      loadedUserIdRef.current = data.user.id;

      // One retry before concluding role mismatch: fetchProfileFromTable
      // returns null for BOTH "no row" and "query error/timeout", and a
      // single transient failure here would sign a valid user out with a
      // misleading "wrong role" message.
      let profileData = await fetchProfileFromTable(data.user.id, selectedRole);
      if (!profileData) {
        await new Promise(r => setTimeout(r, 500));
        profileData = await fetchProfileFromTable(data.user.id, selectedRole);
      }

      if (!profileData) {
        clearCachedRole(data.user.id);
        loadedUserIdRef.current = null;
        let signOutFailed;
        try {
          const { error: soErr } = await withTimeout(supabase.auth.signOut(), 5000, 'signOut');
          signOutFailed = !!soErr;
        } catch { signOutFailed = true; }
        // A failed server signOut leaves the session in localStorage — the
        // "wrong role" rejection would silently log them back in on reload.
        if (signOutFailed) removePersistedSupabaseSession();
        setUser(null);
        setProfile(null);
        throw new Error(
          `This account is not registered as "${ROLE_LABEL[selectedRole]}". Please select the correct role.`
        );
      }

      setUser(data.user);
      setProfile(profileData);
      writeCachedRole(data.user.id, profileData.role);
      writeCachedProfile(data.user.id, profileData);
      return profileData;
    } finally {
      // Keep the flag set for a tick so any queued SIGNED_IN event from the
      // signInWithPassword call still sees it set and skips its own fetch.
      loginReleaseTimerRef.current = setTimeout(() => { loginInFlightRef.current = false; }, 300);
    }
  };

  const logout = async () => {
    if (user?.id) clearCachedRole(user.id);
    loadedUserIdRef.current = null;
    // supabase-js resolves with { error } (does NOT throw) on network
    // failure AND skips removing the stored session — so an unchecked
    // signOut can leave the user auto-logged-in on the next reload.
    let failed;
    try {
      const { error } = await withTimeout(supabase.auth.signOut(), 5000, 'signOut');
      failed = !!error;
    } catch { failed = true; }
    if (failed) removePersistedSupabaseSession();
    setUser(null);
    setProfile(null);
  };

  // Re-read the current user's row from their role table. Call this after
  // mutating the profile (e.g. on a "Save Changes" form) so the rest of the
  // app sees the updated values immediately. Also writes the cache so the
  // next reload hydrates with the updated data.
  const refreshProfile = async () => {
    if (!user || !profile?.role) return null;
    const data = await fetchProfileFromTable(user.id, profile.role);
    if (data) {
      setProfile(data);
      writeCachedProfile(user.id, data);
    }
    return data;
  };

  const currentUser = user && profile ? {
    ...profile,
    email: user.email,
    supabaseId: user.id,
  } : null;

  return (
    <AuthContext.Provider value={{ user: currentUser, rawUser: user, profile, loading, login, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

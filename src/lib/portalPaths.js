// Resolve which ops sub-team an employee is on. DB-assigned `user.team`
// wins; falls back to the localStorage picker for users not yet assigned
// to a team; default is 'operations'. Use this anywhere the ops/dispatch
// UX needs to diverge.
export function resolveOpsTeam(user) {
  if (user?.team === 'dispatch' || user?.team === 'operations') return user.team;
  try {
    const stored = localStorage.getItem('bridgethings:lastTeam');
    return stored === 'dispatch' ? 'dispatch' : 'operations';
  } catch { return 'operations'; }
}

// Per-role URL prefix. Employees see /operations or /dispatch in their URL
// (matches the "Operations Portal" / "Dispatch Portal" sidebar label),
// admins keep /admin, accountants /finance, partners /partner.
export function portalPrefixFor(user) {
  const role = user?.role;
  if (role === 'employee') {
    if (user?.team === 'dispatch')   return '/dispatch';
    if (user?.team === 'operations') return '/operations';
    try {
      const stored = localStorage.getItem('bridgethings:lastTeam');
      if (stored === 'dispatch') return '/dispatch';
    } catch { /* ignore */ }
    return '/operations';
  }
  if (role === 'admin')      return '/admin';
  if (role === 'accountant') return '/finance';
  if (role === 'partner')    return '/partner';
  return '/login';
}

// src/lib/productName.js — two names per product.
//
// Products carry a customer-facing `name` (what channel partners see) and an
// `internal_name` (what staff see: admin/employee/accountant/dispatch/ops).
// internal_name is required, but we fall back to name defensively so the UI
// never renders blank if a row predates the migration.

// Customer-facing name — partners must only ever see this.
export const customerProductName = (product) => product?.name || '';

// Internal name — for staff-only screens.
export const staffProductName = (product) =>
  product?.internal_name || product?.name || '';

// Pick the right name for the viewer's role. Used by components shown to
// BOTH partners and staff (e.g. the shared order-details modal).
export function productNameForRole(product, role) {
  if (!product) return '';
  return role === 'partner' ? customerProductName(product) : staffProductName(product);
}

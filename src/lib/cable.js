// src/lib/cable.js — extra-cable pricing.
//
// Some products ship with a sensor cable; the first CABLE_FREE_METERS are
// included free. Anything beyond that is charged per metre, per unit, at
// PO time. These constants are fixed here for now — if the business wants
// per-product control later, lift them onto the product row.

export const CABLE_FREE_METERS = 50;       // metres included free per unit
export const CABLE_RATE_PER_METER = 75;    // ₹ per extra metre

// Charge for a single order line: extra metres (per unit) × quantity × rate.
// extraMetersPerUnit is the partner-entered EXCESS beyond the free length.
export function cableChargeFor(extraMetersPerUnit, qty) {
  const m = Math.max(0, Math.floor(Number(extraMetersPerUnit) || 0));
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  return m * q * CABLE_RATE_PER_METER;
}

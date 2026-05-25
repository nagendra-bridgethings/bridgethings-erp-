// src/lib/tax.js — Sales tax (IGST) helpers.
//
// India-wide rate for B2B inter-state sales. Applied on the items
// subtotal (NOT on shipping — shipping is a service typically charged
// at a different slab, so we keep it out of the IGST base to avoid
// over-charging the partner).

export const IGST_RATE = 0.18;
export const IGST_LABEL = 'IGST (18%)';

// Round to 2dp so the displayed and stored amounts always match the
// invoice math. Without this, totals can drift by a paisa between the
// browser preview and the DB.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Compute the IGST owed on a given items subtotal.
export function computeIgst(itemsSubtotal) {
  return round2((Number(itemsSubtotal) || 0) * IGST_RATE);
}

// Single source of truth for the order grand total.
// total = items_subtotal + shipping + IGST(items_subtotal)
export function computeOrderTotal({ itemsSubtotal = 0, shipping = 0 } = {}) {
  const subtotal = Number(itemsSubtotal) || 0;
  const ship     = Number(shipping)      || 0;
  const tax      = computeIgst(subtotal);
  return {
    subtotal: round2(subtotal),
    shipping: round2(ship),
    tax,
    total:    round2(subtotal + ship + tax),
  };
}

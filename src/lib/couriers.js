// src/lib/couriers.js — Shared courier-partner catalog.
// Hard-coded for now; if you want admins to manage this list later we can
// move it to a `bridgethings_couriers` table. The `name` is what gets stored
// in bridgethings_orders.delivery_method.
// Prices are for bulk B2B shipments — channel partners order in quantity,
// so these reflect typical pallet/crate freight charges, not single-parcel rates.
export const COURIERS = [
  { id: 'india_post', name: 'India Post',      price: 1000 },
  { id: 'delhivery',  name: 'Delhivery',       price: 1500 },
  { id: 'ekart',      name: 'Ekart Logistics', price: 1800 },
  { id: 'dtdc',       name: 'DTDC',            price: 2000 },
  { id: 'gati',       name: 'Gati',            price: 2500 },
  { id: 'bluedart',   name: 'Blue Dart',       price: 3000 },
  { id: 'fedex',      name: 'FedEx',           price: 5000 },
];

// Convenience lookup by stored name (case-insensitive) — used on the invoice
// when we want to look up the price from a saved delivery_method string.
export const findCourierByName = (name) => {
  if (!name) return null;
  const target = name.trim().toLowerCase();
  return COURIERS.find(c => c.name.toLowerCase() === target) || null;
};

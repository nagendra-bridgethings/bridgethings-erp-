// src/lib/orderStepper.js — Shared helper for the order progress stepper.
//
// The visible stepper has 4 positions:
//   1. In Process — driven by fulfillment_status
//   2. Payment    — driven by payment_status (Pending / Received / Paid)
//   3. Shipped    — driven by fulfillment_status
//   4. Delivered  — driven by fulfillment_status
//
// We do NOT have a 'payment' value in the fulfillment_status enum; payment
// is a separate axis. This helper combines the two into a single linear
// stepper for the UI so a partner/admin can see the order's overall state.

// Active fulfillment statuses. The legacy 'ready_to_ship' (manual flag from
// before the per-unit production flow) is collapsed into 'in_process' below.
const FULFILLMENT_STATUSES = ['in_process', 'shipped', 'delivered'];

// Map legacy values onto current ones for backwards compat:
//   'calibration'    — old enum value, never set anymore
//   'ready_to_ship'  — old manual flag, superseded by per-unit production
//                      states + shipment trigger that flips to 'shipped'
const normalizeFulfillment = (ff) => {
  if (ff === 'calibration' || ff === 'ready_to_ship') return 'in_process';
  return ff || 'in_process';
};

const paymentDisplay = (paymentStatus) => {
  if (paymentStatus === 'completed') return { label: 'Paid',     done: true,  active: false };
  if (paymentStatus === 'partial')   return { label: 'Received', done: false, active: true  };
  return { label: 'Pending', done: false, active: false };
};

/**
 * Returns 5 step descriptors for an order's stepper.
 * Each: { key, label, done, active }
 */
export function getOrderStepperSteps(order) {
  const ff = normalizeFulfillment(order.fulfillment_status);
  const ffIdx = FULFILLMENT_STATUSES.indexOf(ff);
  const pay = paymentDisplay(order.payment_status);

  return [
    {
      key: 'in_process',
      label: 'In Process',
      done:   ffIdx > 0,
      active: ffIdx === 0,
    },
    {
      key: 'payment',
      label: pay.label,
      done:   pay.done,
      active: pay.active,
    },
    {
      key: 'shipped',
      label: 'Shipped',
      done:   ffIdx > 1,
      active: ffIdx === 1,
    },
    {
      key: 'delivered',
      label: 'Delivered',
      done:   ffIdx > 2, // never strictly past 'delivered'
      active: ffIdx === 2,
    },
  ];
}


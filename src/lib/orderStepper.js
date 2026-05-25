// src/lib/orderStepper.js — Shared helper for the order progress stepper.
//
// The visible stepper has 5 positions:
//   1. In Process    — driven by fulfillment_status
//   2. Payment       — driven by payment_status (Pending / Received / Paid)
//   3. Ready to Ship — driven by fulfillment_status
//   4. Shipped       — driven by fulfillment_status
//   5. Delivered     — driven by fulfillment_status
//
// We do NOT have a 'payment' value in the fulfillment_status enum; payment
// is a separate axis. This helper combines the two into a single linear
// stepper for the UI so a partner/admin can see the order's overall state.

// The fulfillment statuses we actually use (drop the old 'calibration' value).
const FULFILLMENT_STATUSES = ['in_process', 'ready_to_ship', 'shipped', 'delivered'];

// Old 'calibration' value should be treated as 'in_process' for backwards compat
// with any historical rows.
const normalizeFulfillment = (ff) => (ff === 'calibration' ? 'in_process' : ff || 'in_process');

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
      key: 'ready_to_ship',
      label: 'Ready to Ship',
      done:   ffIdx > 1,
      active: ffIdx === 1,
    },
    {
      key: 'shipped',
      label: 'Shipped',
      done:   ffIdx > 2,
      active: ffIdx === 2,
    },
    {
      key: 'delivered',
      label: 'Delivered',
      done:   ffIdx > 3, // never strictly past 'delivered'
      active: ffIdx === 3,
    },
  ];
}

// Status options for the admin "Update Fulfillment Status" dropdown.
// Note: 'calibration' is intentionally excluded since the visual stepper
// replaces it with Payment.
export const FULFILLMENT_OPTIONS = [
  { value: 'in_process',    label: 'In Process'    },
  { value: 'ready_to_ship', label: 'Ready to Ship' },
  { value: 'shipped',       label: 'Shipped'       },
  { value: 'delivered',     label: 'Delivered'     },
];

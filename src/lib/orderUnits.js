// src/lib/orderUnits.js — Per-unit tracking for order items.
//
// Each row in bridgethings_order_unit_details represents one physical unit
// being shipped (e.g. a single flow meter). When an order_item has qty=11,
// there are 11 unit rows under it.
//
// Employees fill in serial number, SIM, calibration date, and certificate
// URLs for each unit. Partners can read these (read-only) once the order
// is delivered, e.g. for warranty / installation records.

import { supabase } from './supabase';

const TABLE = 'bridgethings_order_unit_details';

// Load all unit details for the given order item ids. Returns a map keyed
// by order_item_id so callers can render units grouped by item.
export async function loadUnitDetailsForItems(itemIds) {
  if (!itemIds?.length) return {};
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .in('order_item_id', itemIds)
    .order('unit_index', { ascending: true });
  if (error) {
    console.error('[orderUnits] load failed:', error);
    return {};
  }
  const map = {};
  for (const row of data || []) {
    if (!map[row.order_item_id]) map[row.order_item_id] = [];
    map[row.order_item_id].push(row);
  }
  return map;
}

// Upsert a unit's details. Keyed by (order_item_id, unit_index) which is
// the table's UNIQUE constraint. Used when an employee saves a unit row.
export async function upsertUnitDetail({
  orderItemId,
  unitIndex,
  deviceType,
  serialNumber,
  sim,
  calibratedOn,
  calibrationCertificateUrl,
  warrantyCertificateUrl,
}) {
  const payload = {
    order_item_id:               orderItemId,
    unit_index:                  unitIndex,
    device_type:                 deviceType?.trim()  || null,
    serial_number:               serialNumber?.trim()|| null,
    sim:                         sim?.trim()         || null,
    calibrated_on:               calibratedOn       || null,
    calibration_certificate_url: calibrationCertificateUrl || null,
    warranty_certificate_url:    warrantyCertificateUrl    || null,
    updated_at:                  new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'order_item_id,unit_index' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

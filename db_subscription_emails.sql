-- ============================================================
-- Bridge Things ERP - Subscription notification templates
-- Run in: Supabase Dashboard > SQL Editor (safe to re-run).
--
-- Re-defines the render function with three new branches (all other
-- branches are byte-identical to the deployed version):
--   sub_payment_submitted  -> accountants, when a partner uploads proof
--   sub_payment_rejected   -> partner, when an accountant rejects the proof
--   sub_request_declined   -> partner, when a request is declined outright
-- ============================================================

CREATE OR REPLACE FUNCTION bridgethings_render_notification(
  p_template   TEXT,
  p_vars       JSONB,
  p_portal_url TEXT,
  OUT v_subject TEXT,
  OUT v_body    TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  -- Convenience locals (NULL-safe).
  ord    TEXT := COALESCE(p_vars->>'orderShortId', '');
  who    TEXT := COALESCE(p_vars->>'partnerName', 'there');
  amt    TEXT := COALESCE(p_vars->>'amount', '');
  bal    TEXT := COALESCE(p_vars->>'balance', '');
  note   TEXT := COALESCE(p_vars->>'notes', '');
  eml    TEXT := COALESCE(p_vars->>'partnerEmail', '');
  url    TEXT := p_portal_url;
  -- " (partner@email)" suffix for staff mails so accounts/admin can see
  -- exactly which partner an internal notification is about.
  who_e  TEXT := COALESCE(p_vars->>'partnerName', 'A partner')
                 || CASE WHEN COALESCE(p_vars->>'partnerEmail','') <> ''
                         THEN ' (' || (p_vars->>'partnerEmail') || ')' ELSE '' END;
BEGIN
  IF p_template = 'po_submitted' THEN
    v_subject := 'New PO ORD-' || ord || ' from ' || who;
    v_body := 'A new purchase order (ORD-' || ord || ') has been submitted by ' || who_e || '.' ||
              E'\n\nReview it here: ' || url || '/admin/po-received';

  ELSIF p_template = 'po_confirmed' THEN
    v_subject := 'Your order ORD-' || ord || ' is confirmed';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nYour purchase order ORD-' || ord || ' has been confirmed.' ||
              CASE WHEN COALESCE(p_vars->>'committedDate','') <> ''
                   THEN E'\nCommitted delivery date: ' || (p_vars->>'committedDate') ELSE '' END ||
              CASE WHEN note <> '' THEN E'\nNote from our team: ' || note ELSE '' END ||
              E'\n\nTrack progress: ' || url || '/partner/orders';

  ELSIF p_template = 'po_rejected' THEN
    v_subject := 'Order ORD-' || ord || ' could not be accepted';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nUnfortunately your purchase order ORD-' || ord || ' was not accepted.' ||
              CASE WHEN note <> '' THEN E'\nReason: ' || note ELSE '' END ||
              E'\n\nView details: ' || url || '/partner/po';

  ELSIF p_template = 'delivery_counter' THEN
    v_subject := 'New delivery date proposed for ORD-' || ord;
    v_body := 'Hi ' || who || ',' ||
              E'\n\nWe have proposed a new delivery date for ORD-' || ord || ': ' ||
              COALESCE(p_vars->>'proposedDate','') || '.' ||
              CASE WHEN note <> '' THEN E'\nNote: ' || note ELSE '' END ||
              E'\n\nAccept or decline it here: ' || url || '/partner/po';

  ELSIF p_template = 'counter_accepted' THEN
    v_subject := who || ' accepted the delivery date for ORD-' || ord;
    v_body := who_e || ' accepted the proposed delivery date for ORD-' || ord ||
              '. The order is now active.' ||
              E'\n\n' || url || '/admin/po-received';

  ELSIF p_template = 'counter_declined' THEN
    v_subject := who || ' declined the delivery date for ORD-' || ord;
    v_body := who_e || ' declined the proposed delivery date for ORD-' || ord ||
              '. The order has been rejected.' ||
              E'\n\n' || url || '/admin/po-received';

  ELSIF p_template = 'payment_submitted' THEN
    v_subject := 'Payment proof submitted for ORD-' || ord ||
                 CASE WHEN amt <> '' THEN ' (Rs ' || amt || ')' ELSE '' END;
    v_body := who_e || ' submitted a payment' ||
              CASE WHEN amt <> '' THEN ' of Rs ' || amt ELSE '' END ||
              ' for ORD-' || ord || ' awaiting verification.' ||
              E'\n\nVerify it here: ' || url || '/finance';

  ELSIF p_template = 'payment_verified' THEN
    v_subject := 'Payment received for ORD-' || ord;
    v_body := 'Hi ' || who || ',' ||
              E'\n\nWe have recorded your payment' ||
              CASE WHEN amt <> '' THEN ' of Rs ' || amt ELSE '' END ||
              ' for ORD-' || ord || '.' ||
              CASE WHEN bal <> '' THEN E'\nOutstanding balance: Rs ' || bal ELSE '' END ||
              E'\n\n' || url || '/partner/orders';

  ELSIF p_template = 'payment_rejected' THEN
    v_subject := 'Action needed: payment for ORD-' || ord;
    v_body := 'Hi ' || who || ',' ||
              E'\n\nThe payment you submitted for ORD-' || ord ||
              ' could not be verified.' ||
              CASE WHEN note <> '' THEN E'\nReason: ' || note ELSE '' END ||
              E'\n\nPlease re-upload from your portal: ' || url || '/partner/orders';

  ELSIF p_template = 'dispatch_approved' THEN
    v_subject := 'ORD-' || ord || ' cleared — production starting';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nGood news — ORD-' || ord ||
              ' has been cleared for dispatch and production will begin shortly.' ||
              E'\n\n' || url || '/partner/orders';

  ELSIF p_template = 'dispatch_rejected' THEN
    v_subject := 'ORD-' || ord || ' on hold — balance due';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nORD-' || ord || ' is on hold pending payment.' ||
              CASE WHEN note <> '' THEN E'\nDetails: ' || note ELSE '' END ||
              E'\n\n' || url || '/partner/orders';

  ELSIF p_template = 'dispatch_pending' THEN
    -- Partial payment verified → order is waiting on the admin to approve
    -- (or reject) dispatch before production can start.
    v_subject := 'ORD-' || ord || ' awaiting your dispatch approval';
    v_body := who_e || ' made a partial payment on ORD-' || ord || '.' ||
              CASE WHEN amt <> '' THEN E'\nPaid so far: Rs ' || amt ELSE '' END ||
              CASE WHEN bal <> '' THEN E'\nOutstanding: Rs ' || bal ELSE '' END ||
              E'\n\nApprove or reject dispatch on your dashboard: ' || url || '/admin';

  ELSIF p_template = 'production_ready' THEN
    v_subject := 'ORD-' || ord || ' ready to produce';
    v_body := 'Payment has cleared for ORD-' || ord || ' (' || who || ').' ||
              ' Units are ready to move into production.' ||
              E'\n\n' || url || '/operations/fulfillment';

  ELSIF p_template = 'units_ready_dispatch' THEN
    v_subject := 'Units ready to verify — ORD-' || ord;
    v_body := 'Operations marked units on ORD-' || ord || ' (' || who || ')' ||
              ' ready to dispatch. Please verify and ship.' ||
              E'\n\n' || url || '/dispatch/fulfillment';

  ELSIF p_template = 'units_sent_back' THEN
    v_subject := 'Units returned by dispatch — ORD-' || ord;
    v_body := 'Dispatch sent units on ORD-' || ord || ' back to operations.' ||
              CASE WHEN note <> '' THEN E'\nReason: ' || note ELSE '' END ||
              E'\n\n' || url || '/operations/fulfillment';

  ELSIF p_template = 'docs_requested' THEN
    v_subject := 'Documents needed for your ORD-' || ord || ' shipment';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nWe need the following document(s) to ship part of ORD-' || ord || ': ' ||
              COALESCE(p_vars->>'docList','the requested documents') || '.' ||
              E'\n\nPlease upload them here: ' || url || '/partner/orders';

  ELSIF p_template = 'docs_submitted' THEN
    v_subject := 'Partner docs received — ORD-' || ord || ' ready to ship';
    v_body := who || ' uploaded all requested documents for an ORD-' || ord ||
              ' shipment. It is ready to ship.' ||
              E'\n\n' || url || '/dispatch/fulfillment';

  ELSIF p_template = 'shipment_dispatched' THEN
    v_subject := 'Your ORD-' || ord || ' has shipped';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA parcel for ORD-' || ord || ' has shipped' ||
              CASE WHEN COALESCE(p_vars->>'courier','') <> ''
                   THEN ' via ' || (p_vars->>'courier') ELSE '' END || '.' ||
              CASE WHEN COALESCE(p_vars->>'tracking','') <> ''
                   THEN E'\nTracking: ' || (p_vars->>'tracking') ELSE '' END ||
              E'\n\nTrack it: ' || url || '/partner/orders';

  ELSIF p_template = 'shipment_delivered' THEN
    v_subject := 'Your ORD-' || ord || ' was delivered';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA parcel for ORD-' || ord || ' has been delivered. Thank you!' ||
              E'\n\n' || url || '/partner/devices';

  ELSIF p_template = 'sub_requested' THEN
    v_subject := 'Subscription request from ' || who;
    v_body := who_e || ' requested dashboard subscriptions for ' ||
              COALESCE(p_vars->>'deviceCount','one or more') || ' device(s).' ||
              ' Approve once payment is received.' ||
              E'\n\n' || url || '/finance/subscriptions';

  ELSIF p_template = 'sub_activated' THEN
    v_subject := 'Your device subscription is active';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA dashboard subscription is now active' ||
              CASE WHEN COALESCE(p_vars->>'productName','') <> ''
                   THEN ' for ' || (p_vars->>'productName') ELSE '' END ||
              CASE WHEN COALESCE(p_vars->>'serial','') <> ''
                   THEN ' (SN ' || (p_vars->>'serial') || ')' ELSE '' END || '.' ||
              E'\n\nView your devices: ' || url || '/partner/devices';

  ELSIF p_template = 'sub_expiring' THEN
    v_subject := 'Your subscription expires in ' || COALESCE(p_vars->>'daysLeft','a few') || ' days';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nYour dashboard subscription' ||
              CASE WHEN COALESCE(p_vars->>'productName','') <> ''
                   THEN ' for ' || (p_vars->>'productName') ELSE '' END ||
              CASE WHEN COALESCE(p_vars->>'serial','') <> ''
                   THEN ' (SN ' || (p_vars->>'serial') || ')' ELSE '' END ||
              ' expires in ' || COALESCE(p_vars->>'daysLeft','a few') || ' days.' ||
              E'\n\nRenew it here: ' || url || '/partner/devices';

  ELSIF p_template = 'sub_cancelled' THEN
    v_subject := 'Your device subscription was cancelled';
    v_body := 'Hi ' || who || ',' ||
              E'\n\nA dashboard subscription has been cancelled.' ||
              ' If this was unexpected, please get in touch.' ||
              E'\n\n' || url || '/partner/devices';

  ELSIF p_template = 'sub_payment_submitted' THEN
    v_subject := 'Subscription payment proof from ' || who;
    v_body := who_e || ' submitted a payment proof for a device subscription' ||
              CASE WHEN COALESCE(p_vars->>'productName','') <> ''
                   THEN ' (' || (p_vars->>'productName') || ')' ELSE '' END ||
              CASE WHEN amt <> '' THEN E'
Amount: Rs ' || amt ELSE '' END ||
              E'

Review the slip and verify it here: ' || url || '/finance/subscriptions';

  ELSIF p_template = 'sub_payment_rejected' THEN
    v_subject := 'Your subscription payment needs another look';
    v_body := 'Hi ' || who || ',' ||
              E'

We could not verify the payment proof you submitted for your device subscription' ||
              CASE WHEN COALESCE(p_vars->>'productName','') <> ''
                   THEN ' for ' || (p_vars->>'productName') ELSE '' END || '.' ||
              CASE WHEN note <> '' THEN E'

Reason: ' || note ELSE '' END ||
              E'

Please re-upload a correct payment slip from My Devices: ' || url || '/partner/devices';

  ELSIF p_template = 'sub_request_declined' THEN
    v_subject := 'Your subscription request was declined';
    v_body := 'Hi ' || who || ',' ||
              E'

Your request for a device subscription was not approved' ||
              CASE WHEN note <> '' THEN E'.

Reason: ' || note ELSE '.' END ||
              E'

You can submit a new request any time from My Devices: ' || url || '/partner/devices';

  ELSE
    RAISE EXCEPTION 'Unknown notification template: %', p_template;
  END IF;
END;
$$;

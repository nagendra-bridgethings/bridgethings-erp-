# Email Notifications — Setup & Reference

End-to-end email notifications for the Bridge Things ERP order/payment/
fulfillment/subscription lifecycle. Each business event emails the
**relevant party** (partner, admins, accountants, operations, or
dispatch).

## How it works

We do **not** send email ourselves. For each event the app POSTs a JSON
`{ subject, body, receiver, sender }` to the **company relay API** (the
one your manager provides); his side sends the actual email. `sender` is
always `noreply@bridgethings.com`.

```
React mutation (confirmOrder, verifyPayment, …)
  └─ notify(template, recipient, vars)            src/lib/notify.js
       └─ rpc bridgethings_send_notification(…)   auth-gate + resolve recipients
            └─ bridgethings__deliver_email(…)     render → audit → net.http_post → relay
                 └─ bridgethings_notifications     audit log (queued/sent/failed/skipped)
```

Self-hosted Supabase makes Edge Functions painful, so the transport is
pure SQL via the **`pg_net`** extension — created/updated from the SQL
editor, no CLI/SSH needed.

**Notifications never break business actions.** `notify()` is fire-and-
forget and swallows its own errors; a failed email still leaves the PO
confirmed / payment verified. Every attempt is logged in
`bridgethings_notifications`.

## Deploy

1. Run **`sql/notifications.sql`** once in the Supabase SQL editor. This
   creates: `bridgethings_app_secrets`, `bridgethings_notifications`
   (+RLS), the role→email resolver, the renderer, the dispatcher, and the
   daily pg_cron expiry job.
2. The frontend wiring is already in `src/lib/*` — nothing to deploy
   beyond the normal app build.

**Until the relay is configured, every send logs as `skipped`** — so
this is safe to deploy before the API exists. Nothing reaches a real
inbox yet.

## Go live (configure the relay)

Once the manager sends his API details, run in the SQL editor:

```sql
INSERT INTO bridgethings_app_secrets (key, value) VALUES
  ('notify_api_url', 'https://HIS-RELAY/endpoint'),
  ('notify_api_key', 'the-key-he-gives-you'),
  ('notify_from',    'noreply@bridgethings.com'),
  ('portal_url',     'https://nagendra-bridgethings.github.io/bridgethings-erp-')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
```

If his contract differs from `{ subject, body, receiver, sender }` or
uses a different auth header, edit **one block**: the
`>>> THE ONE BLOCK TO EDIT <<<` section inside
`bridgethings__deliver_email` in `sql/notifications.sql` (the
`net.http_post` headers + body), then re-run that function definition.

### The 7 things to confirm with the manager
1. Endpoint URL  2. Auth header (name + token)  3. Exact JSON field names
4. Can `receiver` be a list, or one request per address?  5. Does `body`
render HTML or plain text?  6. Do we send `sender`, or does he hardcode
it?  7. Response shape on success/failure.

(Current code: POSTs one request per recipient, `Authorization: Bearer
<key>`, plain-text body. Swap to HTML by replacing the body strings in
`bridgethings_render_notification`.)

## Catalog (22 templates + 1 cron)

| Recipient | Templates |
|---|---|
| **Partner** | po_confirmed, po_rejected, delivery_counter, payment_verified, payment_rejected, dispatch_approved, dispatch_rejected, docs_requested, shipment_dispatched, shipment_delivered, sub_activated, sub_expiring, sub_cancelled |
| **Admins** | po_submitted, counter_accepted, counter_declined |
| **Accountants** | payment_submitted, sub_requested |
| **Operations** | production_ready, units_sent_back |
| **Dispatch** | units_ready_dispatch, docs_submitted |

Role groups resolve from the role tables. **Operations/Dispatch** =
`bridgethings_employees WHERE team = 'operations' | 'dispatch'`;
employees with `team IS NULL` are excluded (assign a team to receive
mail).

## Verify / debug

```sql
-- Recent sends and their status:
SELECT created_at, template, recipient_email, recipient_role, status, error
FROM bridgethings_notifications ORDER BY created_at DESC LIMIT 50;

-- pg_net responses (for 'sent' rows, provider_msg_id is the request id):
SELECT * FROM net._http_response ORDER BY created DESC LIMIT 20;

-- Dry-run the expiry sweep manually:
SELECT bridgethings_notify_expiring_subscriptions();
```

Status meanings: `skipped` = relay not configured yet · `queued` =
inserted, POST not yet confirmed · `sent` = POST fired · `failed` = error
(see `error` column).

## Notes

- **pg_cron**: if `CREATE EXTENSION pg_cron` isn't available on the
  self-hosted instance, the expiry job won't auto-schedule — call
  `SELECT bridgethings_notify_expiring_subscriptions();` daily from any
  external scheduler instead. Everything else works without pg_cron.
- **Security**: any signed-in user can call the dispatcher (it only
  builds an email), matching the original design. The relay should rate-
  limit. `bridgethings__deliver_email` is internal (not granted to
  anon/authenticated).
- **Adding a template**: add an `ELSIF` branch in
  `bridgethings_render_notification`, then a `notify('your_template', …)`
  call at the relevant mutation in `src/lib/*`.

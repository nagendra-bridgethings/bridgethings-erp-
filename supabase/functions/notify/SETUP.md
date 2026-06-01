# Email Notifications — Setup

Three things to do once. After that, every new notification is just
"add a template + one line in React".

---

## 1. Run the SQL migration

In Supabase SQL editor, paste and run `sql/notifications.sql`. This
creates the `bridgethings_notifications` audit table and its RLS
policies. Verify with:

```sql
SELECT * FROM bridgethings_notifications LIMIT 1;
```

---

## 2. Set up Resend

1. Sign up at https://resend.com.
2. **Add your domain** under *Domains* (e.g. `bridgethings.com`).
3. Add the three DNS records Resend shows you (SPF, DKIM, DMARC) at
   your domain registrar. Wait for them to verify (usually <1 hour).
4. Under *API Keys*, create a key named `bridgethings-prod`. Copy the
   `re_xxxxxxxx` string — you only see it once.

> For initial testing you can skip the domain and send from Resend's
> sandbox sender `onboarding@resend.dev`. Real emails to your own
> verified address only.

---

## 3. Deploy the Edge Function

Install the Supabase CLI if you don't have it:

```powershell
npm install -g supabase
```

Log in and link the project (one-time):

```powershell
supabase login
supabase link --project-ref <your-project-ref>
```

Set the three secrets the function needs:

```powershell
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxxxxxx
supabase secrets set NOTIFY_FROM="Bridge Things <orders@bridgethings.com>"
supabase secrets set PORTAL_URL=https://app.bridgethings.com
```

(For local dev `PORTAL_URL` can be `http://localhost:5174/bridgethings-erp-`.)

Deploy:

```powershell
supabase functions deploy notify
```

---

## 4. Test end-to-end

1. Open the app as **admin**.
2. Open a partner PO that's `pending_approval` and confirm it.
3. Within ~2 seconds, the partner's inbox should receive
   *"Order ORD-XXXXXXXX confirmed"*.
4. In Supabase SQL editor run:

   ```sql
   SELECT created_at, template, recipient_email, status, error
   FROM bridgethings_notifications
   ORDER BY created_at DESC LIMIT 5;
   ```

   You should see `status = 'sent'`. If `status = 'failed'`, the
   `error` column tells you why (most common: domain not verified yet,
   or sandbox sender used with a non-owner recipient).

---

## Adding a new notification later

1. Add a template in `supabase/functions/notify/index.ts` under
   `templates = { ... }`.
2. Re-deploy: `supabase functions deploy notify`.
3. Call `notify('your_template', recipient, vars, opts)` from React
   wherever the event happens.

That's it — no migrations, no DB changes per template.

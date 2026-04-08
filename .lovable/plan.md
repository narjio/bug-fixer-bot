
Deep check result

I found 4 real causes behind what you are seeing:

1. The inbox is not actually empty in the backend
- `cached_emails` already contains 60 emails.
- But all current rows have `account_label = null`.
- The user shown in your setup (`Admin Test`) is restricted to `assigned_accounts = ["Primary"]`.
- So the viewer filters for `Primary`, finds only `null`, and shows `0`.

2. Updating only the email backend function is not enough
- I do not see recent `fetch-emails` calls hitting this backend now.
- That strongly suggests your broken live app is still going through the external frontend/worker path.
- So changing only the backend function can still leave the live app behaving the same.

3. Admin “view as user” has a route-guard race
- In `loginAsUser()`, the app swaps auth state while still sitting on `/admin/dashboard`.
- The admin route guard then sees a non-admin user and redirects to `/` before `/viewer` fully opens.
- That is why clicking a user can dump you back to login instead of opening webmail directly.

4. CAPTCHA OFF is fragile right now
- The app treats “siteKey exists” as the ON/OFF switch.
- Your backend settings currently still contain both CAPTCHA keys, so OFF is not sticking reliably.
- The current setup is also too loose because login pages read the raw recaptcha settings object directly.

Implementation plan

1. Fix the empty inbox for restricted users
- Update the email cache filtering so legacy rows with `account_label = null` are treated as `Primary`.
- Add an automatic repair step so existing unlabeled cached rows get normalized instead of staying invisible forever.
- Keep all future syncs writing `account_label: "Primary"` consistently for the primary inbox.

2. Fix the worker path so failures stop looking like “0 emails”
- In `cloudflare-worker/worker.js`, stop returning `[]` when the backend refresh fails.
- Return the real upstream error and status for both `/api/emails` and `/api/emails/sync`.
- Forward the real signed session token through the worker instead of rebuilding/smuggling partial session data.

3. Make primary worker resolution real
- Right now there is no real database-driven worker setting for the primary inbox path, so the app falls back to the environment worker URL.
- I will make the worker resolution order explicit:
  - assigned account worker URL
  - primary worker URL from settings
  - env fallback
- I will also remove misleading “Default (built-in)” text.

4. Fix admin impersonation navigation
- Make “view as user” navigation atomic so the admin guard cannot bounce the app to `/`.
- Preserve admin backup state, move to `/viewer`, then refresh auth from the viewer side.
- Keep “Back to Admin” working exactly as now.

5. Fix CAPTCHA toggle from admin
- Replace the current implicit logic with an explicit `enabled` flag in settings.
- OFF will no longer depend on blanking keys.
- After every toggle, re-read the saved settings from the backend and update the UI from the real stored value.
- Login pages will only show CAPTCHA when `enabled === true` and a site key exists.

Files in scope
- `src/App.tsx`
- `cloudflare-worker/worker.js`
- `supabase/functions/fetch-emails/index.ts`
- `supabase/functions/manage-app/index.ts` only if I centralize settings normalization there

Database
- No new tables are needed.
- No schema redesign is needed.
- Only a safe repair/normalization of existing cached email labels is needed so already-cached mail becomes visible to `Primary` users.

Expected result
- Users assigned to `Primary` will see the emails that are already in the database.
- Clicking a user from admin will open webmail directly instead of bouncing to login.
- Turning CAPTCHA off in admin will actually disable it everywhere.
- Your live external app will stop hiding worker/backend failures behind an empty inbox.

Technical details
```text
Current:
cached emails exist -> labels are null -> Primary users see 0
admin impersonation changes auth on /admin route -> guard redirects to /
worker refresh fails -> returns [] -> looks like empty inbox
captcha ON/OFF inferred from siteKey -> toggle is unreliable

Target:
legacy null labels become visible as Primary
impersonation opens /viewer without admin-guard bounce
worker returns real errors instead of []
captcha uses explicit enabled state
```

Important deployment note
- Because your broken app is an external deployment, this fix must be redeployed in all relevant layers together:
  - frontend bundle
  - worker
  - backend functions
- Updating only `fetch-emails` will not fully fix the live behavior.


Revised plan: app-wide error handling cleanup

What I found
- The issue is global, not page-specific.
- In `src/App.tsx`, the shared `apiCall()` helper catches both JSON parsing errors and real backend errors in the same `try/catch`, so valid backend messages get replaced with `Something went wrong. Please try again.`
- That helper is used across most of the app: login, admin auth, OTP, settings, user management, impersonation, and password changes.
- There are 3 more masking layers:
  1. `server.ts` replaces upstream failures with generic messages like `Request failed`
  2. `cloudflare-worker/worker.js` `/api/emails/sync` ignores upstream failures and can still return success
  3. Multiple UI handlers in `src/App.tsx` use `catch {}` or hardcoded `toast.error("Failed...")`, so the real error gets lost again
- Static connection fallbacks are still present:
  - hardcoded backend URL/key in `src/App.tsx` and `server.ts`
  - obfuscated built-in Cloudflare Worker URL in `src/App.tsx`
  - saved worker URLs are shown in the admin panel, but current runtime logic still prefers the built-in worker path

What I will build
1. Fix the shared frontend request layer
- Rewrite `apiCall()` so it safely parses JSON without swallowing real backend errors
- Throw structured errors with real `message`, `status`, and optional `code/details`
- Only use a generic fallback when the response is empty or non-JSON
- Apply the same logic to direct email fetch/sync requests, so the email viewer also shows real failures

2. Fix proxy and worker pass-through
- Update `server.ts` to preserve upstream HTTP status and JSON error payloads instead of replacing them
- Update `cloudflare-worker/worker.js` so `/api/emails` and `/api/emails/sync` return the real upstream error body/status
- Stop returning fake success when sync actually failed

3. Clean up UI-wide error surfacing
- Replace hardcoded generic toasts/messages in user-triggered actions with real backend messages:
  - profile login
  - admin login + admin OTP
  - forced password set + normal password change
  - create/delete user
  - settings save
  - email account add/remove
  - user account assignment
  - impersonation
  - email sync/fetch
- Keep silent handling only for truly optional background actions like login notifications

4. Remove misleading static fallbacks
- Remove hardcoded backend URL/key fallback from `src/App.tsx` and `server.ts`
- Remove the obfuscated default Cloudflare Worker URL
- Make worker/backend resolution use explicit config only
- If required config is missing, show a clear setup error instead of talking to an old project

5. Normalize backend error responses
- Standardize edge function responses to always return JSON like:
  - `{ success: false, error, code?, details? }`
- Keep raw provider errors in logs, but return safe user-facing messages for:
  - Telegram misconfiguration or Telegram API rejection
  - IMAP auth/connect problems
  - missing backend config/secrets
  - invalid or expired session
- Improve email fetch diagnostics so the admin can see which server/account failed without exposing secret values

6. Verify all affected flows
- Test every user-triggered flow that currently depends on `apiCall()` or direct fetch:
  - wrong login password
  - admin OTP failure
  - forced password change
  - normal password change
  - config save failure
  - IMAP sync failure
  - missing/misconfigured worker URL
  - missing backend config in external deployment
- Confirm the UI now shows the real reason instead of `Something went wrong`

Technical details
```text
Before:
UI -> apiCall/direct fetch -> generic catch/fake success -> "Something went wrong"

After:
UI -> normalized request helper -> proxy/worker pass-through -> edge function JSON error
   -> exact safe message in modal/toast/panel
```

Files in scope
- `src/App.tsx`
- `server.ts`
- `cloudflare-worker/worker.js`
- `supabase/functions/manage-app/index.ts`
- `supabase/functions/fetch-emails/index.ts`
- `supabase/functions/send-login-notification/index.ts`
- `supabase/functions/send-telegram-otp/index.ts`

Database
- No database migration needed for this fix.

Expected result
- The fix will be app-wide, not only for the password modal.
- Generic `Something went wrong` masking will be removed from the main request path.
- Email sync/worker/proxy failures will stop pretending they succeeded.
- External/manual deployments will fail clearly when configuration is wrong, instead of silently using old static values.

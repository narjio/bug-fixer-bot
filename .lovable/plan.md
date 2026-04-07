
Goal

- Inbox ko actually working banana using the uploaded ZIP’s working logic as the base.
- Behavior same rakhna where possible, but insecure parts fix karna.
- Password reset emails hidden hi rahenge.

What I found

- Current viewer UI is not the main problem. `src/App.tsx` already renders any email array it receives.
- Real mismatch: admin panel saves IMAP / Telegram / reCAPTCHA in `app_settings`, but runtime functions (`fetch-emails`, `send-telegram-otp`, `send-login-notification`) read only backend secrets. So admin panel me credentials save karne se live inbox change hi nahi hota.
- Edge logs show IMAP connect ho raha hai and emails collect bhi ho rahe hain, so root issue likely wiring / source-of-truth / mailbox logic hai, not basic connection.
- Current backend has serious vulnerabilities:
  - `manage-app` has no real auth check for sensitive actions
  - `app_users` public read exposes sensitive columns
  - `app_settings` public read can expose secret values
  - admin protection trusts `localStorage`, and 2FA state is not actually enforced on protected admin actions

Plan

1. Review and transplant the ZIP logic
- First implementation step will be to extract the uploaded ZIP and compare its `server.ts` and `src/App.tsx` line-by-line with the current app.
- I’ll copy the reference inbox/request logic as closely as possible instead of continuing partial fixes.

2. Fix the config source-of-truth
- Remove the broken split where admin panel stores credentials in one place but email functions read another.
- Use one secure backend source only for IMAP/Telegram runtime config.
- Admin panel should update the same source the live inbox actually uses.

3. Replace the email fetch flow with the ZIP behavior
- Match the ZIP request path, response shape, and inbox loading flow as closely as possible.
- Keep Gmail-style display.
- Keep only one email exclusion rule: password reset emails hidden; normal Netflix and OTP mails visible.

4. Secure the copied logic before shipping
- Keep the reference behavior, but not its vulnerabilities.
- Lock admin-only actions behind real backend validation.
- Split public profile listing from admin mutations.
- Stop exposing password hashes, TOTP secrets, IMAP password, Telegram tokens, and secret keys to the client.

5. Fix admin auth properly
- Keep Netflix-style profile selection for users.
- Make admin panel require actual verified admin state, not just `localStorage`.
- Ensure second-factor completion is enforced before admin access.

6. Tighten the inbox logic
- Apply the ZIP’s logic, then preserve the good parts of the current mailbox handling:
  - recent-mail scanning only
  - no massive full-mailbox scan
  - optional fallback mailbox handling if Netflix mail is not in INBOX
- Differentiate “no matching emails” vs “mailbox/config error”.

7. Align preview and deployed behavior
- Make preview and Vercel use the same effective backend flow so live site cannot stay on stale/broken logic.
- Remove duplicate or conflicting fetch paths.

Validation

- Admin-saved mail config immediately affects the real inbox logic.
- Netflix / normal recent emails show in the inbox.
- Password reset emails stay hidden.
- Admin panel remains usable.
- Sensitive backend data is no longer publicly readable.

Technical details

- Main files likely involved: `src/App.tsx`, `server.ts`, `supabase/functions/fetch-emails/index.ts`, `supabase/functions/manage-app/index.ts`, plus a migration to fix database access.
- Biggest issue is not mobile UI now; it is broken runtime wiring plus backend security exposure.
- I can already see the ZIP contains the same key files, so in implementation mode I should transplant from those exact files first, then harden the weak parts.



## Fix: Emails Not Displaying on Frontend

### What's Confirmed Working
- Backend edge function returns **5 Netflix emails** successfully (just tested — 200 OK)
- Password reset emails ("Complete your password reset request") are correctly hidden
- Netflix OTP emails ("Netflix: your sign-in code", "temporary access code") ARE included
- Filter is correct: only `info@account.netflix.com` emails, password resets excluded

### Root Cause
The frontend `fetchEmails()` function calls the edge function correctly, but:
1. The edge function takes **8-12 seconds** to respond (IMAP connection + parsing)
2. The response may be getting silently dropped or the function may hit the edge runtime's **30s wall clock limit** on slower calls
3. The `signal: controller.signal` passes `AbortController` but the `body` is missing — the edge function expects a POST but receives no body, which could cause issues on some runtimes

### Plan

1. **Fix the fetch call** — Add `body: JSON.stringify({})` to the POST request so it's a valid POST with content. Some edge runtimes reject bodyless POSTs or behave unexpectedly.

2. **Add the apikey header** — Current code only sends `Authorization: Bearer <key>` but the edge function also needs `apikey` header for Supabase gateway routing. Without it, the request may be rejected silently by the Supabase gateway before reaching the function.

3. **Add visible debug state** — Show the actual response status and any error message directly in the UI (temporarily) so we can see what's happening on the user's device instead of guessing.

4. **Increase timeout to 30s** — Current 25s timeout is too close to the edge function's own processing time. Increase to 30s.

5. **Password reset filter stays exactly as-is** — Only emails with subjects containing "reset your password", "forgot password", "password reset", "change your password", or "password change" are hidden. Everything else from Netflix shows.

### Files to Change
- `src/App.tsx` — Fix `fetchEmails()` function (lines 875-882): add body, apikey header, increase timeout, add debug output

### Technical Details
- The `apikey` header is required by Supabase Edge Function gateway alongside the `Authorization` header
- Current code at line 880: `headers: { "Content-Type": "application/json", "Authorization": \`Bearer ${getApiKey()}\` }`
- Needs to become: `headers: { "Content-Type": "application/json", "Authorization": \`Bearer ${getApiKey()}\`, "apikey": getApiKey() }`
- Add `body: JSON.stringify({})` to the fetch options


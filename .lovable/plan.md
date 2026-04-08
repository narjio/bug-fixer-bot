
## Plan: Remove the Telegram breakage introduced by the recent security changes

### What is actually broken
The Telegram step is failing because the app now sends `X-Session-Token` on every authenticated function call, but these Telegram-related functions still use the old CORS config:

- `supabase/functions/send-telegram-otp/index.ts`
- `supabase/functions/send-login-notification/index.ts`

They do not allow `x-session-token` in `Access-Control-Allow-Headers`, so the browser preflight fails and you see a network error before the function even runs.

This is why it feels like “unwanted things” were added: the security change was applied globally, but these two functions were not updated to match it.

### Fixes I will make

#### 1. Fix CORS on both Telegram-related functions
Update both functions so they accept the same headers the frontend now sends, including:
- `authorization`
- `apikey`
- `content-type`
- `x-client-info`
- `x-session-token`

This should remove the immediate browser-level NetworkError.

#### 2. Stop doing OTP in two separate client-side calls
Right now the admin OTP flow does this from the browser:
1. `manage-app` → create OTP in DB
2. `send-telegram-otp` → send OTP to Telegram

That split is fragile. I’ll change the flow so the server handles OTP creation + Telegram send together in one backend action. That means:
- frontend makes one call only
- backend creates OTP
- backend sends it to Telegram
- if Telegram fails, the flow returns a real error instead of leaving partial state

#### 3. Keep login notification independent but compatible
`send-login-notification` is also affected by the same header/CORS mismatch, so I’ll patch it too. That prevents silent failures after login.

#### 4. Improve the admin OTP error message
Instead of a vague network failure, the UI should show a clearer message like:
- Telegram not configured
- Failed to send Telegram message
- OTP request failed

This will make future debugging much easier.

### Files to update
- `supabase/functions/send-telegram-otp/index.ts`
- `supabase/functions/send-login-notification/index.ts`
- `supabase/functions/manage-app/index.ts`
- `src/App.tsx`

### Expected result after fix
- Admin login no longer fails at the Telegram step with a browser NetworkError
- OTP generation and Telegram sending happen in one safe backend action
- Login notifications keep working
- No need to remove the security model; just make these Telegram functions compatible with it

### Cloudflare note
This Telegram issue is not caused by Cloudflare Worker config. It is happening on the direct backend function call path, so fixing the function headers/backend flow is the right fix.

### Technical details
```text
Current broken flow:
Browser
  -> manage-app/create_otp  (works)
  -> send-telegram-otp      (preflight fails because x-session-token not allowed)

Fixed flow:
Browser
  -> manage-app/request_admin_otp
       -> create OTP
       -> send Telegram message
       -> return success/error
```

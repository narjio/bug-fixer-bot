

## Plan: Security Hardening + Admin Panel Features

### Architecture Overview

The system currently has these vulnerabilities:
1. Frontend localStorage controls all access (role, assigned accounts)
2. Cloudflare Worker endpoints are publicly accessible with no auth
3. `manage-app` edge function accepts any action without verifying caller identity
4. IMAP credentials stored as plain JSON in `app_settings`

### Changes

---

#### 1. Server-Side Session Tokens (Core Security Fix)

**New edge function: `supabase/functions/session/index.ts`**
- On successful login, `manage-app` generates a signed session token (HMAC-SHA256 using `SUPABASE_SERVICE_ROLE_KEY` as secret)
- Token contains: `{ userId, role, assignedAccounts, exp }` (30-minute expiry)
- Frontend stores token in localStorage alongside user data
- All subsequent API calls include `X-Session-Token` header

**File: `supabase/functions/manage-app/index.ts`**
- Login action returns a signed session token
- All admin-only actions (`create`, `delete`, `change_password`, `set_settings`, `list`) verify session token and check `role === "admin"`
- User actions (`change_password` for self) verify token matches user ID
- New helper: `verifySessionToken(token, secret)` — validates HMAC signature and expiry

**File: `src/App.tsx`**
- `apiCall()` automatically attaches `X-Session-Token` header from localStorage
- Remove all frontend trust: role checks, assigned_accounts from localStorage are only for UI display
- All access decisions made server-side

---

#### 2. Secure Cloudflare Worker Authentication

**File: `cloudflare-worker/worker.js`**
- Require `Authorization: Bearer <session_token>` on all endpoints
- Worker validates token signature using a shared secret (new env var: `SESSION_SECRET`)
- Extract `assignedAccounts` from token, pass to Supabase fetch-emails as filter
- Reject requests without valid token (401)
- Add rate limiting: max 30 requests/minute per IP using KV counter
- Add request timestamp validation (reject requests older than 60 seconds)

**New Cloudflare Worker env var needed: `SESSION_SECRET`** (same value as used in edge function)

---

#### 3. Per-User IMAP Account Assignment (Server-Enforced)

**Database migration:** Add `assigned_accounts` (jsonb, nullable) to `app_users`

**File: `supabase/functions/manage-app/index.ts`**
- `create` action accepts `assigned_accounts` array
- `list` action returns `assigned_accounts` for each user
- New `update_user` action to edit assignments
- Login response includes `assignedAccounts` in session token (server-enforced)

**File: `supabase/functions/fetch-emails/index.ts`**
- Cache mode: accept `account_labels` parameter, filter by `account_label` column
- Ignore any client-provided filters — extract from session token instead
- Validate session token in fetch-emails as well

**File: `src/App.tsx` — Admin Panel, Users tab**
- Create User form: multi-select checkboxes for available IMAP accounts
- User list: show assigned accounts per user, allow editing
- Email Accounts tab: add `cloudflareUrl` field per account

**File: `src/App.tsx` — EmailViewer**
- Fetch from per-account Cloudflare Worker URLs based on user's assigned accounts
- Merge results from multiple workers

---

#### 4. Fix Admin "Login as User"

**File: `src/App.tsx`**
- `loginAsUser()`: backup admin session to `admin_backup` in localStorage, set user with role "user"
- `ProtectedRoute`: when role is "user" and `admin_backup` exists, allow access (admin impersonation)
- EmailViewer header: show "Back to Admin" button when `admin_backup` exists
- Clicking "Back to Admin" restores admin session and navigates to `/admin/dashboard`

**File: `supabase/functions/manage-app/index.ts`**
- New action: `impersonate` — admin provides their session token + target user ID
- Returns a new session token with target user's data but flagged as `impersonated: true`
- Logged as audit event

---

#### 5. Password Reset Email Toggle

**File: `src/App.tsx` — Security tab**
- Add toggle: "Show Password Reset Emails" (default: OFF, current behavior)
- Stored in `email_filters`: `{ showSignInCodes: bool, showPasswordResets: bool }`

**File: `supabase/functions/fetch-emails/index.ts`**
- Read `showPasswordResets` from settings
- When toggle is ON, allow password reset emails through (currently always filtered)

---

#### 6. IMAP Credential Encryption

**File: `supabase/functions/manage-app/index.ts`**
- When saving email accounts (`set_settings` key `email_accounts`), encrypt passwords using AES-256-GCM with `SUPABASE_SERVICE_ROLE_KEY` derived key
- When reading, decrypt only server-side
- Frontend never receives raw IMAP passwords (show masked `••••••••`)

**File: `supabase/functions/fetch-emails/index.ts`**
- Decrypt IMAP passwords before connecting

---

#### 7. Audit Logging

**Database migration:** Create `audit_logs` table:
- `id` (uuid), `action` (text), `actor_id` (uuid), `target_id` (uuid nullable), `details` (jsonb), `ip` (text), `created_at` (timestamptz)

**File: `supabase/functions/manage-app/index.ts`**
- Log: user creation, deletion, password changes, settings changes, impersonation, login attempts

---

#### 8. Settings Pre-fill Fix

**File: `src/App.tsx`**
- Config fetch already works — add fallback hint text "No saved config yet — save once to persist"
- Ensure `config.value` properly spreads into `serverConfig` state

---

### Files to Edit
1. `src/App.tsx` — Session token in API calls, per-user assignment UI, login-as-user fix, password reset toggle, CF URL per account
2. `supabase/functions/manage-app/index.ts` — Session tokens, admin verification, assigned_accounts CRUD, IMAP encryption, audit logging, impersonation
3. `supabase/functions/fetch-emails/index.ts` — Session validation, account-label filtering, toggleable password reset, IMAP password decryption
4. `cloudflare-worker/worker.js` — Token validation, rate limiting, per-user account filtering
5. **Database migrations** — `assigned_accounts` on `app_users`, `audit_logs` table

### Security Outcome
- Zero frontend trust — all access verified server-side via signed session tokens
- Cloudflare Workers reject unauthenticated requests
- IMAP credentials encrypted at rest
- Admin impersonation tracked via audit logs
- Rate limiting at Worker level prevents abuse
- Replay attacks prevented via token expiry + timestamp validation


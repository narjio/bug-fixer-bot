

## Plan: Scrollable Email Container + Egress Check

### Egress Status
The code is correctly set up — zero Supabase egress for normal usage:
- `loadCachedEmails()` (every 10s) → Cloudflare Worker → KV cache (FREE)
- `syncFromImap()` (manual refresh only) → Cloudflare Worker → Supabase Edge Function (only 1 call, not per-user)
- Direct Supabase calls only happen if Cloudflare Worker URL is missing (it's hardcoded, so never triggers)
- **Other API calls** (login, manage-app, send-telegram-otp, send-login-notification) still hit Supabase directly, but these are infrequent (only on login/admin actions), so egress is negligible.

**Verdict: Email polling causes ZERO Supabase egress. You're good.**

### Scrollable Container Fix

**Problem:** Email list and content both scroll the entire page. On mobile, you scroll the whole page to see more emails.

**Fix:** Make the EmailViewer use a full-viewport layout with two scrollable panels:
- Left panel (inbox list): Fixed height with `overflow-y: auto` — scrolls independently
- Right panel (email content): Already has `overflow-auto`, just needs proper height constraint

### Changes to `src/App.tsx` (EmailViewer component only)

1. **Outer layout**: Change `<main>` from normal flow to a flex container that fills remaining viewport height (`h-[calc(100vh-3.5rem)]` on mobile, `h-[calc(100vh-4rem)]` on desktop) with `overflow-hidden`

2. **Email list section** (lines 1048-1104): Wrap the email buttons in a scrollable container with `flex-1 overflow-y-auto` so emails scroll within the panel, not the page

3. **Grid columns**: Both columns get `overflow-hidden flex flex-col` so their children can scroll independently

4. **Status card** stays pinned at top of left panel, email list scrolls below it

### Files to Edit
- `src/App.tsx` — EmailViewer return JSX (lines 1007-1250), restructure layout to scrollable containers


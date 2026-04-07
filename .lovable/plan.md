

## Fix Plan: Refresh Button, Email Fetching, and Mobile View

### Problems Identified

1. **Refresh button spins non-stop** — The `syncing` state keeps the RefreshCw icon in `animate-spin` and the button disabled. During background IMAP sync (takes 20+ seconds), user cannot manually refresh or even see the button is clickable.

2. **New incoming emails not fetched** — Auto-refresh calls `syncFromImap()` which takes 20+ seconds, often hitting the 22s internal timeout. The edge function gets killed before completing.

3. **Not all last 1 month emails showing** — Only scanning last 200 messages out of 94,459. With that mailbox size, 200 messages might only cover 1-2 days. Need to scan more or use IMAP SEARCH to find Netflix emails specifically.

4. **Email HTML view on mobile is glitchy** — Netflix HTML emails have fixed-width tables that break on small screens.

### What's Actually Working
- Backend WORKS: 12 Netflix emails are cached in the database right now
- Cache mode returns instantly (35ms boot + instant DB read)
- Password reset emails are correctly filtered out

### Plan

**1. Fix refresh button UX**
- Separate the spinning icon from the manual refresh button
- Manual refresh = instantly load from cache (no spin needed, it's instant)
- Show a small "Syncing..." indicator separately, NOT on the refresh button
- Refresh button should NEVER be disabled — it always loads from cache instantly

**2. Fix IMAP scan range for 1 month coverage**
- Replace the fixed `last 200 messages` scan with IMAP `SEARCH` command: `SEARCH FROM "info@account.netflix.com" SINCE <30 days ago>`
- This searches the entire mailbox server-side and returns only Netflix message UIDs — much faster than scanning 200 envelopes manually
- Falls back to last 500 messages if SEARCH isn't supported

**3. Fix auto-refresh to not block UI**
- Auto-refresh (every 30s) should ONLY call `loadCachedEmails()` (instant DB read)
- IMAP sync should happen less frequently (every 2 minutes) and completely in background
- Manual refresh triggers both: instant cache load + background IMAP sync

**4. Improve mobile email view**
- Force Netflix HTML content into a responsive container with `overflow-x: auto` and `max-width: 100vw`
- Scale down Netflix HTML tables using CSS `transform: scale()` on very small screens
- Add proper padding and font sizing for mobile
- Fix the email detail header (from/date) to wrap properly on small screens

### Files to Change

- `src/App.tsx` — EmailViewer component: fix refresh button, auto-refresh logic, mobile email CSS
- `supabase/functions/fetch-emails/index.ts` — Use IMAP SEARCH for Netflix emails, increase coverage to 1 month

### Technical Details

Edge function change:
```
// Instead of scanning last 200 envelopes:
const startSeq = Math.max(1, totalMessages - 199);

// Use IMAP SEARCH (server-side, fast):
const since = new Date();
since.setDate(since.getDate() - 30);
const results = await client.search({ from: "info@account.netflix.com", since });
```

Frontend refresh logic:
- `fetchEmails()` (manual) → `loadCachedEmails()` instantly, then `syncFromImap()` silently
- Auto-refresh every 30s → `loadCachedEmails()` ONLY (instant)
- IMAP sync → triggered on mount, on manual refresh, and every 2 minutes
- Refresh button NEVER spins or disables — cache reads are instant


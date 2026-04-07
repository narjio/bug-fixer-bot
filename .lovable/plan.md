

## Fix Plan: Cloudflare Worker + Frontend Email Sync

### Problems Found

1. **Cloudflare Worker returns empty `[]`** — KV has 60 reads but 0 writes. The `refreshFromSupabase()` function is silently failing. The edge function works fine when called directly (returns 45 emails). The Worker's `SUPABASE_URL` or `SUPABASE_KEY` secrets are likely wrong (extra spaces, wrong key, etc).

2. **Worker code has no error visibility** — errors in `refreshFromSupabase` are caught and logged to `console.error` but Workers console logs are hard to check. Need a debug endpoint.

3. **Frontend calls IMAP sync every 10 seconds** — This is terrible. Every 10s it triggers a FULL IMAP connection (connect → search → parse). The logs show boot/shutdown spam every 10s. IMAP sync should only happen on manual refresh or once every 2-3 minutes max. The 10s polling should only read from cache (via Cloudflare KV), not trigger IMAP.

4. **Worker `refreshInProgress` flag doesn't work** — Cloudflare Workers are stateless. The `let refreshInProgress = false` resets on every request. Multiple requests can trigger simultaneous Supabase calls.

### Changes

**1. Update `cloudflare-worker/worker.js`**
- Add a `GET /api/debug` endpoint that tries to call Supabase and returns the result/error — so you can check `netflixfetch.opgohils.workers.dev/api/debug` in your phone browser to see what's wrong
- Remove the broken `refreshInProgress` global variable (doesn't work in Workers)
- Use KV timestamp as the lock instead — only refresh if timestamp is older than 10s
- Make `handleGetEmails` actually `await` the refresh when KV is empty (first load), instead of fire-and-forget

**2. Update `src/App.tsx`**
- **Stop calling IMAP sync every 10 seconds**. Change `syncFromImap()` interval from 10s to only on mount + manual refresh button
- Keep `loadCachedEmails()` polling every 10 seconds via Cloudflare Worker (this is free and instant)
- The Cloudflare Worker itself handles refreshing from Supabase DB every 10s via stale-while-revalidate — frontend doesn't need to trigger it

### Architecture After Fix

```text
Every 10s (auto):
  Frontend → Cloudflare Worker /api/emails → KV (instant, free)
             Worker checks: KV age > 10s? → fetch from Supabase DB → update KV
             (1 Supabase call per 10s, NOT per user)

Manual refresh only:
  Frontend → Cloudflare Worker /api/emails/sync → Supabase Edge Function → IMAP
             (only when user clicks refresh button)
```

### Files to Edit
- `cloudflare-worker/worker.js` — Add debug endpoint, fix refresh logic
- `src/App.tsx` — Remove 10s IMAP sync interval, keep 10s cache poll

### After Deploy
You'll need to re-paste the updated `worker.js` code into Cloudflare dashboard and redeploy. Then check `/api/debug` on your phone to see if secrets are correct.


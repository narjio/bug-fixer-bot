

## Plan: Cloudflare Workers + KV Cache to Eliminate Supabase Egress

### Architecture

```text
Current (high egress):
  User ──10s──> Supabase Edge Function ──> Supabase DB ──> User
  (every user, every 10s = massive egress)

New (zero Supabase egress for reads):
  User ──10s──> Cloudflare Worker ──> KV Cache ──> User  (FREE, instant)
                     │
                     └── every 10s, Worker checks DB for new emails
                         (1 single call, not per-user)
```

### How It Works

1. **Cloudflare Worker** serves as the proxy between users and email data
2. **Cloudflare KV** stores the cached email list (free: 100K reads/day, 1K writes/day)
3. Worker reads from KV instantly for user requests (zero Supabase egress)
4. Worker refreshes KV from Supabase DB every 10 seconds using a stale-while-revalidate pattern — if KV data is older than 10s, it fetches fresh data from Supabase once and updates KV
5. Multiple users hitting the Worker simultaneously = still only 1 Supabase call per 10s cycle
6. IMAP sync continues running via Supabase Edge Function (writes to DB only — no egress to users)

### Supabase Egress Impact
- **Before**: Every user × every 10s = N × 8640 calls/day to Supabase
- **After**: Only 1 call per 10s from Cloudflare = 8640 calls/day total, regardless of user count
- **Savings**: ~99%+ for multi-user scenarios

### What Gets Created

**1. New file: `cloudflare-worker/worker.js`** (not deployed to Lovable — user deploys to Cloudflare)
- Handles GET `/api/emails` — returns cached emails from KV
- Handles POST `/api/emails/sync` — triggers IMAP sync via Supabase Edge Function
- Stale-while-revalidate: if KV data > 10s old, fetch from Supabase DB in background
- CORS headers for frontend access

**2. New file: `cloudflare-worker/wrangler.toml`** — Cloudflare config with KV binding

**3. Update `src/App.tsx`**
- Change `loadCachedEmails()` to call Cloudflare Worker URL instead of Supabase
- Change `syncFromImap()` to call Cloudflare Worker's sync endpoint
- Add env var `VITE_CLOUDFLARE_WORKER_URL` for the Worker URL
- Keep 10s auto-refresh interval (reads from Cloudflare = free)

**4. Update `supabase/functions/fetch-emails/index.ts`**
- No changes needed — it already handles `mode: "cache"` and `mode: "sync"` correctly
- Cloudflare Worker will call these same endpoints

### What You Need to Do (one-time setup)
1. Create a Cloudflare account (free)
2. Create a KV namespace called `EMAIL_CACHE`
3. Deploy the worker with `npx wrangler deploy`
4. Set worker environment variables: `SUPABASE_URL`, `SUPABASE_KEY`
5. Add your Cloudflare Worker URL to Lovable as `VITE_CLOUDFLARE_WORKER_URL`

### Files to Create/Edit
- **Create**: `cloudflare-worker/worker.js`, `cloudflare-worker/wrangler.toml`
- **Edit**: `src/App.tsx` (swap API endpoints to Cloudflare Worker URL)


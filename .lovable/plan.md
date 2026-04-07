

## Fix: Netflix Emails Not Showing (Backend Works, Frontend Broken)

### What I Confirmed
- Edge function `fetch-emails` **works** — just tested it, returns 5 Netflix emails from `info@account.netflix.com`
- Password reset emails are correctly skipped (2 skipped in latest run)
- Emails returned: "Netflix: your sign-in code" (x2), "Confirmation: Your Netflix household has been confirmed", "A new device is using your account", "Important: How to update your Netflix household"
- Frontend code at `src/App.tsx` line 890 correctly parses the array

### Root Cause
The edge function takes **8-10 seconds** to respond. The frontend has no issue parsing the response, BUT:
1. The function may be hitting the **edge function execution time limit** on some calls — it was timing out at 26s in earlier versions
2. The user is testing on **Vercel** (`bug-fixer-bot.vercel.app`) which may have **stale frontend code** from before all the fixes
3. There's a possibility the `res.text()` call at line 879 returns empty on timeout, causing `data` to be null → `Array.isArray(null)` = false → empty array

### Plan

1. **Add robust error handling and timeout protection in frontend**
   - Add a 25-second fetch timeout using `AbortController` so the user sees a clear timeout message instead of silent failure
   - Log the raw response to console for debugging
   - Show the actual error message when fetch fails

2. **Increase edge function scan range**
   - Currently scanning last 50 messages — if Netflix emails are older, increase to last 100 to catch more

3. **Add console logging in frontend for debugging**
   - Log response status, response length, and parsed email count so we can see what's happening on the user's end

### Files to Change
- `src/App.tsx` — fetchEmails function (lines 869-904): add AbortController timeout, better error logging
- `supabase/functions/fetch-emails/index.ts` — no changes needed, already working correctly

### After Implementation
- Redeploy edge function (already working)
- User needs to redeploy to Vercel for frontend changes to take effect on their live site


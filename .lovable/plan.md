

## Problem: Old edge function deployed on your external Supabase

The error message in your screenshot — `"Admin session required or provide current password"` — does not exist anywhere in the current code. The current code says `"Provide your current password or contact an admin"` instead. This confirms your external Supabase still has the **old version** of the `manage-app` function deployed.

The current code already supports the flow you described:
1. Admin creates user with a temporary password and `must_change_password = true`
2. User logs in with that temporary password
3. The "Set Your Password" modal appears (forced)
4. User sets their own password **without needing the current/temporary password**
5. After that, the user can change their password anytime using the header button (requires current password)

This flow works correctly in the updated code. The only issue is deployment.

---

### What you need to do

**Redeploy the `manage-app` edge function to your external Supabase project.** The function file is at `supabase/functions/manage-app/index.ts`.

From your project directory, run:
```text
supabase functions deploy manage-app --project-ref YOUR_PROJECT_REF
```

Or if you use the Supabase Dashboard: go to Edge Functions, delete the old `manage-app`, and deploy the new one from the current code.

Also make sure `SUPABASE_SERVICE_ROLE_KEY` is set in your Edge Function secrets — the session token verification depends on it.

---

### No code changes needed

The backend already handles all 3 password change cases:
- **Forced first-time set**: No `current_password` needed, verified by session token + `must_change_password` flag
- **Normal self-change**: Requires `current_password`
- **Admin reset**: Requires admin session token

The frontend already sends the correct payload (skips `current_password` when forced). The issue is purely that your external deployment has stale function code.




## Problem Analysis

There are **two issues**:

1. **Netflix emails not showing**: The edge function (`fetch-emails/index.ts`) has an overly strict OTP filter that skips emails unless they contain specific keywords like "otp", "verification code", "security code", etc. Netflix uses different wording (like "temporary access code", "sign-in code", or just sends the code without standard OTP keywords), so they get filtered out.

2. **Password reset emails still need to be excluded**: You want password reset emails hidden, which the current code already does — but since the OTP filter is too aggressive, it blocks legitimate emails too.

3. **Wrong Vercel URL**: Your actual deployed site is `https://bug-fixer-bot.vercel.app/`, not `er-bot.vercel.app`. The Lovable preview uses the edge function directly (which works), but your Vercel deployment uses `server.ts` which is a separate codebase. The Vercel site needs to also call the edge function or have its own working IMAP setup.

## Plan

### Step 1: Fix the email filter in the edge function
**File**: `supabase/functions/fetch-emails/index.ts`

- **Remove the strict OTP-only filter** — show ALL emails except password reset ones
- Keep the password reset exclusion (`password reset`, `reset your password`)
- Add more password reset keywords to be thorough (`forgot password`, `change your password`, `password change`)
- Still try to detect OTP codes from email content (for the OTP badge display), but don't use it as a filter to hide/show emails
- Add Netflix-specific sender detection (`netflix.com`, `account.netflix.com`) to always include those emails

### Step 2: Update frontend to handle non-OTP emails gracefully
**File**: `src/App.tsx`

- Emails without a detected OTP should still display normally (just without the OTP code highlight)
- No major changes needed since the Email type already has `otp` as optional

### Step 3: Fix Vercel deployment concern
**File**: `src/App.tsx`

- The frontend already calls the Supabase edge function URL (not `/api/emails`), so your Vercel deployment at `bug-fixer-bot.vercel.app` should also work as long as the env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set in your Vercel project settings
- No code change needed, but you'll need to verify those env vars are configured in your Vercel dashboard

## Summary
The main fix is removing the aggressive OTP-keyword filter from the edge function so ALL emails show up (except password reset ones). Netflix emails and any other service emails will then appear in your inbox.


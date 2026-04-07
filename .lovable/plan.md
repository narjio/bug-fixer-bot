

## Problem Summary

The edge function **is working** -- logs show it connects to IMAP, fetches 30 messages, and processes all 30 successfully. But the function **times out** before sending the response back to the client. Parsing 30 full email sources (with HTML, attachments, etc.) from a 94k+ mailbox takes too long for the edge function's execution limit.

Additionally, the user wants:
1. Remove Firebase completely -- use Lovable Cloud (database) for users, settings, OTPs
2. Netflix-style profile login (show all user profiles as cards, click profile, enter password)
3. Emails must actually show up

## Root Causes

1. **Email timeout**: Fetching `source: true` for 30 messages and parsing each with `simpleParser` takes ~40+ seconds. Edge functions have a ~30s timeout. The logs confirm "Processed 30 messages, kept 30" but the response never reaches the client due to timeout.
2. **Firebase dependency**: All auth, user management, OTP storage, and settings are stored in Firebase Firestore. The app cannot work without Firebase currently.
3. **Login UX**: Current user login fetches all usernames from Firestore and shows a dropdown after a delay.

## Plan

### Step 1: Fix email fetching (make it actually return data)
**File**: `supabase/functions/fetch-emails/index.ts`

- Reduce from 30 to **10 messages** to stay within timeout
- Use `envelope` + `bodyStructure` fetch instead of `source: true` to get metadata faster
- Only fetch full `source` for messages that pass initial filtering
- Add a **connection timeout** of 25 seconds to ensure the function responds before edge timeout
- Wrap the entire operation in a timeout safety net that returns whatever emails were collected so far

### Step 2: Create database tables for users, settings, OTPs
**Migration**: Create tables in Lovable Cloud

```text
users table:
- id (uuid, PK)
- username (text, unique)
- password (text, bcrypt hashed)
- name (text)
- role (text: 'admin' or 'user')
- totp_secret (text, nullable)
- created_at (timestamp)

settings table:
- key (text, PK)
- value (jsonb)

otps table:
- user_id (uuid, FK to users)
- otp (text)
- created_at (timestamp)
- expires_at (timestamp)
```

RLS: Public read on users (username, name, role only for profile display). Authenticated write for admin operations. OTPs restricted.

### Step 3: Create edge functions for auth operations
Since auth data moves to Lovable Cloud DB, we need edge functions:

- **`manage-users`**: CRUD operations for users (create, list, delete, update password)
- **`auth-login`**: Verify username + password, return user data
- **`manage-settings`**: Get/set settings (IMAP config, Telegram config, ReCAPTCHA)
- **`manage-otps`**: Create and verify OTPs

### Step 4: Build Netflix-style profile login
**File**: `src/App.tsx` (UserLoginPage)

- Home screen shows all user profile cards (fetched from `manage-users` edge function)
- Each card shows user's name with an avatar initial
- Click a profile card -> password input screen appears
- Enter password -> login
- No dropdown delay, no username typing needed

### Step 5: Remove all Firebase code
**Files to modify**: `src/App.tsx`, remove `src/firebase.ts`
**Files to remove from imports**: `firebase/firestore`, `firebase/app`, `firebase/auth`

- Replace all `collection()`, `getDocs()`, `getDoc()`, `setDoc()`, `addDoc()`, `deleteDoc()` calls with Supabase edge function calls
- Replace `db` references with fetch calls to edge functions
- Remove `firebase`, `firebase-admin` from `package.json`
- Remove `firebase-applet-config.json`, `firebase-blueprint.json`, `firestore.rules`
- Keep `server.ts` for Vercel deployment but update it to not use Firebase

### Step 6: Update server.ts for Vercel
**File**: `server.ts`

- Remove all Firebase imports and initialization
- For Vercel deployment, `server.ts` API routes should proxy to the Supabase edge functions OR read directly from Lovable Cloud DB
- Keep the same API routes (`/api/emails`, `/api/auth/notify`, etc.) but make them call edge functions internally

## Technical Details

- **Database**: 3 new tables (users, settings, otps) with RLS policies
- **Edge functions**: 4 new + 1 updated (fetch-emails fix)
- **Frontend**: Major refactor of `src/App.tsx` to remove Firebase, add Netflix-style profiles
- **Packages to remove**: `firebase`, `firebase-admin`, `connect-firestore`
- **Files to delete**: `src/firebase.ts`, `firebase-applet-config.json`, `firebase-blueprint.json`, `firestore.rules`

## Order of Implementation

1. Fix email edge function (immediate win -- emails will show)
2. Create database tables
3. Create auth/settings edge functions
4. Refactor frontend to use edge functions + Netflix-style login
5. Remove Firebase files and dependencies
6. Update server.ts


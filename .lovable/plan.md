
Goal

- ZIP wali inbox logic same flow me lagani hai taaki emails actually show ho.
- Existing Gmail-style inbox aur Netflix-style profiles ko mostly same rakhna hai.
- Password reset emails hidden hi rahenge.
- Jo clear vulnerabilities hain unko fix karna hai.

What I confirmed

- IMAP/backend ab main blocker nahi lag raha: recent backend logs me `Collected 13 emails` dikh raha hai.
- Iska matlab current “0 emails” issue frontend/request wiring me hai, not basic credentials.
- Current app me duplicate flow hai:
  - `src/App.tsx` direct backend function call kar raha hai
  - `server.ts` me alag `/api/emails` proxy bhi hai
  Ye preview aur Vercel behavior mismatch kara sakta hai.
- Security abhi bhi weak hai:
  - `app_users` public read se sensitive columns expose ho sakte hain
  - `app_settings` public read se secret config expose ho sakta hai
  - admin protection abhi true backend-enforced 2FA nahi hai

Plan

1. Transplant ZIP logic first
- Implementation mode me uploaded ZIP extract karke uske `src/App.tsx` aur `server.ts` ka inbox flow line-by-line current app se match karunga.
- Half-old / half-new flow nahi rakhenge.

2. Single inbox path use karna
- Current duplicate email path hataunga.
- Ek hi request path + ek hi response shape rakhenge, taaki backend emails collect kare aur frontend unhe `[]` me convert na kar de.

3. Email fetch flow ko ZIP ke behavior pe align karna
- ZIP ka working request/parse/display flow copy karunga.
- Normal mails aur Netflix mails visible rahenge.
- Sirf password reset mails hide honge.
- Recent scan fast rakhenge; full mailbox scan nahi.

4. UI same, data plumbing replace
- Gmail-style list/detail layout same rahega.
- Netflix-style profile selection same rahega.
- Sirf broken email loading/state logic ko ZIP ke working logic se replace karunga.

5. Security hardening while copying
- Admin-only mutations ke liye real backend validation lagani hogi.
- Admin panel access me completed 2FA enforce karna hoga.
- Password hash, TOTP secret, IMAP password, Telegram token, secret keys client ko readable nahi rahenge.
- Public profile list ke liye safe output/view use hoga.

6. Preview + deployed behavior align
- Preview aur Vercel dono ko same effective backend flow pe launga.
- Stale/conflicting routes remove karunga.
- Validation target ye hoga:
  - inbox count backend ke collected mails ke saath match kare
  - Netflix / normal emails show hon
  - password reset emails hidden rahen
  - admin panel usable rahe

Technical details

- Likely files: `src/App.tsx`, `server.ts`, `supabase/functions/fetch-emails/index.ts`, `supabase/functions/manage-app/index.ts`, plus DB migration for access tightening.
- Most important point: backend logs already show emails being collected, so next fix “more IMAP tuning” nahi hai; next fix exact ZIP request flow transplant + frontend/backend wiring cleanup hai.

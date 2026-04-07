
Goal: inbox ko actually emails dikhana hai, especially Netflix mails, but password reset emails ko hide hi rakhna hai.

What I found
- IMAP credentials likely the problem nahi hain: backend logs show mail server connect ho raha hai and messages process bhi ho rahe hain.
- Real issue code flow me hai:
  1. `server.ts` me abhi bhi old OTP-only filter pada hua hai, jo sirf OTP-like mails dikhata hai and Netflix jaise mails ko skip kar sakta hai.
  2. `fetch-emails` full mailbox scan kar raha hai (`search({ all: true })`) even though mailbox me ~94k messages hain, then sirf last 20 leta hai.
  3. Ek request ~21s le rahi hai, but UI har 15s me refresh kar raha hai, so overlapping requests start ho rahi hain.
  4. Code sirf `INBOX` padhta hai; Gmail me kuch Netflix mails `All Mail`/other labels me ho sakti hain.
- Isliye issue “email credentials” se zyada “filtering + slow retrieval + mismatched runtime paths” ka lag raha hai.

Plan
1. Unify the email logic
- Preview aur deployed site dono ko same email-fetching logic par laana.
- `server.ts` ka old OTP filter hataana ya `/api/emails` ko same backend logic se align karna.
- Final rule simple hoga: sab recent mails show karo except password reset mails.

2. Speed up IMAP fetching
- `search({ all: true })` remove karna.
- Sirf newest mail range fetch karna (for example last 50–100 messages) instead of scanning all 94k.
- Isse response fast aayega and realtime behavior better hoga.

3. Broaden mailbox coverage
- `INBOX` primary rahega.
- Gmail fallback add karna for folders/labels like `All Mail` if needed, taaki Netflix mails miss na hon.

4. Keep password reset exclusion only
- Password reset / forgot password / reset your password type mails hide rakhna.
- OTP keyword requirement completely remove karna.
- OTP detect sirf badge/copy button ke liye rakhna, filtering ke liye nahi.

5. Fix polling in the UI
- Jab ek fetch chal raha ho tab second fetch start na ho.
- Refresh interval ko request duration ke hisaab se safe banana.
- Manual refresh button working rahega.

6. Improve empty state
- “No emails found” aur “fetch failed” ko alag dikhana.
- Agar mails scan hue but matching mails na mile, to clearer message show hoga.

Validation
- Recent non-password-reset emails list me dikhne chahiye.
- `info@account.netflix.com` ka mail show hona chahiye if it exists in scanned folders.
- Password reset mails hidden rehne chahiye.
- Lovable preview aur `https://bug-fixer-bot.vercel.app/` dono par verify karna hoga, because frontend changes live site par tabhi aayenge jab Vercel rebuild/update hoga.

Technical details
- Main files: `supabase/functions/fetch-emails/index.ts`, `server.ts`, `src/App.tsx`
- Important code problems to remove:
  - full mailbox scan on ~94k emails
  - only last 20 emails window
  - overlapping 15s polling
  - old strict filter still present in `server.ts`

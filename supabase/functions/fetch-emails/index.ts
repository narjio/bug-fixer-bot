import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
};

const PASSWORD_RESET_SUBJECTS = [
  "reset your password", "forgot password", "password reset",
  "change your password", "password change", "password recovery",
  "account recovery", "reset password",
];

const SIGN_IN_CODE_SUBJECTS = [
  "enter this code", "sign-in code", "sign in to", "sign-in activity",
  "verification code", "login code", "sign in code",
];

// --- Session Token Verification ---
async function verifySessionToken(token: string, secret: string): Promise<Record<string, any> | null> {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// --- AES-256-GCM decryption ---
async function deriveEncKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode("imap-enc-salt-v1"), iterations: 100000, hash: "SHA-256" },
    keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
}

async function decryptValue(encrypted: string, secret: string): Promise<string> {
  if (!encrypted.startsWith("enc:")) return encrypted;
  const [, ivHex, ctHex] = encrypted.split(":");
  const key = await deriveEncKey(secret);
  const iv = new Uint8Array(ivHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(plain);
}

async function fetchFromAccount(
  supabase: any, imapHost: string, imapPort: number, imapUser: string, imapPassword: string,
  accountLabel: string, cachedIds: Set<string>, filterSignInCodes: boolean, filterPasswordResets: boolean,
): Promise<any[]> {
  const emails: any[] = [];
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; }, 25000);

  const client = new ImapFlow({
    host: imapHost, port: imapPort, secure: true,
    auth: { user: imapUser, pass: imapPassword }, logger: false,
  });

  try {
    await client.connect();
    console.log(`[${accountLabel}] IMAP connected to ${imapHost}`);
    const lock = await client.getMailboxLock("INBOX");

    try {
      const since = new Date();
      since.setDate(since.getDate() - 30);

      let netflixUids: number[] = [];
      try {
        const searchResults = await client.search({ from: "info@account.netflix.com", since }, { uid: true });
        if (searchResults && searchResults.length > 0) {
          netflixUids = searchResults as number[];
        }
      } catch {
        const totalMessages = (client.mailbox as any)?.exists || 0;
        if (totalMessages > 0) {
          const startSeq = Math.max(1, totalMessages - 499);
          for await (const message of client.fetch(`${startSeq}:${totalMessages}`, { envelope: true, uid: true })) {
            if (timedOut) break;
            const fromAddr = message.envelope?.from?.[0]?.address?.toLowerCase() || "";
            if (fromAddr === "info@account.netflix.com") netflixUids.push(message.uid);
          }
        }
      }

      netflixUids.sort((a, b) => b - a);
      const uncachedUids = netflixUids.filter(uid => !cachedIds.has(String(uid)));

      for (const uid of uncachedUids) {
        if (timedOut) break;
        try {
          const fullMsg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          if (!fullMsg?.source) continue;

          const envSubject = (fullMsg.envelope?.subject || "").toLowerCase();

          // Skip password reset emails (toggleable)
          if (filterPasswordResets && PASSWORD_RESET_SUBJECTS.some(kw => envSubject.includes(kw))) continue;

          // Skip sign-in code emails if filter is on
          if (filterSignInCodes && SIGN_IN_CODE_SUBJECTS.some(kw => envSubject.includes(kw))) continue;

          const parsed = await simpleParser(fullMsg.source, { skipImageLinks: true, skipTextLinks: true });
          const bodyText = (parsed.text || "").trim();
          const otpMatch = bodyText.match(/\b\d{4,8}\b/);

          emails.push({
            id: String(uid), subject: parsed.subject || fullMsg.envelope?.subject || "",
            from: parsed.from?.text || "Netflix <info@account.netflix.com>",
            to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text) : undefined,
            date: parsed.date, otp: otpMatch ? otpMatch[0] : null,
            preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
            html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
            account_label: accountLabel,
          });
        } catch (parseErr) {
          console.error(`[${accountLabel}] Parse error UID ${uid}:`, parseErr);
        }
      }
    } finally {
      lock.release();
    }
    try { await client.logout(); } catch {}
  } finally {
    clearTimeout(timeout);
  }
  return emails;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const SESSION_SECRET = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    let body: any = {};
    try { body = await req.json(); } catch {}
    const mode = body.mode || "sync";

    // Read email filter settings
    let filterSignInCodes = false;
    let filterPasswordResets = true; // Default: hide password reset emails
    try {
      const { data: filterData } = await supabase
        .from("app_settings").select("value").eq("key", "email_filters").single();
      if (filterData?.value) {
        if (filterData.value.showSignInCodes === false) filterSignInCodes = true;
        if (filterData.value.showPasswordResets === true) filterPasswordResets = false;
      }
    } catch {}

    // MODE: CACHE
    if (mode === "cache") {
      // Check for session token to enforce per-user account filtering
      let accountFilter: string[] | null = null;
      const sessionToken = req.headers.get("x-session-token") || body.sessionToken;
      if (sessionToken) {
        const session = await verifySessionToken(sessionToken, SESSION_SECRET);
        if (session?.assignedAccounts && Array.isArray(session.assignedAccounts)) {
          accountFilter = session.assignedAccounts;
        }
      }

      let query = supabase.from("cached_emails").select("*").order("date", { ascending: false });

      // Filter by account labels if user has assigned accounts
      if (accountFilter && accountFilter.length > 0) {
        query = query.in("account_label", accountFilter);
      }

      const { data: cached, error: cacheErr } = await query;

      if (cacheErr) {
        return new Response(JSON.stringify([]), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let emails = (cached || []).map((e: any) => ({
        id: e.id, subject: e.subject, from: e.from_address, to: e.to_address,
        date: e.date, otp: e.otp, preview: e.preview, html: e.html, account_label: e.account_label,
      }));

      if (filterSignInCodes) {
        emails = emails.filter((e: any) => {
          const sub = (e.subject || "").toLowerCase();
          return !SIGN_IN_CODE_SUBJECTS.some(kw => sub.includes(kw));
        });
      }

      if (filterPasswordResets) {
        emails = emails.filter((e: any) => {
          const sub = (e.subject || "").toLowerCase();
          return !PASSWORD_RESET_SUBJECTS.some(kw => sub.includes(kw));
        });
      }

      return new Response(JSON.stringify(emails), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // MODE: SYNC
    console.log("Sync mode: fetching from IMAP server(s)");

    const { data: cachedRows } = await supabase.from("cached_emails").select("id");
    const cachedIds = new Set((cachedRows || []).map((r: any) => String(r.id)));

    // Build list of accounts
    const accounts: Array<{ label: string; host: string; port: number; user: string; password: string }> = [];

    // Multi-account config (decrypt passwords)
    try {
      const { data: accountsData } = await supabase
        .from("app_settings").select("value").eq("key", "email_accounts").single();
      if (accountsData?.value && Array.isArray(accountsData.value) && accountsData.value.length > 0) {
        for (const acc of accountsData.value) {
          if (acc.user && acc.password) {
            const decryptedPass = await decryptValue(acc.password, SESSION_SECRET);
            accounts.push({
              label: acc.label || acc.user,
              host: acc.host || "imap.gmail.com",
              port: parseInt(acc.port) || 993,
              user: acc.user,
              password: decryptedPass,
            });
          }
        }
      }
    } catch {}

    // Primary config from app_settings or env vars
    let primaryHost = "", primaryPort = 993, primaryUser = "", primaryPassword = "";
    try {
      const { data } = await supabase.from("app_settings").select("value").eq("key", "config").single();
      if (data?.value) {
        const config = data.value as any;
        if (config.IMAP_HOST) primaryHost = config.IMAP_HOST;
        if (config.IMAP_PORT) primaryPort = parseInt(config.IMAP_PORT) || 993;
        if (config.IMAP_USER) primaryUser = config.IMAP_USER;
        if (config.IMAP_PASSWORD) primaryPassword = config.IMAP_PASSWORD;
      }
    } catch {}

    if (!primaryHost) primaryHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
    if (!primaryUser) primaryUser = Deno.env.get("IMAP_USER") || "";
    if (!primaryPassword) primaryPassword = Deno.env.get("IMAP_PASSWORD") || "";
    const envPort = Deno.env.get("IMAP_PORT");
    if (primaryPort === 993 && envPort) primaryPort = parseInt(envPort) || 993;

    if (primaryUser && primaryPassword) {
      const alreadyAdded = accounts.some(a => a.user === primaryUser);
      if (!alreadyAdded) {
        accounts.unshift({ label: "Primary", host: primaryHost, port: primaryPort, user: primaryUser, password: primaryPassword });
      }
    }

    if (accounts.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Inbox is not configured yet. Add IMAP email and app password in Admin Panel." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const allEmails: any[] = [];
    for (const acc of accounts) {
      try {
        console.log(`Fetching from account: ${acc.label} (${acc.user})`);
        const emails = await fetchFromAccount(supabase, acc.host, acc.port, acc.user, acc.password, acc.label, cachedIds, filterSignInCodes, filterPasswordResets);
        allEmails.push(...emails);
      } catch (err) {
        console.error(`Error fetching from ${acc.label}:`, err);
      }
    }

    allEmails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    if (allEmails.length > 0) {
      const rows = allEmails.map((e: any) => ({
        id: String(e.id), subject: e.subject, from_address: e.from, to_address: e.to || null,
        date: e.date, otp: e.otp || null, preview: e.preview || null, html: e.html || null,
        account_label: e.account_label || null, cached_at: new Date().toISOString(),
      }));

      const { error: upsertErr } = await supabase.from("cached_emails").upsert(rows, { onConflict: "id" });
      if (upsertErr) console.error("Cache upsert error:", upsertErr);
    }

    return new Response(JSON.stringify(allEmails), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Email fetch error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);

    return new Response(
      JSON.stringify({
        success: false,
        error: isImapAuthError
          ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
          : "Failed to fetch emails.",
      }),
      {
        status: isImapAuthError ? 401 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

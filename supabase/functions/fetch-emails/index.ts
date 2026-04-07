import { createClient } from "npm:@supabase/supabase-js@2";
import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PASSWORD_RESET_KEYWORDS = [
  "password reset", "reset your password", "forgot password",
  "change your password", "password change", "reset password",
  "verify your password", "account recovery", "recover your account",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get IMAP config from app_settings first, then env vars
    let imapHost = "";
    let imapPort = 993;
    let imapUser = "";
    let imapPassword = "";

    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      const { data } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "config")
        .single();

      if (data?.value) {
        const config = data.value as any;
        if (config.IMAP_HOST) imapHost = config.IMAP_HOST;
        if (config.IMAP_PORT) imapPort = parseInt(config.IMAP_PORT) || 993;
        if (config.IMAP_USER) imapUser = config.IMAP_USER;
        if (config.IMAP_PASSWORD) imapPassword = config.IMAP_PASSWORD;
      }
    } catch (e) {
      console.log("Could not read app_settings, falling back to env vars");
    }

    if (!imapHost) imapHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
    if (!imapUser) imapUser = Deno.env.get("IMAP_USER") || "";
    if (!imapPassword) imapPassword = Deno.env.get("IMAP_PASSWORD") || "";
    const envPort = Deno.env.get("IMAP_PORT");
    if (imapPort === 993 && envPort) imapPort = parseInt(envPort) || 993;

    if (!imapUser || !imapPassword) {
      return new Response(
        JSON.stringify({ success: false, error: "Inbox is not configured yet. Add IMAP email and app password in Admin Panel." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Connecting to IMAP:", imapHost, "as", imapUser);

    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: imapUser, pass: imapPassword },
      logger: false,
    });

    const emails: any[] = [];

    try {
      await client.connect();
      console.log("IMAP connected");
      const lock = await client.getMailboxLock("INBOX");

      try {
        const totalMessages = (client.mailbox as any)?.exists || 0;
        console.log("Total messages:", totalMessages);

        if (totalMessages > 0) {
          // Fetch last 8 messages only - keeps it fast
          const startSeq = Math.max(1, totalMessages - 7);
          const range = `${startSeq}:${totalMessages}`;
          console.log("Fetching range:", range);

          // Step 1: Fetch envelope data only (very fast, no body download)
          const envelopes: any[] = [];
          for await (const message of client.fetch(range, { envelope: true, uid: true })) {
            envelopes.push(message);
          }
          console.log("Got", envelopes.length, "envelopes");

          // Step 2: Filter out password reset emails by subject
          const validMessages = envelopes.filter(msg => {
            const subject = (msg.envelope?.subject || "").toLowerCase();
            return !PASSWORD_RESET_KEYWORDS.some(kw => subject.includes(kw));
          });
          console.log("After filter:", validMessages.length, "messages");

          // Step 3: Fetch full source only for filtered messages (max 8)
          for (const msg of validMessages.slice(0, 8)) {
            try {
              // Fetch source for this specific UID
              const fullMsg = await client.fetchOne(msg.uid, { source: true }, { uid: true });
              if (!fullMsg?.source) continue;

              const parsed = await simpleParser(fullMsg.source, {
                skipImageLinks: true,
                skipTextLinks: true,
              });

              const bodyText = (parsed.text || "").trim();
              const otpMatch = bodyText.match(/\b\d{4,8}\b/);
              const otp = otpMatch ? otpMatch[0] : null;

              emails.push({
                id: msg.uid,
                subject: parsed.subject || msg.envelope?.subject,
                from: parsed.from?.text || msg.envelope?.from?.[0]?.address,
                to: parsed.to
                  ? Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text
                  : msg.envelope?.to?.[0]?.address,
                date: parsed.date || msg.envelope?.date,
                otp,
                preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
                html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
              });
              console.log("Added email:", parsed.subject || msg.envelope?.subject);
            } catch (parseErr) {
              console.error("Parse error for UID", msg.uid, ":", parseErr);
            }
          }
        }

        console.log("Collected", emails.length, "emails");
      } finally {
        lock.release();
      }

      try { await client.logout(); } catch {}
    } catch (connErr) {
      if (emails.length === 0) throw connErr;
      console.error("IMAP error (returning partial):", connErr);
    }

    emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return new Response(JSON.stringify(emails), {
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

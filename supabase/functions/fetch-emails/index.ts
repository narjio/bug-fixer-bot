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
        // IMAP SEARCH for emails FROM info@account.netflix.com only
        console.log("Searching for Netflix emails (from: info@account.netflix.com)...");
        const searchResults = await client.search({ from: "info@account.netflix.com" });
        console.log("Found", searchResults.length, "Netflix emails total");

        if (searchResults.length > 0) {
          // Take only last 20 UIDs (most recent)
          const recentUids = searchResults.slice(-20);
          
          for (const uid of recentUids) {
            try {
              const fullMsg = await client.fetchOne(uid, { source: true }, { uid: true });
              if (!fullMsg?.source) continue;

              const parsed = await simpleParser(fullMsg.source, {
                skipImageLinks: true,
                skipTextLinks: true,
              });

              const subject = (parsed.subject || "").trim();
              const bodyText = (parsed.text || "").trim();
              const fromText = parsed.from?.text || "";
              const normalizedContent = `${subject}\n${fromText}\n${bodyText}`.toLowerCase();

              // Skip password reset emails
              const isPasswordReset = PASSWORD_RESET_KEYWORDS.some((kw) =>
                normalizedContent.includes(kw)
              );
              if (isPasswordReset) {
                console.log("Skipping password reset:", subject);
                continue;
              }

              const otpMatch = bodyText.match(/\b\d{4,8}\b/);
              const otp = otpMatch ? otpMatch[0] : null;

              emails.push({
                id: uid,
                subject: parsed.subject,
                from: parsed.from?.text,
                to: parsed.to
                  ? Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text
                  : undefined,
                date: parsed.date,
                otp,
                preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
                html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
              });
              console.log("Added Netflix email:", subject);
            } catch (parseErr) {
              console.error("Parse error for UID", uid, ":", parseErr);
            }
          }
        }

        console.log("Collected", emails.length, "Netflix emails (password reset excluded)");
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

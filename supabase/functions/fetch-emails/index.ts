import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const imapHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
    const imapPort = parseInt(Deno.env.get("IMAP_PORT") || "993");
    const imapUser = Deno.env.get("IMAP_USER") || "";
    const imapPassword = Deno.env.get("IMAP_PASSWORD") || "";

    console.log("IMAP config:", { host: imapHost, port: imapPort, user: imapUser ? "SET" : "EMPTY", pass: imapPassword ? "SET" : "EMPTY" });

    if (!imapUser || !imapPassword) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Inbox is not configured yet. Add IMAP email and app password in Admin Panel.",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Connecting to IMAP...");
    const client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: imapUser, pass: imapPassword },
      logger: false,
    });

    await client.connect();
    console.log("IMAP connected successfully");
    const lock = await client.getMailboxLock("INBOX");
    const emails: any[] = [];

    try {
      const uids = await client.search({ all: true });
      const latestUids = Array.isArray(uids) ? uids.slice(-25) : [];

      if (latestUids.length > 0) {
        for await (const message of client.fetch(latestUids, { source: true })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          const subject = parsed.subject || "";
          const bodyText = parsed.text || "";
          const normalizedContent = `${subject}\n${bodyText}`.toLowerCase();

          if (
            normalizedContent.includes("password reset") ||
            normalizedContent.includes("reset your password")
          ) {
            continue;
          }

          const otpMatch = normalizedContent.match(/\b\d{4,8}\b/);
          const looksLikeOtp =
            /(\botp\b|verification code|security code|passcode|one[- ]time code|login code|authentication code)/.test(
              normalizedContent
            );

          if (!otpMatch && !looksLikeOtp) continue;

          const otp = otpMatch ? otpMatch[0] : null;

          emails.push({
            id: message.uid,
            subject: parsed.subject,
            from: parsed.from?.text,
            to: parsed.to
              ? Array.isArray(parsed.to)
                ? parsed.to[0]?.text
                : parsed.to.text
              : undefined,
            date: parsed.date,
            otp,
            preview:
              bodyText.length > 100
                ? `${bodyText.substring(0, 100)}...`
                : bodyText,
            html:
              parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
          });
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    emails.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    return new Response(JSON.stringify(emails), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Email fetch error:", err);
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isImapAuthError =
      /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);

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
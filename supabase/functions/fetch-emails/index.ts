import { ImapFlow } from "npm:imapflow@1.2.18";
import { simpleParser } from "npm:mailparser@3.9.6";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PASSWORD_RESET_KEYWORDS = [
  "password reset",
  "reset your password",
  "forgot password",
  "change your password",
  "password change",
  "reset password",
  "verify your password",
  "account recovery",
  "recover your account",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const imapHost = Deno.env.get("IMAP_HOST") || "imap.gmail.com";
    const imapPort = parseInt(Deno.env.get("IMAP_PORT") || "993");
    const imapUser = Deno.env.get("IMAP_USER") || "";
    const imapPassword = Deno.env.get("IMAP_PASSWORD") || "";

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
      // Use mailbox.exists to get total count, then fetch only the latest N
      const mailbox = client.mailbox;
      const totalMessages = mailbox?.exists || 0;
      console.log("Total messages in INBOX:", totalMessages);

      if (totalMessages > 0) {
        // Fetch last 30 messages by sequence number (no full scan needed)
        const startSeq = Math.max(1, totalMessages - 29);
        const range = `${startSeq}:${totalMessages}`;
        console.log("Fetching range:", range);

        let msgCount = 0;
        for await (const message of client.fetch(range, { source: true })) {
          msgCount++;
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);
          const subject = parsed.subject || "";
          const bodyText = parsed.text || "";
          const normalizedContent = `${subject}\n${bodyText}`.toLowerCase();

          // Skip password reset emails only
          const isPasswordReset = PASSWORD_RESET_KEYWORDS.some(keyword =>
            normalizedContent.includes(keyword)
          );

          if (isPasswordReset) {
            console.log("Skipping password reset email:", subject);
            continue;
          }

          // Try to detect OTP (for badge display only, not filtering)
          const otpMatch = normalizedContent.match(/\b\d{4,8}\b/);
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
        console.log("Processed", msgCount, "messages, kept", emails.length);
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

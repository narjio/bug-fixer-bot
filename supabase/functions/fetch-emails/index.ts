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

    // Wrap entire IMAP operation in a timeout to ensure we respond before edge function limit
    const emails: any[] = [];
    const seenIds = new Set<number>();
    let timedOut = false;
    const MAX_RETURNED_EMAILS = 20;
    const BATCH_SIZE = 8;
    const MAX_SCAN_MESSAGES = 80;

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, 20000); // 20 second safety net
    });

    const fetchPromise = (async () => {
      const client = new ImapFlow({
        host: imapHost,
        port: imapPort,
        secure: true,
        auth: { user: imapUser, pass: imapPassword },
        logger: false,
      });

      try {
        await client.connect();
        console.log("IMAP connected");
        const lock = await client.getMailboxLock("INBOX");

        try {
          const totalMessages = (client.mailbox as any)?.exists || 0;
          console.log("Total messages:", totalMessages);

          if (totalMessages > 0) {
            const oldestSeqToScan = Math.max(1, totalMessages - MAX_SCAN_MESSAGES + 1);
            let currentEnd = totalMessages;

            while (
              currentEnd >= oldestSeqToScan &&
              emails.length < MAX_RETURNED_EMAILS &&
              !timedOut
            ) {
              const currentStart = Math.max(oldestSeqToScan, currentEnd - BATCH_SIZE + 1);
              const range = `${currentStart}:${currentEnd}`;
              console.log("Fetching range:", range);

              for await (const message of client.fetch(range, { source: true })) {
                if (timedOut || emails.length >= MAX_RETURNED_EMAILS) {
                  console.log("Timeout/result limit reached, returning collected emails");
                  break;
                }

                if (!message.source || seenIds.has(message.uid)) continue;
                seenIds.add(message.uid);

                try {
                  const parsed = await simpleParser(message.source, {
                    skipImageLinks: true,
                    skipTextLinks: true,
                  });
                  const subject = (parsed.subject || "").trim();
                  const bodyText = (parsed.text || "").trim();
                  const fromText = parsed.from?.text || "";
                  const normalizedContent = `${subject}\n${fromText}\n${bodyText}`.toLowerCase();

                  // Skip password reset emails only
                  const isPasswordReset = PASSWORD_RESET_KEYWORDS.some((kw) =>
                    normalizedContent.includes(kw)
                  );
                  if (isPasswordReset) {
                    console.log("Skipping password reset:", subject);
                    continue;
                  }

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
                    preview: bodyText.length > 100
                      ? `${bodyText.substring(0, 100)}...`
                      : bodyText,
                    html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
                  });
                } catch (parseErr) {
                  console.error("Failed to parse message:", parseErr);
                }
              }

              currentEnd = currentStart - 1;
            }

            console.log("Collected", emails.length, "emails");
          }
        } finally {
          lock.release();
        }

        try {
          await client.logout();
        } catch {
          // ignore logout errors
        }
      } catch (connErr) {
        // If we already have some emails, return them despite connection error
        if (emails.length === 0) throw connErr;
        console.error("IMAP error (returning partial):", connErr);
      }
    })();

    // Race between fetch and timeout
    await Promise.race([fetchPromise, timeoutPromise]);

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

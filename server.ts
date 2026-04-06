import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Helper to send Telegram notification
  async function sendTelegramNotification(message: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
      });
    } catch (err) {
      console.error("Telegram Error:", err);
    }
  }

  // API Route to fetch emails
  app.get("/api/emails", async (req, res) => {
    const config = {
      host: process.env.IMAP_HOST || "imap.gmail.com",
      port: parseInt(process.env.IMAP_PORT || "993"),
      secure: true,
      auth: {
        user: process.env.IMAP_USER || "omdevsinhgohil538@gmail.com",
        pass: process.env.IMAP_PASSWORD || "",
      },
      logger: false as false,
    };

    if (!config.auth.pass) {
      return res.status(400).json({ error: "IMAP_PASSWORD is not set." });
    }

    const client = new ImapFlow(config);

    try {
      await client.connect();
      let lock = await client.getMailboxLock("INBOX");
      const emails = [];
      
      try {
        const uids = await client.search({ from: "info@account.netflix.com" });
        const latestUids = Array.isArray(uids) ? uids.slice(-10) : [];
        
        if (latestUids.length > 0) {
          for await (let message of client.fetch(latestUids, { source: true })) {
            const parsed = await simpleParser(message.source);
            const subject = (parsed.subject || "").toLowerCase();
            const bodyText = parsed.text || "";
            
            if (subject.includes("password reset") || subject.includes("reset your password") || bodyText.toLowerCase().includes("reset your password")) {
              continue;
            }
            
            const otpMatch = bodyText.match(/\b\d{4,6}\b/);
            const otp = otpMatch ? otpMatch[0] : null;

            emails.push({
              id: message.uid,
              subject: parsed.subject,
              from: parsed.from?.text,
              to: parsed.to?.text,
              date: parsed.date,
              otp: otp,
              preview: bodyText.substring(0, 100) + "...",
              html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
            });
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
      emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      res.json(emails);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch emails." });
    }
  });

  // API Route for Login Notification & IP Capture
  app.post("/api/auth/notify", async (req, res) => {
    const { username, status, name } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    
    let locationData = "Unknown";
    try {
      const locRes = await fetch(`http://ip-api.com/json/${ip}`);
      const loc = await locRes.json() as any;
      if (loc.status === "success") {
        locationData = `${loc.city}, ${loc.regionName}, ${loc.country}`;
      }
    } catch (err) {}

    const message = `
<b>🔐 Login Attempt</b>
<b>User:</b> ${name || username}
<b>Status:</b> ${status === "success" ? "✅ Success" : "❌ Failed"}
<b>IP:</b> ${ip}
<b>Location:</b> ${locationData}
<b>Time:</b> ${new Date().toLocaleString()}
    `;

    await sendTelegramNotification(message);
    res.json({ success: true, ip, location: locationData });
  });

  // Admin 3FA: Generate Telegram OTP
  const tempOtps = new Map<string, string>();
  app.post("/api/admin/request-otp", async (req, res) => {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    tempOtps.set("admin", otp);
    
    await sendTelegramNotification(`<b>🛡 Admin 3FA OTP:</b> <code>${otp}</code>\nValid for 5 minutes.`);
    
    // Expire in 5 mins
    setTimeout(() => tempOtps.delete("admin"), 300000);
    res.json({ success: true });
  });

  app.post("/api/admin/verify-otp", (req, res) => {
    const { otp } = req.body;
    if (tempOtps.get("admin") === otp) {
      tempOtps.delete("admin");
      res.json({ success: true });
    } else {
      res.status(400).json({ error: "Invalid OTP" });
    }
  });

  // Admin Reset/Initialize Notification
  app.post("/api/admin/reset", async (req, res) => {
    const { username, password, type } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    
    const message = `
<b>🚨 Admin ${type === "initial" ? "Initialization" : "Reset"}</b>
<b>Username:</b> <code>${username}</code>
<b>Password:</b> <code>${password}</code>
<b>IP:</b> ${ip}
<b>Time:</b> ${new Date().toLocaleString()}

<i>Please delete this message after saving credentials.</i>
    `;

    await sendTelegramNotification(message);
    res.json({ success: true });
  });

  // Server-side Admin Bootstrap
  app.post("/api/admin/bootstrap", async (req, res) => {
    const adminEmail = "omdevsinhgohil538@gmail.com";
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || "admin123";
    
    try {
      // Note: We can't directly use Firestore here easily without admin SDK, 
      // but we can return the password to the client if they are authorized (e.g. first time setup)
      // or just confirm the setup.
      // For now, let's just return the password to the client-side bootstrap function
      // so it can create the doc in Firestore.
      res.json({ 
        username: adminEmail, 
        password: initialPassword 
      });
    } catch (err) {
      res.status(500).json({ error: "Bootstrap failed" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";
import firebaseConfig from "./firebase-applet-config.json" assert { type: "json" };

dotenv.config();

// Load Firebase config gracefully via import so Vercel bundles it
let db: any = null;
try {
  if (firebaseConfig && Object.keys(firebaseConfig).length > 0) {
    const appFirebase = initializeApp(firebaseConfig);
    db = getFirestore(appFirebase, (firebaseConfig as any).firestoreDatabaseId);
    console.log("Firebase initialized successfully on server.");
  }
} catch (err) {
  console.error("Failed to initialize Firebase:", err);
}

// --- DYNAMIC CONFIGURATION ---
// Helper to get the latest config, merging Environment Variables with Firestore Database
async function getDynamicConfig() {
  const cleanEnv = (val: string | undefined) => (val && val !== "undefined" && val.trim() !== "") ? val.trim() : null;

  let config = {
    TELEGRAM_BOT_TOKEN: cleanEnv(process.env.TELEGRAM_BOT_TOKEN) || "8575582532:AAE38rkI_zHmvmI8mZXdbYDp9ap3iT6mUGE", 
    TELEGRAM_CHAT_ID: cleanEnv(process.env.TELEGRAM_CHAT_ID) || "769748540", 
    ADMIN_EMAIL: cleanEnv(process.env.ADMIN_EMAIL) || "omdevsinhgohil538@gmail.com", 
    ADMIN_PASSWORD: cleanEnv(process.env.ADMIN_INITIAL_PASSWORD) || "admin123", 
    IMAP_HOST: cleanEnv(process.env.IMAP_HOST) || "imap.gmail.com",
    IMAP_PORT: parseInt(cleanEnv(process.env.IMAP_PORT) || "993"),
    IMAP_USER: cleanEnv(process.env.IMAP_USER) || "omdevsinhgohil538@gmail.com", 
    IMAP_PASSWORD: cleanEnv(process.env.IMAP_PASSWORD) || "", 
  };

  if (db) {
    try {
      const docSnap = await getDoc(doc(db, "settings", "config"));
      if (docSnap.exists()) {
        const data = docSnap.data();
        // Only override if the database value is actually set (not empty)
        if (data.TELEGRAM_BOT_TOKEN?.trim()) config.TELEGRAM_BOT_TOKEN = data.TELEGRAM_BOT_TOKEN.trim();
        if (data.TELEGRAM_CHAT_ID?.trim()) config.TELEGRAM_CHAT_ID = data.TELEGRAM_CHAT_ID.trim();
        if (data.ADMIN_EMAIL?.trim()) config.ADMIN_EMAIL = data.ADMIN_EMAIL.trim();
        if (data.ADMIN_PASSWORD?.trim()) config.ADMIN_PASSWORD = data.ADMIN_PASSWORD.trim();
        if (data.IMAP_HOST?.trim()) config.IMAP_HOST = data.IMAP_HOST.trim();
        if (data.IMAP_PORT?.toString().trim()) config.IMAP_PORT = parseInt(data.IMAP_PORT);
        if (data.IMAP_USER?.trim()) config.IMAP_USER = data.IMAP_USER.trim();
        if (data.IMAP_PASSWORD?.trim()) config.IMAP_PASSWORD = data.IMAP_PASSWORD.trim();
      }
    } catch (err) {
      console.error("Error fetching config from Firestore:", err);
    }
  }
  return config;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Helper to send Telegram notification
  async function sendTelegramNotification(message: string) {
    const CONFIG = await getDynamicConfig();
    const token = CONFIG.TELEGRAM_BOT_TOKEN;
    const chatId = CONFIG.TELEGRAM_CHAT_ID; 
    
    if (!token || !chatId) {
      console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in CONFIG");
      throw new Error("Telegram config missing");
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
      });
      
      if (!response.ok) {
        const errorData = await response.text();
        console.error("Telegram API Error:", errorData);
        throw new Error(`Telegram API Error: ${errorData}`);
      }
    } catch (err) {
      console.error("Telegram Request Error:", err);
      throw err;
    }
  }

  // API Route to fetch emails
  app.get("/api/emails", async (req, res) => {
    const CONFIG = await getDynamicConfig();
    const config = {
      host: CONFIG.IMAP_HOST,
      port: CONFIG.IMAP_PORT,
      secure: true,
      auth: {
        user: CONFIG.IMAP_USER,
        pass: CONFIG.IMAP_PASSWORD,
      },
      logger: false as false,
    };

    if (!config.auth.user || !config.auth.pass) {
      return res.status(400).json({ error: "IMAP_USER or IMAP_PASSWORD is not set." });
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
    const { username, status, name, lat, lon } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    
    let locationData = "Unknown";
    let mapsLink = "";

    if (lat && lon) {
      try {
        const locRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`, {
          headers: { "User-Agent": "NetflixMonitor/1.0" }
        });
        const loc = await locRes.json() as any;
        locationData = loc.display_name || `${lat}, ${lon}`;
        mapsLink = `\n<b>Maps:</b> <a href="https://www.google.com/maps?q=${lat},${lon}">View on Map</a>`;
      } catch (err) {
        locationData = `Lat: ${lat}, Lon: ${lon}`;
        mapsLink = `\n<b>Maps:</b> <a href="https://www.google.com/maps?q=${lat},${lon}">View on Map</a>`;
      }
    } else {
      try {
        const locRes = await fetch(`http://ip-api.com/json/${ip}`);
        const loc = await locRes.json() as any;
        if (loc.status === "success") {
          locationData = `${loc.city}, ${loc.regionName}, ${loc.country}`;
        }
      } catch (err) {}
    }

    const message = `
<b>🔐 Login Attempt</b>
<b>User:</b> ${name || username}
<b>Status:</b> ${status === "success" ? "✅ Success" : "❌ Failed"}
<b>IP:</b> ${ip}
<b>Location:</b> ${locationData}${mapsLink}
<b>Time:</b> ${new Date().toLocaleString()}
    `;

    await sendTelegramNotification(message);
    res.json({ success: true, ip, location: locationData });
  });

  // Admin 3FA: Generate Telegram OTP
  app.post("/api/admin/request-otp", async (req, res) => {
    try {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store OTP in Firestore because Vercel Serverless memory is wiped between requests
      if (db) {
        await setDoc(doc(db, "settings", "adminOtp"), { 
          otp, 
          expiresAt: Date.now() + 300000 // 5 minutes
        });
      } else {
        // Fallback for local dev if DB is missing
        (global as any).tempAdminOtp = otp;
      }
      
      await sendTelegramNotification(`<b>🛡 Admin 3FA OTP:</b> <code>${otp}</code>\nValid for 5 minutes.`);
      res.json({ success: true });
    } catch (err) {
      console.error("Error in request-otp:", err);
      res.status(500).json({ error: "Failed to send OTP via Telegram" });
    }
  });

  app.post("/api/admin/verify-otp", async (req, res) => {
    try {
      const { otp } = req.body;
      let isValid = false;

      if (db) {
        const otpDoc = await getDoc(doc(db, "settings", "adminOtp"));
        if (otpDoc.exists()) {
          const data = otpDoc.data();
          if (data.otp === otp && Date.now() < data.expiresAt) {
            isValid = true;
            // Invalidate OTP after use
            await setDoc(doc(db, "settings", "adminOtp"), { otp: null, expiresAt: 0 });
          }
        }
      } else {
        if ((global as any).tempAdminOtp === otp) {
          isValid = true;
          (global as any).tempAdminOtp = null;
        }
      }

      if (isValid) {
        res.json({ success: true });
      } else {
        res.status(400).json({ error: "Invalid or expired OTP" });
      }
    } catch (err) {
      console.error("Error verifying OTP:", err);
      res.status(500).json({ error: "Failed to verify OTP" });
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
    const { username } = req.body;
    const CONFIG = await getDynamicConfig();
    const adminEmail = CONFIG.ADMIN_EMAIL;
    
    if (!adminEmail) {
      return res.status(500).json({ error: "ADMIN_EMAIL is not configured on the server." });
    }
    
    if (username !== adminEmail) {
      return res.status(403).json({ error: "Not authorized to bootstrap" });
    }

    const initialPassword = CONFIG.ADMIN_PASSWORD;
    
    try {
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

  // Only listen if not running in Vercel serverless environment
  if (!process.env.VERCEL) {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }
  
  return app;
}

const appPromise = startServer();
export default async function (req: any, res: any) {
  const app = await appPromise;
  return app(req, res);
}

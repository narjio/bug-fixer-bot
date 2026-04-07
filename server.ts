import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, collection, query, where, addDoc, getDocs } from "firebase/firestore";
import { readFileSync } from 'fs';
import session from "express-session";
import cookieParser from "cookie-parser";

declare module "express-session" {
  interface SessionData {
    user: any;
  }
}

dotenv.config();

const firebaseConfig = JSON.parse(readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8'));

// Load Firebase config gracefully
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
async function getDynamicConfig() {
  const cleanEnv = (val: string | undefined) => (val && val !== "undefined" && val.trim() !== "") ? val.trim() : null;

  let config = {
    TELEGRAM_BOT_TOKEN: cleanEnv(process.env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_CHAT_ID: cleanEnv(process.env.TELEGRAM_CHAT_ID) || "769748540",
    ADMIN_EMAIL: cleanEnv(process.env.ADMIN_EMAIL) || "admin@example.com",
    ADMIN_PASSWORD: cleanEnv(process.env.ADMIN_INITIAL_PASSWORD) || "admin123",
    IMAP_HOST: cleanEnv(process.env.IMAP_HOST) || "imap.gmail.com",
    IMAP_PORT: parseInt(cleanEnv(process.env.IMAP_PORT) || "993"),
    IMAP_USER: cleanEnv(process.env.IMAP_USER) || "",
    IMAP_PASSWORD: cleanEnv(process.env.IMAP_PASSWORD) || "",
  };

  if (db) {
    try {
      const docSnap = await getDoc(doc(db, "settings", "config"));
      if (docSnap.exists()) {
        const data = docSnap.data();
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

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(session({
    secret: process.env.SESSION_SECRET || 'super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24
    }
  }));

  // Helper to send Telegram notification
  async function sendTelegramNotification(message: string) {
    const CONFIG = await getDynamicConfig();
    const token = CONFIG.TELEGRAM_BOT_TOKEN;
    const chatId = CONFIG.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing");
      throw new Error("Telegram config missing");
    }

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
  }

  const hasKnownLocationValue = (value: unknown) => {
    if (typeof value !== "string") return false;
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "unknown" && normalized !== "unknown city" && normalized !== "unknown state";
  };

  async function resolveLocationFromCoords(lat: number, lon: number) {
    try {
      const params = new URLSearchParams({
        format: "jsonv2",
        lat: String(lat),
        lon: String(lon),
        zoom: "10",
        addressdetails: "1",
      });

      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
        headers: {
          "User-Agent": "SecureOTPViewer/1.0",
          "Accept": "application/json",
          "Accept-Language": "en",
        },
      });

      if (!response.ok) {
        throw new Error(`Reverse geocoding failed with status ${response.status}`);
      }

      const data: any = await response.json();
      const address = data?.address ?? {};

      return {
        city: address.city || address.town || address.village || address.county || address.state_district || data?.name || "",
        state: address.state || address.region || address.province || address.county || "",
      };
    } catch (error) {
      console.error("Reverse geocoding failed:", error);
      return { city: "", state: "" };
    }
  }

  // API Route to fetch emails
  app.get("/api/emails", async (_req, res) => {
    try {
      const CONFIG = await getDynamicConfig();
      const config = {
        host: CONFIG.IMAP_HOST,
        port: CONFIG.IMAP_PORT,
        secure: true,
        auth: { user: CONFIG.IMAP_USER, pass: CONFIG.IMAP_PASSWORD },
        logger: false as false,
      };

      if (!config.auth.user || !config.auth.pass) {
        return res.status(400).json({
          success: false,
          error: "Inbox is not configured yet. Add IMAP email and app password in Admin Panel.",
          missingFields: [
            !config.auth.user ? "IMAP_USER" : null,
            !config.auth.pass ? "IMAP_PASSWORD" : null,
          ].filter(Boolean),
        });
      }

      const client = new ImapFlow(config);
      await client.connect();
      let lock = await client.getMailboxLock("INBOX");
      const emails: any[] = [];

      try {
        // Fetch last 30 messages by sequence number (fast, no full scan)
        const totalMessages = (client.mailbox as any)?.exists || 0;
        const startSeq = Math.max(1, totalMessages - 29);
        const range = totalMessages > 0 ? `${startSeq}:${totalMessages}` : "1:*";

        const passwordResetKeywords = [
          "password reset", "reset your password", "forgot password",
          "change your password", "password change", "reset password",
          "verify your password", "account recovery",
        ];

        for await (let message of client.fetch(range, { source: true })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source as any);
          const subject = parsed.subject || "";
          const bodyText = parsed.text || "";
          const normalizedContent = `${subject}\n${bodyText}`.toLowerCase();

          // Skip password reset emails only
          const isPasswordReset = passwordResetKeywords.some(kw => normalizedContent.includes(kw));
          if (isPasswordReset) continue;

          const otpMatch = normalizedContent.match(/\b\d{4,8}\b/);
          const otp = otpMatch ? otpMatch[0] : null;

          emails.push({
            id: message.uid,
            subject: parsed.subject,
            from: parsed.from?.text,
            to: parsed.to ? (Array.isArray(parsed.to) ? parsed.to[0]?.text : parsed.to.text) : undefined,
            date: parsed.date,
            otp,
            preview: bodyText.length > 100 ? `${bodyText.substring(0, 100)}...` : bodyText,
            html: parsed.html || parsed.textAsHtml || `<pre>${bodyText}</pre>`,
          });
        }
      } finally {
        lock.release();
      }
      await client.logout();
      emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      res.json(emails);
    } catch (err) {
      console.error("Email fetch error:", err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isImapAuthError = /auth|login|invalid credentials|authenticationfailed/i.test(errorMessage);

      res.status(isImapAuthError ? 401 : 500).json({
        success: false,
        error: isImapAuthError
          ? "IMAP login failed. Check the inbox email address and app password in Admin Panel."
          : "Failed to fetch emails.",
      });
    }
  });

  // Login Notification & Location
  app.post("/api/auth/notify", async (req, res) => {
    try {
      const { username, status, name, lat, lon, city, state } = req.body;
      const numericLat = Number(lat);
      const numericLon = Number(lon);
      const hasCoordinates = Number.isFinite(numericLat) && Number.isFinite(numericLon);

      let resolvedCity = hasKnownLocationValue(city) ? city.trim() : "";
      let resolvedState = hasKnownLocationValue(state) ? state.trim() : "";

      if (hasCoordinates && (!resolvedCity || !resolvedState)) {
        const reverseGeocoded = await resolveLocationFromCoords(numericLat, numericLon);
        resolvedCity ||= reverseGeocoded.city;
        resolvedState ||= reverseGeocoded.state;
      }

      const locationData = resolvedCity || resolvedState
        ? `${resolvedCity || "Unknown City"}, ${resolvedState || "Unknown State"}`
        : "Unknown Location";

      const displayName = name || username || "Unknown User";
      const actionText = status === "success" ? "logged in" : "had a failed login attempt";
      const mapsLink = hasCoordinates
        ? `\n<b>Maps:</b> <a href="https://www.google.com/maps?q=${numericLat},${numericLon}">View on Map</a>`
        : "";

      const message = `
<b>🔐 Login Attempt</b>
<b>${displayName}</b> ${actionText} from <b>${locationData}</b>
<b>User:</b> ${displayName}
<b>Status:</b> ${status === "success" ? "✅ Success" : "❌ Failed"}
<b>Location:</b> ${locationData}${mapsLink}
<b>Time:</b> ${new Date().toLocaleString()}
      `;

      await sendTelegramNotification(message);
      res.json({ success: true, location: locationData });
    } catch (err) {
      console.error("Notify error:", err);
      res.status(500).json({ success: false, error: "Failed to send notification" });
    }
  });

  // Admin Login
  app.post("/api/admin/login", async (req, res) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ success: false, error: "Username and password are required" });
      }

      const q = query(collection(db, "users"), where("username", "==", username));
      const snapshot = await getDocs(q);

      let userData: any;

      if (snapshot.empty) {
        const CONFIG = await getDynamicConfig();
        if (username === CONFIG.ADMIN_EMAIL && password === CONFIG.ADMIN_PASSWORD) {
          const docRef = await addDoc(collection(db, "users"), {
            username, password, name: "Administrator", role: "admin"
          });
          userData = { id: docRef.id, username, name: "Administrator", role: "admin" };
        } else {
          return res.status(401).json({ success: false, error: "Invalid credentials" });
        }
      } else {
        const userDoc = snapshot.docs[0];
        userData = { id: userDoc.id, ...userDoc.data() };

        if (userData.password !== password) {
          return res.status(401).json({ success: false, error: "Invalid credentials" });
        }
        if (userData.role !== "admin") {
          return res.status(403).json({ success: false, error: "Access denied" });
        }
      }

      req.session.user = userData;
      res.json({ success: true, user: userData });
    } catch (err) {
      console.error("Login error:", err);
      res.status(500).json({ success: false, error: "Login failed" });
    }
  });

  // Check Auth
  app.get("/api/auth/me", (req, res) => {
    if (req.session.user) {
      res.json({ success: true, user: req.session.user });
    } else {
      res.status(401).json({ success: false, error: "Not authenticated" });
    }
  });

  // Request OTP
  app.post("/api/admin/request-otp", async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, error: "Not authenticated" });
    try {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      if (db) {
        await setDoc(doc(db, "settings", "adminOtp"), {
          otp, expiresAt: Date.now() + 300000
        });
      } else {
        (global as any).tempAdminOtp = otp;
      }

      await sendTelegramNotification(`<b>🛡 Admin 3FA OTP:</b> <code>${otp}</code>\nValid for 5 minutes.`);
      res.json({ success: true });
    } catch (err) {
      console.error("Error in request-otp:", err);
      res.status(500).json({ success: false, error: err instanceof Error ? err.message : "Failed to send OTP" });
    }
  });

  // Verify OTP
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
        res.status(400).json({ success: false, error: "Invalid or expired OTP" });
      }
    } catch (err) {
      console.error("Error verifying OTP:", err);
      res.status(500).json({ success: false, error: "Failed to verify OTP" });
    }
  });

  // Admin Reset
  app.post("/api/admin/reset", async (req, res) => {
    try {
      const { username, password, type } = req.body;
      const message = `
<b>🚨 Admin ${type === "initial" ? "Initialization" : "Reset"}</b>
<b>Username:</b> <code>${username}</code>
<b>Password:</b> <code>${password}</code>
<b>Time:</b> ${new Date().toLocaleString()}
<i>Please delete this message after saving credentials.</i>
      `;
      await sendTelegramNotification(message);
      res.json({ success: true });
    } catch (err) {
      console.error("Reset error:", err);
      res.status(500).json({ success: false, error: "Failed to send reset notification" });
    }
  });

  // Admin Bootstrap
  app.post("/api/admin/bootstrap", async (req, res) => {
    try {
      const { username } = req.body;
      const CONFIG = await getDynamicConfig();
      const adminEmail = CONFIG.ADMIN_EMAIL;

      if (!adminEmail) {
        return res.status(500).json({ success: false, error: "ADMIN_EMAIL is not configured." });
      }
      if (username !== adminEmail) {
        return res.status(403).json({ success: false, error: "Not authorized to bootstrap" });
      }

      res.json({ success: true, username: adminEmail, password: CONFIG.ADMIN_PASSWORD });
    } catch (err) {
      console.error("Bootstrap error:", err);
      res.status(500).json({ success: false, error: "Bootstrap failed" });
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
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

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

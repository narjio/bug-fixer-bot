import React, { useState, useEffect, createContext, useContext } from "react";
import { Mail, RefreshCw, ShieldCheck, Clock, AlertCircle, Copy, Check, ArrowLeft, User, Lock, Send, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { db, auth } from "./firebase";
import { collection, query, where, getDocs, addDoc, serverTimestamp, doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import { generateSecret, generateURI, verify } from "otplib";
import { QRCodeSVG } from "qrcode.react";
import bcrypt from "bcryptjs";

// --- Rate Limiter (5 attempts per 60 seconds) ---
const loginAttempts: { [key: string]: number[] } = {};
function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const window = 60_000; // 1 minute
  const maxAttempts = 5;
  if (!loginAttempts[key]) loginAttempts[key] = [];
  loginAttempts[key] = loginAttempts[key].filter(t => now - t < window);
  if (loginAttempts[key].length >= maxAttempts) return false;
  loginAttempts[key].push(now);
  return true;
}

// Safe JSON parser - prevents crashes on non-JSON responses
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    console.error("Invalid JSON response:", text);
    throw new Error("Something went wrong. Please try again.");
  }
}

const OTP_SERVICE_FALLBACK = {
  url: "https://osxinhctzabxeycyeflg.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zeGluaGN0emFieGV5Y3llZmxnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU1NjY1MTUsImV4cCI6MjA5MTE0MjUxNX0.0_8_c1rxRXVOFUzC2aLjoRubLViSVo1qgeNvkbBMvFQ",
};

function getRuntimeValue(value: string | undefined, fallback: string) {
  if (!value || value === "undefined" || value === "null") {
    return fallback;
  }

  return value;
}

function getErrorMessage(error: unknown, fallback = "Something went wrong. Please try again.") {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message) return error.message;

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const preferred = record.error ?? record.message ?? record.details ?? record.reason;

    if (typeof preferred === "string" && preferred.trim()) {
      return preferred;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  return fallback;
}

async function sendTelegramOtp(otp: string, userId: string) {
  const otpServiceUrl = getRuntimeValue(import.meta.env.VITE_SUPABASE_URL, OTP_SERVICE_FALLBACK.url);
  const otpServiceKey = getRuntimeValue(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, OTP_SERVICE_FALLBACK.key);

  const response = await fetch(`${otpServiceUrl}/functions/v1/send-telegram-otp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${otpServiceKey}`,
    },
    body: JSON.stringify({ otp, userId }),
  });

  const data = await safeJson(response).catch(() => ({ success: false }));

  if (!response.ok || !data?.success) {
    console.error("Telegram OTP failed:", data);
    throw new Error("OTP delivery failed");
  }
}

async function sendLoginNotification(data: {
  username: string;
  name: string;
  status: "success" | "failed";
  lat?: number;
  lon?: number;
  city?: string;
  state?: string;
}) {
  const serviceUrl = getRuntimeValue(import.meta.env.VITE_SUPABASE_URL, OTP_SERVICE_FALLBACK.url);
  const serviceKey = getRuntimeValue(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, OTP_SERVICE_FALLBACK.key);

  try {
    const response = await fetch(`${serviceUrl}/functions/v1/send-login-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const errData = await response.text();
      console.error("Login notification failed:", errData);
    }
  } catch (err) {
    console.error("Failed to send login notification:", err);
  }
}

// Auth Context
const AuthContext = createContext<{ user: any, loading: boolean, checkAuth: () => Promise<void> } | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = async () => {
    try {
      const stored = localStorage.getItem("user");
      if (stored) {
        setUser(JSON.parse(stored));
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { checkAuth(); }, []);

  return <AuthContext.Provider value={{ user, loading, checkAuth }}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext)!;


// --- Types ---
interface Email {
  id: string;
  subject: string;
  from: string;
  to?: string;
  date: string;
  otp: string | null;
  preview: string;
  html: string;
}

interface UserData {
  id: string;
  username: string;
  password?: string;
  name: string;
  role: "admin" | "user";
  totpSecret?: string;
}

// --- Helpers ---
const getPreciseLocation = async (retries = 1): Promise<{lat: number, lon: number, city: string, state: string}> => {
  const fetchLocation = (): Promise<{lat: number, lon: number}> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported by your browser."));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            lat: position.coords.latitude,
            lon: position.coords.longitude
          });
        },
        (error) => {
          reject(error);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  };

  try {
    const coords = await fetchLocation();
    console.log("Location fetched:", coords);

    return { ...coords, city: "", state: "" };
  } catch (error) {
    console.error("Location fetch failed:", error);
    if (retries > 0) {
      return getPreciseLocation(retries - 1);
    }
    throw new Error("Location access is required to use this system. Please enable it.");
  }
};

// --- Components ---

function UserLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    const fetchUsernames = async () => {
      try {
        const q = query(collection(db, "users"), where("role", "==", "user"));
        const snapshot = await getDocs(q);
        const names = snapshot.docs.map(doc => doc.data().username);
        setSuggestions(names);
      } catch (err) {
        console.error("Failed to fetch usernames", err);
      }
    };
    fetchUsernames();
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (!checkRateLimit(`user_${username}`)) {
        throw new Error("Too many login attempts. Please wait 1 minute.");
      }

      // Force location permission first before proceeding
      const loc = await getPreciseLocation();

      // Fetch user by username only, then compare hashed password
      const q = query(collection(db, "users"), where("username", "==", username), where("role", "==", "user"));
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        throw new Error("Invalid username or password");
      }

      const userData = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as UserData;
      const storedPassword = snapshot.docs[0].data().password;

      // Support both hashed and plain text passwords (for migration)
      const isHashed = storedPassword && storedPassword.startsWith("$2");
      const passwordMatch = isHashed
        ? await bcrypt.compare(password, storedPassword)
        : password === storedPassword;

      if (!passwordMatch) {
        throw new Error("Invalid username or password");
      }

      // If password was plain text, upgrade to hash
      if (!isHashed) {
        const hash = await bcrypt.hash(password, 10);
        await setDoc(doc(db, "users", userData.id), { password: hash }, { merge: true });
      }

      localStorage.setItem("user", JSON.stringify(userData));
      await checkAuth();

      // Send login notification with location to Telegram
      try {
        await sendLoginNotification({
          username: userData.username,
          name: userData.name,
          status: "success",
          lat: loc.lat,
          lon: loc.lon,
        });
      } catch (notifyErr) {
        console.error("Failed to send login notification:", notifyErr);
      }

      navigate("/viewer");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Login failed";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 shadow-2xl mx-2 sm:mx-0"
      >
        <div className="flex justify-center mb-8">
          <div className="bg-red-600 p-3 sm:p-4 rounded-2xl shadow-lg shadow-red-200 cursor-pointer" onClick={() => navigate("/admin-login")}>
            <Mail className="text-white w-6 h-6 sm:w-8 sm:h-8" />
          </div>
        </div>
        <h2 className="text-xl sm:text-2xl font-black text-center text-slate-900 mb-1 sm:mb-2">Secure OTP Access</h2>
        <p className="text-slate-500 text-center text-xs sm:text-sm mb-4 sm:mb-8">Enter your credentials to continue</p>

        <form onSubmit={handleLogin} className="space-y-4">
          <div className="relative">
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Username</label>
            <div className="relative">
              <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="text"
                value={username}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="Your username"
                required
              />
            </div>
            <AnimatePresence>
              {showSuggestions && suggestions.length > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="absolute z-30 w-full mt-2 bg-white border border-slate-100 rounded-2xl shadow-xl overflow-hidden"
                >
                  {suggestions.filter(s => s.toLowerCase().includes(username.toLowerCase())).map(name => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => { setUsername(name); setShowSuggestions(false); }}
                      className="w-full text-left px-6 py-3 hover:bg-slate-50 text-sm font-bold text-slate-700 transition-colors"
                    >
                      {name}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Password</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all transform active:scale-95 disabled:opacity-50"
          >
            {loading ? "Verifying..." : "Sign In"}
          </button>
        </form>
      </motion.div>
    </div>
  );
}

function AdminLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [showCaptchaModal, setShowCaptchaModal] = useState(false);
  const navigate = useNavigate();
  const { checkAuth } = useAuth();

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const settingsDoc = await getDoc(doc(db, "settings", "recaptcha"));
        if (settingsDoc.exists() && settingsDoc.data().siteKey) {
          setSiteKey(settingsDoc.data().siteKey);
        } else {
          setSiteKey(null);
        }
      } catch (err) {
        setSiteKey(null);
      }
    };
    fetchSettings();
  }, []);

  const initiateLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (siteKey) {
      setShowCaptchaModal(true);
    } else {
      executeLogin();
    }
  };

  const executeLogin = async (captchaToken?: string) => {
    setLoading(true);
    setError("");

    try {
      if (!checkRateLimit(`admin_${username}`)) {
        throw new Error("Too many login attempts. Please wait 1 minute.");
      }

      // Force location permission first before proceeding
      const loc = await getPreciseLocation();

      // Fetch admin by username only, then compare hashed password
      const q = query(collection(db, "users"), where("username", "==", username), where("role", "==", "admin"));
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        throw new Error("Invalid admin credentials");
      }

      const storedPassword = snapshot.docs[0].data().password;
      const isHashed = storedPassword && storedPassword.startsWith("$2");
      const passwordMatch = isHashed
        ? await bcrypt.compare(password, storedPassword)
        : password === storedPassword;

      if (!passwordMatch) {
        throw new Error("Invalid admin credentials");
      }

      // Upgrade plain text to hash
      const userData = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as UserData;
      if (!isHashed) {
        const hash = await bcrypt.hash(password, 10);
        await setDoc(doc(db, "users", userData.id), { password: hash }, { merge: true });
      }

      localStorage.setItem("user", JSON.stringify(userData));
      await checkAuth();

      // Send login notification with location to Telegram
      try {
        await sendLoginNotification({
          username: userData.username,
          name: userData.name,
          status: "success",
          lat: loc.lat,
          lon: loc.lon,
        });
      } catch (notifyErr) {
        console.error("Failed to send login notification:", notifyErr);
      }

      toast.success("Login successful. Proceeding to 2FA.");
      navigate("/admin-auth");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Login failed";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleCaptchaSolve = (token: string | null) => {
    if (token) {
      setShowCaptchaModal(false);
      executeLogin(token);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md rounded-2xl sm:rounded-3xl p-5 sm:p-8 shadow-2xl border-t-4 sm:border-t-8 border-red-600 mx-2 sm:mx-0"
      >
        <div className="flex justify-center mb-8">
          <div className="bg-slate-900 p-3 sm:p-4 rounded-2xl shadow-lg">
            <ShieldCheck className="text-white w-6 h-6 sm:w-8 sm:h-8" />
          </div>
        </div>
        <h2 className="text-xl sm:text-2xl font-black text-center text-slate-900 mb-1 sm:mb-2">Admin Access</h2>
        <p className="text-slate-500 text-center text-xs sm:text-sm mb-4 sm:mb-8">Secure administrator login</p>

        <form onSubmit={initiateLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Username</label>
            <div className="relative">
              <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="admin@example.com"
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Admin Password</label>
            <div className="relative">
              <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 transition-all outline-none"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 text-xs p-3 rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all transform active:scale-95 disabled:opacity-50"
          >
            {loading ? "Authenticating..." : "Admin Sign In"}
          </button>
        </form>

        <div className="flex flex-col gap-2 mt-6">
          <button 
            onClick={() => navigate("/")}
            className="text-slate-400 text-[10px] font-bold uppercase tracking-widest hover:text-slate-900 transition-colors mt-2"
          >
            Back to User Login
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {showCaptchaModal && siteKey && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white p-6 rounded-3xl shadow-2xl relative"
            >
              <button 
                onClick={() => setShowCaptchaModal(false)}
                className="absolute -top-3 -right-3 bg-white text-slate-400 hover:text-slate-900 rounded-full p-1 shadow-md border"
              >
                <X className="w-5 h-5" />
              </button>
              <h3 className="text-center font-bold text-slate-800 mb-4">Security Check</h3>
              <div className="flex justify-center">
                <ReCAPTCHA
                  sitekey={siteKey}
                  onChange={handleCaptchaSolve}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AdminAuthPage() {
  const [step, setStep] = useState(1); // 1: Telegram OTP, 2: Google Auth (TOTP)
  const [otp, setOtp] = useState("");
  const [totp, setTotp] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const otpRequested = React.useRef(false);
  const { user } = useAuth();

  useEffect(() => {
    if (!user || user.role !== "admin") {
      navigate("/admin-login");
      return;
    }

    if (step === 1 && !otpRequested.current) {
      otpRequested.current = true;
      setLoading(true);
      (async () => {
        try {
          // Generate OTP
          const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
          await setDoc(doc(db, "otps", user.id), { otp: otpCode, createdAt: serverTimestamp() });

          await sendTelegramOtp(otpCode, user.id);
          toast.success("Secure OTP sent to your Telegram.");
          setLoading(false);
        } catch (err) {
          setLoading(false);
          const errorMsg = err instanceof Error && err.message === "OTP delivery failed"
            ? "OTP generated but Telegram delivery failed."
            : err instanceof Error
              ? err.message
              : "Failed to generate OTP";
          setError(errorMsg);
          toast.error(errorMsg);
          otpRequested.current = false;
        }
      })();
    }
    if (step === 2 && !user.totpSecret) {
      const secret = generateSecret();
      setSecretKey(secret);
      const uri = generateURI({
        issuer: "AdminPanel",
        label: user.username,
        secret
      });
      setQrCode(uri);
      setDoc(doc(db, "users", user.id), { totpSecret: secret }, { merge: true });
    }
  }, [step, user]);


  const verifyTelegramOtp = async () => {
    setLoading(true);
    try {
      const otpDoc = await getDoc(doc(db, "otps", user.id));
      if (!otpDoc.exists() || otpDoc.data().otp !== otp) {
        throw new Error("Invalid OTP");
      }
      // Delete used OTP
      await deleteDoc(doc(db, "otps", user.id));
      setStep(2);
      setError("");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Invalid Telegram OTP";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const verifyTotp = async () => {
    setLoading(true);
    try {
      const userDoc = await getDoc(doc(db, "users", user.id));
      const secret = userDoc.data()?.totpSecret || user.totpSecret;
      const result = await verify({ secret, token: totp });
      if (result) {
        localStorage.setItem("admin_auth", "true");
        navigate("/admin");
      } else {
        throw new Error("Invalid Google Auth Code");
      }
    } catch (err) {
      setError("Invalid Google Auth Code");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(secretKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-red-600/20 blur-[120px] rounded-full pointer-events-none"></div>

      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-slate-900/80 backdrop-blur-xl border border-slate-700/50 max-w-md w-full rounded-3xl p-8 shadow-[0_0_40px_rgba(220,38,38,0.1)] relative z-10"
      >
        <div className="flex justify-center mb-6">
          <div className="bg-red-500/10 p-4 rounded-2xl border border-red-500/20">
            <ShieldCheck className="w-10 h-10 text-red-500" />
          </div>
        </div>

        <h2 className="text-2xl font-black text-center text-white tracking-tight mb-2">
          3-Factor Authentication
        </h2>
        <p className="text-slate-400 text-center text-sm mb-8">
          {step === 1 ? "High-security OTP sent to your Telegram device." : "Enter the code from Google Authenticator"}
        </p>

        {step === 1 ? (
          <div className="space-y-6">
            <div className="relative">
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
                placeholder="••••••"
                maxLength={6}
              />
            </div>
            <button
              onClick={verifyTelegramOtp}
              disabled={loading || otp.length < 6}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all transform active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
            >
              {loading ? "Verifying Protocol..." : "Verify Telegram OTP"}
            </button>
            {error && (
              <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center">
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {qrCode && (
              <div className="flex flex-col items-center bg-slate-950 p-6 rounded-2xl border border-slate-800">
                <p className="text-xs font-bold text-slate-400 uppercase mb-4">Scan with Google Authenticator</p>
                <div className="bg-white p-2 rounded-xl">
                  <QRCodeSVG value={qrCode} size={160} />
                </div>
                <div className="mt-4 w-full">
                  <p className="text-xs text-slate-500 text-center mb-2">Or enter this key manually:</p>
                  <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-xl p-3">
                    <code className="text-sm font-mono text-slate-300 tracking-wider">{secretKey}</code>
                    <button 
                      onClick={copyToClipboard}
                      className="text-slate-400 hover:text-white transition-colors"
                      title="Copy to clipboard"
                    >
                      {copied ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="relative">
              <input
                type="text"
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full bg-slate-950 border border-slate-800 text-white text-center tracking-[0.75em] font-mono text-2xl rounded-2xl py-5 focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all outline-none placeholder:tracking-normal placeholder:text-sm placeholder:text-slate-600"
                placeholder="••••••"
                maxLength={6}
              />
            </div>
            <button
              onClick={verifyTotp}
              disabled={loading || totp.length < 6}
              className="w-full bg-gradient-to-r from-red-600 to-red-700 text-white font-bold py-4 rounded-2xl hover:from-red-500 hover:to-red-600 shadow-lg shadow-red-900/20 transition-all transform active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
            >
              {loading ? "Verifying Protocol..." : "Verify & Enter Admin"}
            </button>
          </div>
        )}
        {error && step === 2 && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 text-xs p-4 rounded-xl text-center mt-6">
            {error}
          </div>
        )}
      </motion.div>
    </div>
  );
}

function AdminPanel() {
  const [users, setUsers] = useState<UserData[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newName, setNewName] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  
  // Server Config State
  const [serverConfig, setServerConfig] = useState({
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    IMAP_HOST: "",
    IMAP_PORT: "",
    IMAP_USER: "",
    IMAP_PASSWORD: "",
    ADMIN_EMAIL: "",
    ADMIN_PASSWORD: ""
  });
  const [savingConfig, setSavingConfig] = useState(false);

  const navigate = useNavigate();

  useEffect(() => {
    const fetchData = async () => {
      const snapshot = await getDocs(collection(db, "users"));
      setUsers(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as UserData)));

      const settingsDoc = await getDoc(doc(db, "settings", "recaptcha"));
      if (settingsDoc.exists()) {
        setSiteKey(settingsDoc.data().siteKey || "");
        setSecretKey(settingsDoc.data().secretKey || "");
      }

      const configDoc = await getDoc(doc(db, "settings", "config"));
      if (configDoc.exists()) {
        setServerConfig(prev => ({ ...prev, ...configDoc.data() }));
      }
    };
    fetchData();
  }, []);

  const saveRecaptchaSettings = async () => {
    await setDoc(doc(db, "settings", "recaptcha"), { siteKey, secretKey }, { merge: true });
    toast.success("ReCAPTCHA settings saved successfully!");
  };

  const saveServerConfig = async () => {
    setSavingConfig(true);
    try {
      await setDoc(doc(db, "settings", "config"), serverConfig, { merge: true });
      toast.success("Server configuration saved! Changes apply immediately.");
    } catch (err) {
      toast.error("Failed to save config: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSavingConfig(false);
    }
  };

  const createUser = async () => {
    if (!newUsername || !newPassword || !newName) {
      toast.error("Please fill all fields");
      return;
    }
    try {
      await addDoc(collection(db, "users"), {
        username: newUsername,
        password: newPassword,
        name: newName,
        role: "user"
      });
      setNewUsername("");
      setNewPassword("");
      setNewName("");
      toast.success("User created successfully");
      // Refresh list
      const snapshot = await getDocs(collection(db, "users"));
      setUsers(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as UserData)));
    } catch (err) {
      toast.error("Failed to create user: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  const deleteUser = async (id: string) => {
    try {
      await deleteDoc(doc(db, "users", id));
      setUsers(users.filter(u => u.id !== id));
      toast.success("User deleted successfully");
    } catch (err) {
      toast.error("Failed to delete user: " + (err instanceof Error ? err.message : String(err)));
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b px-2 sm:px-4 py-3 sm:py-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex justify-between items-center gap-2">
          <h1 className="text-sm sm:text-xl font-black flex items-center gap-1.5 sm:gap-2 min-w-0 truncate">
            <Settings className="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0" />
            Admin Control Panel
          </h1>
          <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full">
            <LogOut className="w-5 h-5 text-slate-400" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-2 sm:p-4 py-4 sm:py-8 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-8">
        <div className="lg:col-span-1 space-y-6">
          <section className="bg-white p-4 sm:p-6 rounded-2xl sm:rounded-3xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 sm:mb-6 flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-red-600" />
              ReCAPTCHA Settings
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Site Key</label>
                <input
                  type="text"
                  placeholder="Enter Site Key"
                  value={siteKey}
                  onChange={(e) => setSiteKey(e.target.value)}
                  className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Secret Key</label>
                <input
                  type="password"
                  placeholder="Enter Secret Key"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>
              <button
                onClick={saveRecaptchaSettings}
                className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all"
              >
                Save Settings
              </button>
            </div>
          </section>

          <section className="bg-white p-4 sm:p-6 rounded-2xl sm:rounded-3xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 sm:mb-6 flex items-center gap-2">
              <Plus className="w-5 h-5 text-red-600" />
              Create New User
            </h2>
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Full Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500"
              />
              <input
                type="text"
                placeholder="Username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500"
              />
              <input
                type="text"
                placeholder="Password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full bg-slate-50 border rounded-2xl p-4 outline-none focus:ring-2 focus:ring-red-500"
              />
              <button
                onClick={createUser}
                className="w-full bg-red-600 text-white font-bold py-4 rounded-2xl hover:bg-red-700 transition-all"
              >
                Add User
              </button>
            </div>
          </section>
        </div>

        <div className="lg:col-span-2 space-y-6">
          <section className="bg-white p-4 sm:p-6 rounded-2xl sm:rounded-3xl border shadow-sm">
            <h2 className="font-black text-base sm:text-lg mb-4 sm:mb-6 flex items-center gap-2">
              <Settings className="w-5 h-5 text-red-600" />
              Server Configuration (Database)
            </h2>
            <p className="text-xs sm:text-sm text-slate-500 mb-4 sm:mb-6">These settings override the default server configuration in real-time. Leave blank to use defaults.</p>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              <div className="space-y-4">
                <h3 className="font-bold text-slate-800 border-b pb-2">Telegram Bot</h3>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Bot Token</label>
                  <input
                    type="password"
                    placeholder="e.g. 8575582532:AAE..."
                    value={serverConfig.TELEGRAM_BOT_TOKEN}
                    onChange={(e) => setServerConfig({...serverConfig, TELEGRAM_BOT_TOKEN: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Chat ID</label>
                  <input
                    type="text"
                    placeholder="e.g. 769748540"
                    value={serverConfig.TELEGRAM_CHAT_ID}
                    onChange={(e) => setServerConfig({...serverConfig, TELEGRAM_CHAT_ID: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-4">
                <h3 className="font-bold text-slate-800 border-b pb-2">IMAP Server (Email Fetching)</h3>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Host</label>
                    <input
                      type="text"
                      placeholder="imap.gmail.com"
                      value={serverConfig.IMAP_HOST}
                      onChange={(e) => setServerConfig({...serverConfig, IMAP_HOST: e.target.value})}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">Port</label>
                    <input
                      type="text"
                      placeholder="993"
                      value={serverConfig.IMAP_PORT}
                      onChange={(e) => setServerConfig({...serverConfig, IMAP_PORT: e.target.value})}
                      className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">IMAP User (Email)</label>
                  <input
                    type="text"
                    placeholder="Email Address"
                    value={serverConfig.IMAP_USER}
                    onChange={(e) => setServerConfig({...serverConfig, IMAP_USER: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1 ml-1">IMAP App Password</label>
                  <input
                    type="password"
                    placeholder="16-digit App Password"
                    value={serverConfig.IMAP_PASSWORD}
                    onChange={(e) => setServerConfig({...serverConfig, IMAP_PASSWORD: e.target.value})}
                    className="w-full bg-slate-50 border rounded-xl p-3 outline-none focus:ring-2 focus:ring-red-500 text-sm"
                  />
                </div>
              </div>
            </div>

            <button
              onClick={saveServerConfig}
              disabled={savingConfig}
              className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl hover:bg-slate-800 transition-all disabled:opacity-50"
            >
              {savingConfig ? "Saving..." : "Save Server Configuration"}
            </button>
          </section>

          <section className="bg-white p-4 sm:p-6 rounded-2xl sm:rounded-3xl border shadow-sm h-full">
            <h2 className="font-black text-base sm:text-lg mb-4 sm:mb-6 flex items-center gap-2">
              <Users className="w-5 h-5 text-red-600" />
              Active Users
            </h2>
            <div className="space-y-3">
              {users.map(u => (
                <div key={u.id} className="flex items-center justify-between p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div>
                    <p className="font-bold text-slate-900">{u.name}</p>
                    <p className="text-xs text-slate-500">@{u.username} • {u.role}</p>
                  </div>
                  {u.role !== "admin" && (
                    <button onClick={() => deleteUser(u.id)} className="p-2 hover:bg-red-50 text-red-400 hover:text-red-600 rounded-lg transition-colors">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function EmailViewer() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [otpCopied, setOtpCopied] = useState(false);
  const refreshIntervalSeconds = 5;
  const [countdown, setCountdown] = useState(refreshIntervalSeconds);
  const navigate = useNavigate();

  const user = JSON.parse(localStorage.getItem("user") || "{}");

  const fetchEmails = async (isManual = false) => {
    if (loading && isManual) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/emails", {
        credentials: "include",
        headers: {
          Accept: "application/json",
        },
      });
      const response = await fetch(
        `${getRuntimeValue(import.meta.env.VITE_SUPABASE_URL, OTP_SERVICE_FALLBACK.url)}/functions/v1/fetch-emails`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${getRuntimeValue(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, OTP_SERVICE_FALLBACK.key)}`,
          },
        }
      );
      const raw = await response.text();
      let data: any = null;

      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          console.error("Inbox API returned non-JSON:", raw.slice(0, 200));
          throw new Error(
            response.status === 400
              ? "Inbox is not configured yet. Ask admin to add IMAP email settings."
              : "Email service is temporarily unavailable."
          );
        }
      }

      if (!response.ok) {
        throw new Error(getErrorMessage(data?.error ?? data, "Failed to fetch emails."));
      }

      const emailList = (Array.isArray(data) ? data : []) as Email[];
      emailList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setEmails(emailList);
      setLastUpdated(new Date());
      setCountdown(refreshIntervalSeconds);
      
      if (selectedEmail) {
        const updated = emailList.find((e: Email) => e.id === selectedEmail.id);
        if (updated) setSelectedEmail(updated);
      }
    } catch (err) {
      setError(getErrorMessage(err, "An unknown error occurred"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchEmails();
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchEmails();
          return refreshIntervalSeconds;
        }
        return prev - 1;
      });
    }, 1000);

    const handleFocusRefresh = () => {
      fetchEmails();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        fetchEmails();
      }
    };

    window.addEventListener("focus", handleFocusRefresh);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", handleFocusRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const handleManualRefresh = () => {
    fetchEmails(true);
  };

  const copyOtp = (otp: string) => {
    navigator.clipboard.writeText(otp);
    setOtpCopied(true);
    setTimeout(() => setOtpCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-2 sm:px-4 h-14 sm:h-16 flex items-center justify-between gap-1 sm:gap-2">
          <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-shrink">
            <div className="bg-red-600 p-1.5 sm:p-2 rounded-lg flex-shrink-0">
              <Mail className="text-white w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <h1 className="font-bold text-sm sm:text-xl tracking-tight hidden md:block">Secure OTP Viewer</h1>
            <div className="flex items-center gap-1.5 bg-slate-100 px-2 sm:px-3 py-0.5 sm:py-1 rounded-full min-w-0">
              <div className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
              <span className="text-[10px] sm:text-xs font-bold text-slate-600 truncate max-w-[60px] sm:max-w-[120px]">{user.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-3 flex-shrink-0">
            <div className="flex flex-col items-end mr-0.5 sm:mr-2">
              <span className="text-[8px] sm:text-[10px] font-bold text-slate-400 uppercase leading-tight">Refresh</span>
              <span className="text-xs sm:text-sm font-mono font-bold text-red-600">{countdown}s</span>
            </div>
            <button
              onClick={handleManualRefresh}
              disabled={loading}
              className="flex items-center gap-1 sm:gap-2 p-2 sm:px-4 sm:py-2 bg-slate-900 text-white rounded-full text-xs sm:text-sm font-bold hover:bg-slate-800 transition-all disabled:opacity-50 active:scale-95"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
            <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-1.5 sm:p-2 hover:bg-slate-100 rounded-full">
              <LogOut className="w-4 h-4 sm:w-5 sm:h-5 text-slate-400" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-2 sm:px-4 py-4 sm:py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-8">
          <div className={`${selectedEmail ? 'hidden lg:block' : 'block'} lg:col-span-5 xl:col-span-4 space-y-6`}>
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-3 sm:p-5 flex items-center gap-3 sm:gap-4">
              <div className="bg-green-100 p-2 sm:p-3 rounded-xl flex-shrink-0">
                <ShieldCheck className="text-green-600 w-6 h-6" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-800">System Active</h2>
                <p className="text-xs text-slate-500">Monitoring OTPs securely</p>
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-800 flex items-center gap-2">
                  Inbox
                  <span className="bg-slate-200 text-slate-600 text-[10px] px-2 py-0.5 rounded-full">
                    {emails.length}
                  </span>
                </h3>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-100 rounded-xl p-4 mb-4">
                  <p className="text-red-600 text-xs flex items-center gap-2">
                    <AlertCircle className="w-3 h-3" />
                    {error}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                {emails.length === 0 && !loading && !error ? (
                  <div className="bg-white border border-dashed border-slate-200 rounded-xl p-12 text-center">
                    <div className="bg-slate-50 w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Clock className="text-slate-200 w-6 h-6" />
                    </div>
                    <p className="text-[10px] sm:text-xs text-slate-400 font-medium">Waiting for OTP emails...</p>
                  </div>
                ) : (
                  emails.map((email) => (
                    <button
                      key={email.id}
                      onClick={() => setSelectedEmail(email)}
                      className={`w-full text-left p-4 rounded-xl border transition-all ${
                        selectedEmail?.id === email.id
                          ? "bg-white border-red-200 shadow-md ring-1 ring-red-100"
                          : "bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm"
                      }`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span className="text-[10px] font-bold text-red-600 uppercase tracking-tight">
                          System Official
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(email.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-slate-900 truncate mb-1">
                        {email.subject}
                      </h4>
                      <p className="text-xs text-slate-500 line-clamp-1">
                        {email.preview}
                      </p>
                      {email.otp && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="bg-slate-900 text-white text-[10px] font-mono px-2 py-0.5 rounded">
                            OTP: {email.otp}
                          </div>
                          <div className="w-1 h-1 bg-slate-300 rounded-full" />
                          <span className="text-[10px] text-slate-400 font-bold uppercase">Ready</span>
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>

          <div className={`${selectedEmail ? 'block' : 'hidden lg:flex'} lg:col-span-7 xl:col-span-8 flex-col h-[calc(100vh-8rem)] sm:h-[calc(100vh-12rem)] min-h-[400px] sm:min-h-[600px]`}>
            {selectedEmail ? (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full overflow-hidden"
              >
                <div className="p-3 sm:p-6 border-b border-slate-100 bg-white sticky top-0 z-10">
                  <div className="flex items-center gap-2 sm:gap-4 mb-3 sm:mb-6">
                    <button 
                      onClick={() => setSelectedEmail(null)}
                      className="flex items-center gap-1.5 px-3 py-1.5 sm:px-4 sm:py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-colors font-bold text-xs sm:text-sm active:scale-95"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      <span className="hidden xs:inline">Back to </span>Inbox
                    </button>
                  </div>

                  <h2 className="text-base sm:text-2xl font-bold text-slate-900 mb-2 sm:mb-4 leading-tight">
                    {selectedEmail.subject}
                  </h2>
                  
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                      <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-sm sm:text-lg flex-shrink-0">
                        N
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-xs sm:text-sm text-slate-900 truncate">System Support</span>
                          <span className="text-[10px] sm:text-xs text-slate-400 hidden sm:inline">Verified Sender</span>
                        </div>
                        <p className="text-[10px] sm:text-xs text-slate-500 italic truncate">Recipient: Protected Account</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-[10px] sm:text-xs text-slate-400">
                        {new Date(selectedEmail.date).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-auto p-3 sm:p-6 bg-white">
                  {selectedEmail.otp && (
                    <div className="mb-4 sm:mb-8 bg-slate-900 rounded-xl sm:rounded-2xl p-4 sm:p-6 text-center shadow-xl shadow-slate-200 relative overflow-hidden">
                      <div className="relative z-10">
                        <p className="text-slate-400 text-[10px] sm:text-xs font-bold uppercase tracking-[0.15em] sm:tracking-[0.2em] mb-1 sm:mb-2">
                          Detected OTP Code
                        </p>
                        <div className="text-3xl sm:text-5xl font-mono font-black text-white tracking-wider sm:tracking-widest mb-2 sm:mb-4">
                          {selectedEmail.otp}
                        </div>
                        <button
                          onClick={() => copyOtp(selectedEmail.otp!)}
                          className="flex items-center gap-1.5 mx-auto px-4 py-1.5 sm:px-6 sm:py-2 bg-red-600 hover:bg-red-700 text-white rounded-full font-bold text-xs sm:text-sm transition-all transform active:scale-95"
                        >
                          {otpCopied ? (
                            <>
                              <Check className="w-4 h-4" />
                              Copied!
                            </>
                          ) : (
                            <>
                              <Copy className="w-4 h-4" />
                              Copy Code
                            </>
                          )}
                        </button>
                      </div>
                      <div className="absolute top-0 right-0 p-2 sm:p-4 opacity-10">
                        <ShieldCheck className="w-16 h-16 sm:w-24 sm:h-24 text-white" />
                      </div>
                    </div>
                  )}
                  
                  <div className="prose prose-slate max-w-none">
                    <div 
                      className="gmail-style-content"
                      dangerouslySetInnerHTML={{ __html: selectedEmail.html.replace(/omdevsinhgohil538@gmail\.com/g, "<b>[Protected]</b>") }} 
                    />
                  </div>
                </div>
              </motion.div>
            ) : (
              <div className="bg-white rounded-2xl border border-dashed border-slate-200 flex flex-col items-center justify-center h-full text-center p-6 sm:p-12">
                <div className="bg-slate-50 w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center mb-4 sm:mb-6">
                  <Mail className="text-slate-200 w-8 h-8 sm:w-10 sm:h-10" />
                </div>
                <h3 className="text-base sm:text-xl font-bold text-slate-800 mb-2">Select an email to read</h3>
                <p className="text-sm sm:text-base text-slate-400 max-w-xs mx-auto">
                  Click on any email from the inbox list to view its full content and details.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      <style>{`
        .gmail-style-content {
          font-family: 'Inter', sans-serif;
          line-height: 1.6;
          color: #334155;
          font-size: 14px;
          overflow-x: auto;
          word-break: break-word;
        }
        .gmail-style-content img {
          max-width: 100%;
          height: auto;
        }
        .gmail-style-content a {
          color: #e11d48;
          text-decoration: underline;
          word-break: break-all;
        }
        .gmail-style-content table {
          max-width: 100% !important;
          width: 100% !important;
          table-layout: fixed !important;
        }
        .gmail-style-content td,
        .gmail-style-content th {
          word-break: break-word !important;
          overflow-wrap: break-word !important;
        }
        @media (max-width: 480px) {
          .gmail-style-content {
            font-size: 12px;
          }
          .gmail-style-content table {
            display: block !important;
            overflow-x: auto !important;
          }
        }
      `}</style>
    </div>
  );
}

// --- Main App ---

import { Toaster, toast } from "sonner";
import ReCAPTCHA from "react-google-recaptcha";

export default function App() {
  useEffect(() => {
    // Anti-Tamper: Disable Right Click
    const handleContextMenu = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handleContextMenu);

    // Anti-Tamper: Disable common DevTools shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && (e.key === "I" || e.key === "J" || e.key === "C")) ||
        (e.ctrlKey && e.key === "U")
      ) {
        e.preventDefault();
        window.location.reload(); // Crash/Reload on attempt
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    // Anti-Tamper: Debugger Trap
    // const debuggerLoop = setInterval(() => {
    //   const startTime = performance.now();
    //   debugger;
    //   const endTime = performance.now();
    //   if (endTime - startTime > 100) {
    //     // DevTools is likely open
    //     window.location.reload();
    //   }
    // }, 1000);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      // clearInterval(debuggerLoop);
    };
  }, []);

  return (
    <Router>
      <AuthProvider>
        <Toaster position="top-center" richColors />
        <Routes>
          <Route path="/" element={<UserLoginPage />} />
          <Route path="/admin-login" element={<AdminLoginPage />} />
          <Route path="/admin-auth" element={<AdminAuthPage />} />
          <Route path="/admin" element={
            <ProtectedRoute role="admin"><AdminPanel /></ProtectedRoute>
          } />
          <Route path="/viewer" element={
            <ProtectedRoute role="user"><EmailViewer /></ProtectedRoute>
          } />
        </Routes>
      </AuthProvider>
    </Router>
  );
}

const ProtectedRoute = ({ children, role }: { children: React.ReactNode, role: "admin" | "user" }) => {
  const { user, loading } = useAuth();
  if (loading) return <div>Loading...</div>;
  if (!user) return <Navigate to={role === "admin" ? "/admin-login" : "/"} />;
  if (role === "admin" && user.role !== "admin") return <Navigate to="/" />;
  return <>{children}</>;
};


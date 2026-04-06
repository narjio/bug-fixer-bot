import React, { useState, useEffect } from "react";
import { Mail, RefreshCw, ShieldCheck, Clock, AlertCircle, Copy, Check, ArrowLeft, User, Lock, Send, Key, LogOut, Settings, Plus, Users, Trash2, CheckCircle2, X } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { db, auth } from "./firebase";
import { collection, query, where, getDocs, addDoc, serverTimestamp, doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import { generateSecret, generateURI, verify } from "otplib";
import { QRCodeSVG } from "qrcode.react";

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

// --- Components ---

function UserLoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const navigate = useNavigate();

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
      const q = query(collection(db, "users"), where("username", "==", username), where("password", "==", password), where("role", "==", "user"));
      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        throw new Error("Invalid username or password");
      }

      const userData = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as UserData;
      
      await fetch("/api/auth/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, name: userData.name, status: "success" }),
      });

      localStorage.setItem("user", JSON.stringify(userData));
      navigate("/viewer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      await fetch("/api/auth/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, status: "failed" }),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl"
      >
        <div className="flex justify-center mb-8">
          <div className="bg-red-600 p-4 rounded-2xl shadow-lg shadow-red-200 cursor-pointer" onClick={() => navigate("/admin-login")}>
            <Mail className="text-white w-8 h-8" />
          </div>
        </div>
        <h2 className="text-2xl font-black text-center text-slate-900 mb-2">Netflix OTP Access</h2>
        <p className="text-slate-500 text-center text-sm mb-8">Enter your credentials to continue</p>

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
      const q = query(collection(db, "users"), where("username", "==", username));
      const snapshot = await getDocs(q);

      let userData: UserData;

      if (snapshot.empty) {
        if (username === "omdevsinhgohil538@gmail.com") {
          const res = await fetch("/api/admin/bootstrap", { method: "POST" });
          const { password: initialPassword } = await res.json();

          if (password === initialPassword) {
            const docRef = await addDoc(collection(db, "users"), {
              username,
              password: initialPassword,
              name: "Administrator",
              role: "admin"
            });
            
            await fetch("/api/admin/reset", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username, password: initialPassword, type: "initial" }),
            });
            
            userData = { id: docRef.id, username, password: initialPassword, name: "Administrator", role: "admin" } as UserData;
            toast.success("Admin account initialized successfully!");
          } else {
            throw new Error("Invalid admin credentials");
          }
        } else {
          throw new Error("Invalid admin credentials");
        }
      } else {
        const userDoc = snapshot.docs[0];
        userData = { id: userDoc.id, ...userDoc.data() } as UserData;

        if (userData.password !== password) {
          throw new Error("Invalid admin credentials");
        }

        if (userData.role !== "admin" && userData.username !== "omdevsinhgohil538@gmail.com") {
          throw new Error("Access denied. Not an admin account.");
        }

        if (userData.username === "omdevsinhgohil538@gmail.com" && userData.role !== "admin") {
          await setDoc(doc(db, "users", userDoc.id), { role: "admin" }, { merge: true });
          userData.role = "admin";
        }
      }
      
      await fetch("/api/auth/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, name: userData.name, status: "success", type: "admin" }),
      });

      localStorage.setItem("user", JSON.stringify(userData));
      toast.success("Login successful. Proceeding to 2FA.");
      navigate("/admin-auth");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Login failed";
      setError(errorMsg);
      toast.error(errorMsg);
      await fetch("/api/auth/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, status: "failed", type: "admin" }),
      });
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
        className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl border-t-8 border-red-600"
      >
        <div className="flex justify-center mb-8">
          <div className="bg-slate-900 p-4 rounded-2xl shadow-lg">
            <ShieldCheck className="text-white w-8 h-8" />
          </div>
        </div>
        <h2 className="text-2xl font-black text-center text-slate-900 mb-2">Admin Access</h2>
        <p className="text-slate-500 text-center text-sm mb-8">Secure administrator login</p>

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

  const user = JSON.parse(localStorage.getItem("user") || "{}");

  useEffect(() => {
    if (!user || (user.role !== "admin" && user.username !== "omdevsinhgohil538@gmail.com")) {
      navigate("/admin-login");
      return;
    }

    if (step === 1) {
      fetch("/api/admin/request-otp", { method: "POST" });
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
      // Save secret to user doc
      setDoc(doc(db, "users", user.id), { totpSecret: secret }, { merge: true });
      
      // Update local storage user
      const updatedUser = { ...user, totpSecret: secret };
      localStorage.setItem("user", JSON.stringify(updatedUser));
    }
  }, [step]);

  const verifyTelegramOtp = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp }),
      });
      if (!res.ok) throw new Error("Invalid OTP");
      setStep(2);
    } catch (err) {
      setError("Invalid Telegram OTP");
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
      if (result.valid) {
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
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white w-full max-w-md rounded-3xl p-8 shadow-2xl"
      >
        <h2 className="text-2xl font-black text-center mb-2">3-Factor Authentication</h2>
        <p className="text-slate-500 text-center text-sm mb-8">
          {step === 1 ? "Enter the OTP sent to your Telegram" : "Enter code from Google Authenticator"}
        </p>

        {step === 1 ? (
          <div className="space-y-4">
            <div className="relative">
              <Send className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 outline-none"
                placeholder="Telegram OTP"
              />
            </div>
            <button
              onClick={verifyTelegramOtp}
              disabled={loading}
              className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify Telegram"}
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {qrCode && (
              <div className="flex flex-col items-center bg-slate-50 p-6 rounded-2xl border border-slate-100">
                <p className="text-xs font-bold text-slate-400 uppercase mb-4">Scan with Google Authenticator</p>
                <QRCodeSVG value={qrCode} size={160} />
                <div className="mt-4 w-full">
                  <p className="text-xs text-slate-500 text-center mb-2">Or enter this key manually:</p>
                  <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl p-3">
                    <code className="text-sm font-mono text-slate-800 tracking-wider">{secretKey}</code>
                    <button 
                      onClick={copyToClipboard}
                      className="text-slate-400 hover:text-slate-600 transition-colors"
                      title="Copy to clipboard"
                    >
                      {copied ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <Copy className="w-5 h-5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
            <div className="relative">
              <Key className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input
                type="text"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                className="w-full bg-slate-50 border border-slate-100 rounded-2xl py-4 pl-12 pr-4 focus:ring-2 focus:ring-red-500 outline-none"
                placeholder="6-digit code"
              />
            </div>
            <button
              onClick={verifyTotp}
              disabled={loading}
              className="w-full bg-slate-900 text-white font-bold py-4 rounded-2xl disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify & Enter Admin"}
            </button>
          </div>
        )}
        {error && <p className="text-red-500 text-center text-xs mt-4 font-bold">{error}</p>}
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
    };
    fetchData();
  }, []);

  const saveRecaptchaSettings = async () => {
    await setDoc(doc(db, "settings", "recaptcha"), { siteKey, secretKey }, { merge: true });
    toast.success("ReCAPTCHA settings saved successfully!");
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
      <header className="bg-white border-b p-4 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <h1 className="text-xl font-black flex items-center gap-2">
            <Settings className="w-6 h-6 text-red-600" />
            Admin Control Panel
          </h1>
          <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full">
            <LogOut className="w-5 h-5 text-slate-400" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1 space-y-6">
          <section className="bg-white p-6 rounded-3xl border shadow-sm">
            <h2 className="font-black text-lg mb-6 flex items-center gap-2">
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

          <section className="bg-white p-6 rounded-3xl border shadow-sm">
            <h2 className="font-black text-lg mb-6 flex items-center gap-2">
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

        <div className="lg:col-span-2">
          <section className="bg-white p-6 rounded-3xl border shadow-sm h-full">
            <h2 className="font-black text-lg mb-6 flex items-center gap-2">
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
  const [countdown, setCountdown] = useState(30);
  const navigate = useNavigate();

  const user = JSON.parse(localStorage.getItem("user") || "{}");

  const fetchEmails = async (isManual = false) => {
    if (loading && isManual) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/emails");
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to fetch emails");
      }
      const data = await response.json();
      setEmails(data);
      setLastUpdated(new Date());
      setCountdown(30);
      
      if (selectedEmail) {
        const updated = data.find((e: Email) => e.id === selectedEmail.id);
        if (updated) setSelectedEmail(updated);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unknown error occurred");
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
          return 30;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
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
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-red-600 p-2 rounded-lg">
              <Mail className="text-white w-5 h-5" />
            </div>
            <h1 className="font-bold text-xl tracking-tight hidden sm:block">Netflix OTP Viewer</h1>
            <div className="ml-4 flex items-center gap-2 bg-slate-100 px-3 py-1 rounded-full">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              <span className="text-xs font-bold text-slate-600">{user.name}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end mr-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase">Next Refresh</span>
              <span className="text-sm font-mono font-bold text-red-600">{countdown}s</span>
            </div>
            <button
              onClick={handleManualRefresh}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 bg-slate-900 text-white rounded-full text-sm font-bold hover:bg-slate-800 transition-all disabled:opacity-50 active:scale-95"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              <span className="hidden sm:inline">Refresh Now</span>
            </button>
            <button onClick={() => { localStorage.clear(); navigate("/"); }} className="p-2 hover:bg-slate-100 rounded-full">
              <LogOut className="w-5 h-5 text-slate-400" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className={`${selectedEmail ? 'hidden lg:block' : 'block'} lg:col-span-5 xl:col-span-4 space-y-6`}>
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5 flex items-center gap-4">
              <div className="bg-green-100 p-3 rounded-xl">
                <ShieldCheck className="text-green-600 w-6 h-6" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-slate-800">System Active</h2>
                <p className="text-xs text-slate-500">Monitoring Netflix OTPs securely</p>
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
                    <p className="text-xs text-slate-400 font-medium">Waiting for Netflix OTP emails...</p>
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
                          Netflix Official
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

          <div className={`${selectedEmail ? 'block' : 'hidden lg:flex'} lg:col-span-7 xl:col-span-8 flex-col h-[calc(100vh-12rem)] min-h-[600px]`}>
            {selectedEmail ? (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                className="bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col h-full overflow-hidden"
              >
                <div className="p-6 border-b border-slate-100 bg-white sticky top-0 z-10">
                  <div className="flex items-center gap-4 mb-6">
                    <button 
                      onClick={() => setSelectedEmail(null)}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full transition-colors font-bold text-sm active:scale-95"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back to Inbox
                    </button>
                  </div>

                  <h2 className="text-2xl font-bold text-slate-900 mb-4 leading-tight">
                    {selectedEmail.subject}
                  </h2>
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600 font-bold text-lg">
                        N
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900">Netflix Support</span>
                          <span className="text-xs text-slate-400">Verified Sender</span>
                        </div>
                        <p className="text-xs text-slate-500 italic">Recipient: Protected Account</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-slate-400">
                        {new Date(selectedEmail.date).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-auto p-6 bg-white">
                  {selectedEmail.otp && (
                    <div className="mb-8 bg-slate-900 rounded-2xl p-6 text-center shadow-xl shadow-slate-200 relative overflow-hidden">
                      <div className="relative z-10">
                        <p className="text-slate-400 text-xs font-bold uppercase tracking-[0.2em] mb-2">
                          Detected OTP Code
                        </p>
                        <div className="text-5xl font-mono font-black text-white tracking-widest mb-4">
                          {selectedEmail.otp}
                        </div>
                        <button
                          onClick={() => copyOtp(selectedEmail.otp!)}
                          className="flex items-center gap-2 mx-auto px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-full font-bold transition-all transform active:scale-95"
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
                      <div className="absolute top-0 right-0 p-4 opacity-10">
                        <ShieldCheck className="w-24 h-24 text-white" />
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
              <div className="bg-white rounded-2xl border border-dashed border-slate-200 flex flex-col items-center justify-center h-full text-center p-12">
                <div className="bg-slate-50 w-20 h-20 rounded-full flex items-center justify-center mb-6">
                  <Mail className="text-slate-200 w-10 h-10" />
                </div>
                <h3 className="text-xl font-bold text-slate-800 mb-2">Select an email to read</h3>
                <p className="text-slate-400 max-w-xs mx-auto">
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
        }
        .gmail-style-content img {
          max-width: 100%;
          height: auto;
        }
        .gmail-style-content a {
          color: #e11d48;
          text-decoration: underline;
        }
        .gmail-style-content table {
          max-width: 100% !important;
          width: 100% !important;
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
    const debuggerLoop = setInterval(() => {
      const startTime = performance.now();
      debugger;
      const endTime = performance.now();
      if (endTime - startTime > 100) {
        // DevTools is likely open
        window.location.reload();
      }
    }, 1000);

    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
      document.removeEventListener("keydown", handleKeyDown);
      clearInterval(debuggerLoop);
    };
  }, []);

  return (
    <Router>
      <Toaster position="top-center" richColors />
      <Routes>
        <Route path="/" element={<UserLoginPage />} />
        <Route path="/admin-login" element={<AdminLoginPage />} />
        <Route path="/admin-auth" element={<AdminAuthPage />} />
        <Route path="/admin" element={
          localStorage.getItem("admin_auth") === "true" ? <AdminPanel /> : <Navigate to="/admin-login" />
        } />
        <Route path="/viewer" element={
          localStorage.getItem("user") ? <EmailViewer /> : <Navigate to="/" />
        } />
      </Routes>
    </Router>
  );
}

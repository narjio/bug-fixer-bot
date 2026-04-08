/**
 * Cloudflare Worker — Email Cache Proxy (Security Hardened)
 * 
 * - Validates session tokens (HMAC-SHA256)
 * - Rate limits requests per IP
 * - Passes user's assigned accounts to backend
 * 
 * Environment Variables:
 *   SUPABASE_URL, SUPABASE_KEY, SESSION_SECRET
 * 
 * KV Namespace Binding:
 *   EMAIL_CACHE
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Token",
};

const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
const STALE_SECONDS = 10;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60; // seconds

// --- HMAC Session Token Verification ---
async function verifySessionToken(token, secret) {
  try {
    const [dataB64, sigHex] = token.split(".");
    if (!dataB64 || !sigHex) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sig = new Uint8Array(sigHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(dataB64));
    if (!valid) return null;
    const payload = JSON.parse(atob(dataB64));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// --- Rate Limiting via KV ---
async function checkRateLimit(env, ip) {
  if (!env.EMAIL_CACHE) return true;
  const key = `rate:${ip}`;
  const current = await env.EMAIL_CACHE.get(key);
  const count = current ? parseInt(current) : 0;
  if (count >= RATE_LIMIT_MAX) return false;
  await env.EMAIL_CACHE.put(key, (count + 1).toString(), { expirationTtl: RATE_LIMIT_WINDOW });
  return true;
}

function getClientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const ip = getClientIp(request);

    // Rate limit check
    const allowed = await checkRateLimit(env, ip);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Try again later." }), {
        status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Authenticate: require session token
    const sessionToken = request.headers.get("X-Session-Token") || request.headers.get("x-session-token");
    let session = null;

    if (sessionToken && env.SESSION_SECRET) {
      session = await verifySessionToken(sessionToken, env.SESSION_SECRET);
    }

    // For /api/emails and /api/emails/sync, require valid session
    if ((url.pathname === "/api/emails" || url.pathname === "/api/emails/sync") && !session) {
      // Allow unauthenticated access if SESSION_SECRET is not configured (backward compat)
      if (env.SESSION_SECRET) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }

    if (url.pathname === "/api/emails" && request.method === "GET") {
      return handleGetEmails(env, session);
    }

    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      return handleSync(env, session);
    }

    if (url.pathname === "/api/debug" && request.method === "GET") {
      return handleDebug(env);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};

async function handleGetEmails(env, session) {
  if (!env.EMAIL_CACHE) {
    return fetchDirectFromSupabase(env, session);
  }

  // Use per-user cache key if user has assigned accounts
  const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
  const cacheKey = `${CACHE_KEY}:${userAccountsKey}`;
  const tsKey = `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`;

  const [cached, timestamp] = await Promise.all([
    env.EMAIL_CACHE.get(cacheKey),
    env.EMAIL_CACHE.get(tsKey),
  ]);

  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  if (!cached) {
    await refreshFromSupabase(env, session, cacheKey, tsKey);
    const freshData = await env.EMAIL_CACHE.get(cacheKey);
    return new Response(freshData || "[]", {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache-Age": "0" },
    });
  }

  if (age > STALE_SECONDS) {
    await env.EMAIL_CACHE.put(tsKey, now.toString());
    refreshFromSupabase(env, session, cacheKey, tsKey).catch(err => console.error("BG refresh error:", err));
  }

  return new Response(cached, {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache-Age": Math.round(age).toString() },
  });
}

async function handleSync(env, session) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "apikey": env.SUPABASE_KEY,
    };
    if (session) {
      headers["X-Session-Token"] = JSON.stringify(session);
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST", headers, body: JSON.stringify({ mode: "sync" }),
    });

    const responseText = await res.text();

    if (!res.ok) {
      // Pass through real upstream error
      let errorMsg = "Sync failed";
      try {
        const parsed = JSON.parse(responseText);
        errorMsg = parsed?.error || errorMsg;
      } catch {}
      return new Response(JSON.stringify({ success: false, error: errorMsg }), {
        status: res.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (env.EMAIL_CACHE) {
      const userAccountsKey = session?.assignedAccounts ? JSON.stringify(session.assignedAccounts.sort()) : "all";
      await refreshFromSupabase(env, session, `${CACHE_KEY}:${userAccountsKey}`, `${CACHE_TIMESTAMP_KEY}:${userAccountsKey}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message || "Sync request failed" }), {
      status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

async function handleDebug(env) {
  const info = {
    has_supabase_url: !!env.SUPABASE_URL,
    has_supabase_key: !!env.SUPABASE_KEY,
    has_session_secret: !!env.SESSION_SECRET,
    has_kv_binding: !!env.EMAIL_CACHE,
    timestamp: new Date().toISOString(),
  };
  return new Response(JSON.stringify(info, null, 2), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function fetchDirectFromSupabase(env, session) {
  try {
    const bodyPayload = { mode: "cache" };
    if (session?.assignedAccounts) {
      bodyPayload.accountLabels = session.assignedAccounts;
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify(bodyPayload),
    });
    const data = await res.text();
    return new Response(data, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "X-Cache": "bypass" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

async function refreshFromSupabase(env, session, cacheKey, tsKey) {
  try {
    const bodyPayload = { mode: "cache" };
    if (session?.assignedAccounts) {
      bodyPayload.accountLabels = session.assignedAccounts;
    }

    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      console.error("Supabase cache fetch failed:", res.status);
      return;
    }

    const data = await res.text();

    if (env.EMAIL_CACHE) {
      await Promise.all([
        env.EMAIL_CACHE.put(cacheKey, data),
        env.EMAIL_CACHE.put(tsKey, Date.now().toString()),
      ]);
    }
  } catch (err) {
    console.error("Refresh from Supabase error:", err);
  }
}

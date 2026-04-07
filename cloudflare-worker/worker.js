/**
 * Cloudflare Worker — Email Cache Proxy
 * 
 * Eliminates Supabase egress by caching email data in Cloudflare KV.
 * Users read from KV (free). Only this worker reads from Supabase (1 call per 10s max).
 * 
 * Environment Variables (set in Cloudflare dashboard):
 *   SUPABASE_URL  — e.g. https://xxxx.supabase.co
 *   SUPABASE_KEY  — anon/service key
 * 
 * KV Namespace Binding:
 *   EMAIL_CACHE   — bound in wrangler.toml
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const CACHE_KEY = "emails_list";
const CACHE_TIMESTAMP_KEY = "emails_timestamp";
const STALE_SECONDS = 10; // refresh from Supabase if data older than 10s

// Lock to prevent multiple simultaneous Supabase fetches
let refreshInProgress = false;

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // GET /api/emails — return cached emails from KV
    if (url.pathname === "/api/emails" && request.method === "GET") {
      return handleGetEmails(env);
    }

    // POST /api/emails/sync — trigger IMAP sync via Supabase Edge Function
    if (url.pathname === "/api/emails/sync" && request.method === "POST") {
      return handleSync(env);
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
};

async function handleGetEmails(env) {
  // 1. Read from KV instantly
  const [cached, timestamp] = await Promise.all([
    env.EMAIL_CACHE.get(CACHE_KEY),
    env.EMAIL_CACHE.get(CACHE_TIMESTAMP_KEY),
  ]);

  const now = Date.now();
  const age = timestamp ? (now - parseInt(timestamp)) / 1000 : Infinity;

  // 2. If stale (>10s), refresh from Supabase in background
  if (age > STALE_SECONDS && !refreshInProgress) {
    // Use waitUntil-like pattern: don't block the response
    refreshFromSupabase(env).catch(err => console.error("BG refresh error:", err));
  }

  // 3. Return cached data immediately (or empty array if no cache yet)
  const data = cached || "[]";
  return new Response(data, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "X-Cache-Age": Math.round(age).toString(),
    },
  });
}

async function handleSync(env) {
  try {
    // Trigger IMAP sync on Supabase Edge Function
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify({ mode: "sync" }),
    });

    const data = await res.text();

    // After sync, refresh KV cache from Supabase DB
    await refreshFromSupabase(env);

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Sync error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

async function refreshFromSupabase(env) {
  if (refreshInProgress) return;
  refreshInProgress = true;

  try {
    // Fetch cached emails from Supabase (mode: "cache" = DB read only, no IMAP)
    const res = await fetch(`${env.SUPABASE_URL}/functions/v1/fetch-emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SUPABASE_KEY}`,
        "apikey": env.SUPABASE_KEY,
      },
      body: JSON.stringify({ mode: "cache" }),
    });

    if (!res.ok) {
      console.error("Supabase cache fetch failed:", res.status);
      return;
    }

    const data = await res.text();

    // Store in KV with no expiration (we manage freshness via timestamp)
    await Promise.all([
      env.EMAIL_CACHE.put(CACHE_KEY, data),
      env.EMAIL_CACHE.put(CACHE_TIMESTAMP_KEY, Date.now().toString()),
    ]);

    console.log("KV cache refreshed from Supabase");
  } catch (err) {
    console.error("Refresh from Supabase error:", err);
  } finally {
    refreshInProgress = false;
  }
}

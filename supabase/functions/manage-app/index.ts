import { createClient } from "npm:@supabase/supabase-js@2";
import { compare, hash } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const { action, ...params } = await req.json();

    if (action === "list") {
      const { data, error } = await supabase
        .from("app_users")
        .select("id, username, name, role")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true, users: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      const { username, password } = params;
      if (!username || !password) throw new Error("Username and password required");

      const { data: user, error } = await supabase
        .from("app_users")
        .select("*")
        .eq("username", username)
        .single();

      if (error || !user) throw new Error("Invalid username or password");

      const isHashed = user.password.startsWith("$2");
      const passwordMatch = isHashed
        ? await compare(password, user.password)
        : password === user.password;

      if (!passwordMatch) throw new Error("Invalid username or password");

      // Upgrade plain text to hash
      if (!isHashed) {
        const hashed = await hash(password);
        await supabase.from("app_users").update({ password: hashed }).eq("id", user.id);
      }

      return new Response(JSON.stringify({
        success: true,
        user: { id: user.id, username: user.username, name: user.name, role: user.role, totpSecret: user.totp_secret },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "create") {
      const { username, password, name, role } = params;
      if (!username || !password || !name) throw new Error("All fields required");

      const hashed = await hash(password);
      const { data, error } = await supabase
        .from("app_users")
        .insert({ username, password: hashed, name, role: role || "user" })
        .select("id, username, name, role")
        .single();
      if (error) throw error;

      return new Response(JSON.stringify({ success: true, user: data }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete") {
      const { id } = params;
      const { error } = await supabase.from("app_users").delete().eq("id", id);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "update_totp") {
      const { id, totp_secret } = params;
      const { error } = await supabase.from("app_users").update({ totp_secret }).eq("id", id);
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // OTP actions
    if (action === "create_otp") {
      const { user_id, otp } = params;
      // Delete old OTPs for this user
      await supabase.from("app_otps").delete().eq("user_id", user_id);
      const { error } = await supabase.from("app_otps").insert({ user_id, otp });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "verify_otp") {
      const { user_id, otp } = params;
      const { data, error } = await supabase
        .from("app_otps")
        .select("*")
        .eq("user_id", user_id)
        .eq("otp", otp)
        .gte("expires_at", new Date().toISOString())
        .single();

      if (error || !data) throw new Error("Invalid or expired OTP");

      await supabase.from("app_otps").delete().eq("id", data.id);
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Settings actions
    if (action === "get_settings") {
      const { key } = params;
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", key)
        .single();
      return new Response(JSON.stringify({ success: true, value: data?.value || null }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "set_settings") {
      const { key, value } = params;
      const { error } = await supabase
        .from("app_settings")
        .upsert({ key, value }, { onConflict: "key" });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Unknown action: " + action);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

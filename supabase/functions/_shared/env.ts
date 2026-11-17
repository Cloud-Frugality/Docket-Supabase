export interface EnvVars {
  supabaseUrl: string;
  secretKey: string;
  publishableKey: string;
}

export function getEnvVars(): EnvVars | { error: string; status: 500 } {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const secretKey = Deno.env.get("SUPABASE_SECRET_KEY")
    ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    ?? "";
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY")
    ?? Deno.env.get("SUPABASE_ANON_KEY")
    ?? "";

  if (!supabaseUrl || !secretKey || !publishableKey) {
    return { error: "Supabase environment variables are not configured.", status: 500 as const };
  }

  return { supabaseUrl, secretKey, publishableKey };
}
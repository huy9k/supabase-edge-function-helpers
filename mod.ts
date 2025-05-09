import "jsr:@supabase/functions-js@2.4.4/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2.49.4";

/**
 * --------------------------------------------------------------------
 *
 *    CORS
 *
 * --------------------------------------------------------------------
 */

/**
 * CORS headers for Supabase Edge Functions
 */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, prefer, x-supabase-auth, x-supabase-client, x-supabase-version",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

/**
 * Handles CORS preflight requests for Supabase Edge Functions.
 * Returns a 204 response if the request is OPTIONS, otherwise null.
 */
export const handleCors = (req: Request): Response | null => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }
  return null;
};

/**
 * --------------------------------------------------------------------
 *
 *    SUPABASE Client
 *
 * --------------------------------------------------------------------
 */

/**
 * Preset Supabase client creators for admin, user, and anon contexts.
 */
export const clientPresets = {
  /**
   * Creates an admin Supabase client using the service role key.
   */
  admin: (): SupabaseClient =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    ),

  /**
   * Creates a user Supabase client with a JWT token.
   * @param token - The user's JWT token
   */
  user: (token: string): SupabaseClient =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    ),

  /**
   * Creates an anonymous Supabase client.
   */
  anon: (): SupabaseClient =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ),
};

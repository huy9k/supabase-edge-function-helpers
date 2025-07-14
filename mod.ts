import "jsr:@supabase/functions-js@2.4.5/edge-runtime.d.ts";
import {
  createClient,
  SupabaseClient,
  User,
} from "jsr:@supabase/supabase-js@2.51.0";

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
   * Asynchronously creates a user Supabase client from a Request object.
   * Extracts the Bearer token from the Authorization header and checks user existence.
   * Throws an error if the header is missing, malformed, or the user does not exist.
   * Returns a tuple: [client, user].
   * @param req - The incoming Request object
   */
  user: async (req: Request): Promise<[SupabaseClient, User]> => {
    // Get the Authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing Authorization header");
    const token = authHeader.replace("Bearer ", "");

    // Create a new Supabase client
    const client = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } }
    );

    // Get the user from the Supabase client
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) throw new Error("Invalid or missing user");

    // Return the client and user
    return [client, data.user];
  },

  /**
   * Creates an anonymous Supabase client.
   */
  anon: (): SupabaseClient =>
    createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!
    ),
};

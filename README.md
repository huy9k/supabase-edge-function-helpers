# supabase-edge-function-helpers

Elegant helpers for Supabase Edge Functions with Deno, including CORS handling and typed Supabase client presets.

---

## Installation

```sh
denopm add @huy9k/supabase-edge-function-helpers
# or
npx jsr add @huy9k/supabase-edge-function-helpers
```

---

## Usage

### CORS Handling

```ts
import { corsHeaders, handleCors } from "jsr:@huy9k/supabase-edge-function-helpers";

Deno.serve(async (req) => {
  // Handle CORS preflight
  const cors = handleCors(req);
  if (cors) return cors;

  // ...your logic...
  return new Response("Hello", { headers: corsHeaders });
});
```

### Supabase Client Presets

```ts
import { clientPresets } from "jsr:@huy9k/supabase-edge-function-helpers";

// Admin client (service role)
const adminClient = clientPresets.admin();

// User client (from Request, async)
const userClient = await clientPresets.user(req);

// Anonymous client
const anonClient = clientPresets.anon();
```

---

## API Reference

### `corsHeaders: Record<string, string>`
CORS headers for Supabase Edge Functions. Use in all responses.

### `handleCors(req: Request): Response | null`
Returns a 204 CORS preflight response if `req.method === "OPTIONS"`, otherwise `null`.

### `clientPresets`
- `admin(): SupabaseClient` — Uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from env.
- `user(req: Request): Promise<SupabaseClient>` — Extracts Bearer token from the Authorization header, checks user existence, and returns a client if valid. Throws if invalid or missing.
- `anon(): SupabaseClient` — Uses `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

---

## Environment Variables
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

These must be set in your Edge Function environment.

---

## Compatibility
- Designed for [Supabase Edge Functions](https://supabase.com/docs/guides/functions) and Deno Deploy.
- Requires Deno runtime and access to `Deno.env`.
- All imports are version-pinned for JSR compatibility.

---

## License
MIT
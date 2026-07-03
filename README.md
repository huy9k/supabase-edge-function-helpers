# supabase-edge-function-helpers

A thin wrapper for **Supabase Edge Functions** that need WebSocket streaming with JWT auth, CORS, and a warmup session gate.

Designed to pair with clients that speak the **edge-stream protocol** (`client_warmup` → `client_message`, server `status` / `response_text` / `complete` / `error`).

This is intended to be used with [https://www.npmjs.com/package/supabase-edge-function-continuous-stream](https://www.npmjs.com/package/supabase-edge-function-continuous-stream).

> **v5 is a breaking rewrite.** Versions before 5.0.0 exported `clientPresets`, `handleCors`, and manual helpers. v5 exports only `withWebSocketSupabase` and related utilities. See [Migration](#migration-from-v4).

## Install

Add to `deno.json`:

```json
{
  "imports": {
    "supabase-edge-function-helpers": "jsr:@huy9k/supabase-edge-function-helpers@^5"
  }
}
```

## Quick start

```ts
import type { SupabaseContext } from "npm:@supabase/server";
import {
  withWebSocketSupabase,
  type EdgeStreamSend,
} from "supabase-edge-function-helpers";

type MySession = { history: Array<{ role: string; content: string }> };

export default {
  fetch: withWebSocketSupabase<MySession>(
    { auth: "user" },
    {
      onWarmup: async (_warmup, ctx) => {
        // Authz + one-time setup — return null to deny, or session to open the gate
        const { data: profile } = await ctx.supabaseAdmin
          .from("profiles")
          .select("role")
          .eq("id", ctx.userClaims!.id)
          .single();

        if (profile?.role !== "faculty") return null;

        return { history: [] };
      },

      onMessage: async (action, body, { ctx, send, session }) => {
        if (action !== "my-action") {
          send("error", `Action ${action} not allowed`);
          return;
        }
        await handleAction(body, session, ctx, send);
      },
    },
  ),
};
```

## API

### `withWebSocketSupabase<TSession>(config, handlers)`

Returns a `fetch` handler for `export default { fetch }`.

| Option                    | Description                                                            |
| ------------------------- | ---------------------------------------------------------------------- |
| `config.auth`             | `"user"` — JWT verified via `@supabase/server`                         |
| `config.cors`             | `true` (default), `false`, or custom header map                        |
| `config.onHttp`           | Optional HTTP handler for non-WebSocket requests                       |
| `handlers.onWarmup`       | Runs once per socket on `client_warmup`                                |
| `handlers.onSessionReady` | Optional — runs after `ready`, with `send` + session (fire-and-forget) |
| `handlers.onMessage`      | Runs on `client_message` only after successful warmup                  |

### `onWarmup(warmup, ctx) → TSession | null`

- Return a **session object** to open the gate (`status: ready`).
- Return **`null`** → client receives `error: Unauthorized`.
- **Throw** → client receives `error: <message>`.

Use warmup for anything you want to pay once per connection: authorization, DB lookups, cached context for later messages. Authorization is not special — it is just logic inside `onWarmup`.

### `onSessionReady(warmup, { ctx, send, session })` (optional)

Runs **after** `status: ready` is sent, with full stream access. Invoked fire-and-forget — errors are sent as `error` on the socket.

Use for server-driven work on reconnect (e.g. resume an interrupted long-running turn) without requiring a new `client_message`.

### `onMessage(action, body, { ctx, send, session })`

- `action` — string from `body.action`.
- `session` — cached result from `onWarmup` (guaranteed non-null).
- `send(type, data)` — emits `{ type, data }` JSON on the socket.

Common server message types:

| `type`          | Typical `data`                          |
| --------------- | --------------------------------------- |
| `status`        | `"context"`, `"ready"`, `"thinking"`, … |
| `response_text` | accumulated reply string                |
| `complete`      | `{ reply: string, … }`                  |
| `error`         | error message string                    |

### `extractWebSocketToken(req) → string | null`

Reads JWT from (in order):

1. `Authorization: Bearer …`
2. `?jwt=…` query param (browser WebSocket upgrades)
3. `Sec-WebSocket-Protocol: token=<jwt>`

**Does not clone the request** — safe to use before `Deno.upgradeWebSocket`.

### `EdgeStreamSend`

```ts
type EdgeStreamSend = (type: string, data: unknown) => void;
```

## Wire protocol

**Client → server**

```json
{ "type": "client_warmup", "data": { … } }
{ "type": "client_message", "data": { "action": "…", … } }
```

**Server → client**

```json
{ "type": "status", "data": "context" }
{ "type": "status", "data": "ready" }
{ "type": "response_text", "data": "…" }
{ "type": "complete", "data": { "reply": "…" } }
{ "type": "error", "data": "…" }
```

**Gate rules**

- `client_message` without a successful warmup → `Warmup required`
- `onWarmup` returns `null` → `Unauthorized`

## HTTP + WebSocket in one function

Pass `onHttp` for REST routes on the same edge function:

```ts
export default {
  fetch: withWebSocketSupabase<MySession>(
    {
      auth: "user",
      onHttp: async (req, ctx) => {
        if (req.method !== "POST") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        // use ctx.supabaseAdmin, ctx.userClaims, …
        return Response.json({ ok: true });
      },
    },
    { onWarmup, onMessage },
  ),
};
```

Non-WebSocket responses get CORS headers automatically. WebSocket `101` responses are returned **without** cloning (cloning breaks the live socket).

## Authentication notes

- Set `verify_jwt = false` in `config.toml` if you rely on this wrapper — it verifies JWT itself via `verifyCredentials`.
- Browsers cannot set `Authorization` on WebSocket upgrade; connect with `wss://…/functions/v1/my-fn?jwt=<access_token>`.

## Migration from v4

| v4                                              | v5                                 |
| ----------------------------------------------- | ---------------------------------- |
| `clientPresets.user(req)`                       | `ctx` from `withWebSocketSupabase` |
| `clientPresets.admin()`                         | `ctx.supabaseAdmin`                |
| `handleCors(req)`                               | built into wrapper                 |
| Manual `Deno.upgradeWebSocket` + message switch | `onWarmup` / `onMessage`           |
| Messages without warmup allowed                 | Warmup required (session gate)     |

## License

MIT

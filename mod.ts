import type { SupabaseContext } from "npm:@supabase/server@^1";
import { corsHeaders } from "npm:@supabase/supabase-js@^2/cors";
import {
  createAdminClient,
  createContextClient,
  verifyCredentials,
} from "npm:@supabase/server@^1/core";

type CorsConfig = boolean | Record<string, string>;

type WebSocketSupabaseConfig = {
  auth: "user";
  cors?: CorsConfig;
  onHttp?: (req: Request, ctx: SupabaseContext) => Promise<Response>;
};

export type EdgeStreamSend = (type: string, data: unknown) => void;

/** Paragraph-based thinking events for live agent activity UI */
export type ThinkingStream = {
  paragraph: (text?: string) => void;
  delta: (text: string) => void;
  snapshot: (text: string) => void;
};

/** Emits paragraph-based thinking events for live agent activity UI */
export function createThinkingStream(send: EdgeStreamSend): ThinkingStream {
  return {
    paragraph(text = "") {
      send("thinking_paragraph", text);
    },
    delta(text: string) {
      send("thinking_delta", text);
    },
    snapshot(text: string) {
      send("thinking_snapshot", text);
    },
  };
}

type StreamMessageContext<TSession> = {
  ctx: SupabaseContext;
  send: EdgeStreamSend;
  session: TSession;
};

type WebSocketStreamHandlers<TSession> = {
  onWarmup: (
    warmup: unknown,
    ctx: SupabaseContext,
  ) => Promise<TSession | null> | TSession | null;
  /** Optional hook after session is ready — use for server-driven resume on reconnect */
  onSessionReady?: (
    warmup: unknown,
    stream: StreamMessageContext<TSession>,
  ) => Promise<void> | void;
  onMessage: (
    action: string,
    body: Record<string, unknown>,
    stream: StreamMessageContext<TSession>,
  ) => Promise<void> | void;
  /** Optional side channel during an in-flight client_message (e.g. stop / cancel) */
  onControl?: (
    action: string,
    body: Record<string, unknown>,
    stream: StreamMessageContext<TSession>,
  ) => Promise<void> | void;
};

/**
 * Builds CORS headers from config — mirrors withSupabase defaults.
 */
function buildCorsHeaders(
  cors: CorsConfig | undefined,
): Record<string, string> {
  if (cors === false) return {};
  if (typeof cors === "object") return cors;
  return corsHeaders;
}

/**
 * Appends CORS headers to a response — mirrors withSupabase.
 */
function addCorsHeaders(
  response: Response,
  cors: CorsConfig | undefined,
): Response {
  if (cors === false) return response;

  const headers = buildCorsHeaders(cors);
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    next.headers.set(key, value);
  }
  return next;
}

/**
 * Extracts a JWT from Authorization header, ?jwt= query, or WebSocket protocol.
 */
export function extractWebSocketToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }

  const url = new URL(req.url);
  const jwt = url.searchParams.get("jwt");
  if (jwt) return jwt;

  const protocol = req.headers.get("sec-websocket-protocol");
  return protocol?.match(/^token=(.+)$/)?.[1] ?? null;
}

/**
 * Authenticates a request and builds a SupabaseContext without cloning req.
 * Browsers send JWT via ?jwt= since WebSocket upgrades cannot set Authorization.
 */
async function createWebSocketSupabaseContext(
  req: Request,
  config: WebSocketSupabaseConfig,
): Promise<SupabaseContext | Response> {
  const token = extractWebSocketToken(req);
  const { data: auth, error } = await verifyCredentials(
    { token, apikey: null },
    { auth: config.auth },
  );

  if (error) {
    return Response.json(
      { message: error.message, code: error.code },
      {
        status: error.status,
        headers: config.cors !== false ? buildCorsHeaders(config.cors) : {},
      },
    );
  }

  return {
    supabase: createContextClient({ auth: { token: auth!.token! } }),
    supabaseAdmin: createAdminClient(),
    userClaims: auth!.userClaims,
    jwtClaims: auth!.jwtClaims ?? null,
    authMode: auth!.authMode,
    authKeyName: auth!.keyName ?? undefined,
  };
}

/** Reads optional top-level requestId from an inbound client envelope */
function readRequestId(message: { requestId?: unknown }): string | undefined {
  return typeof message.requestId === "string" ? message.requestId : undefined;
}

/** Builds a send that echoes requestId when the client provided one */
function bindScopedSend(
  socket: WebSocket,
  requestId: string | undefined,
): EdgeStreamSend {
  return (type, data) => {
    if (type === "error") console.error(data);
    socket.send(
      JSON.stringify(requestId ? { type, data, requestId } : { type, data }),
    );
  };
}

/**
 * Wires client_warmup / client_message / client_control with a per-socket session gate.
 */
function wireEdgeStreamSession<TSession>(
  socket: WebSocket,
  ctx: SupabaseContext,
  handlers: WebSocketStreamHandlers<TSession>,
): void {
  let session: TSession | null = null;

  // Unscoped send for warmup / onSessionReady (no requestId)
  const send: EdgeStreamSend = bindScopedSend(socket, undefined);

  socket.onmessage = async (e: MessageEvent) => {
    try {
      const message = JSON.parse(e.data);

      switch (message.type) {
        case "client_warmup":
          send("status", "context");
          try {
            const next = await handlers.onWarmup(message.data, ctx);
            if (next === null) {
              send("error", "Unauthorized");
              return;
            }
            session = next;
            send("status", "ready");
            if (handlers.onSessionReady) {
              void Promise.resolve(
                handlers.onSessionReady(message.data, { ctx, send, session }),
              ).catch((error: unknown) => {
                send(
                  "error",
                  error instanceof Error
                    ? error.message
                    : "Session ready failed",
                );
              });
            }
          } catch (error) {
            send(
              "error",
              error instanceof Error ? error.message : "Warmup failed",
            );
          }
          break;

        case "client_message": {
          const scopedSend = bindScopedSend(socket, readRequestId(message));
          if (session === null) {
            scopedSend("error", "Warmup required");
            return;
          }

          const body = message.data as Record<string, unknown>;
          const action = typeof body.action === "string" ? body.action : "";
          await handlers.onMessage(action, body, {
            ctx,
            send: scopedSend,
            session,
          });
          break;
        }

        case "client_control": {
          const scopedSend = bindScopedSend(socket, readRequestId(message));
          if (session === null) {
            scopedSend("error", "Warmup required");
            return;
          }

          if (!handlers.onControl) {
            scopedSend("error", "Control not supported");
            return;
          }

          const body = message.data as Record<string, unknown>;
          const action = typeof body.action === "string" ? body.action : "";
          await handlers.onControl(action, body, {
            ctx,
            send: scopedSend,
            session,
          });
          break;
        }

        default:
          send("error", "Invalid message type");
          break;
      }
    } catch (error) {
      send(
        "error",
        error instanceof Error ? error.message : "Failed to process message",
      );
    }
  };

  socket.onerror = (e: Event) => console.error("ws error", e);
}

/** Deno global exposed only inside the Supabase edge runtime */
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void };

/**
 * Prevents the platform supervisor from retiring this worker as "idle"
 * (EarlyDrop) once the 101 upgrade response is returned. Without this, a
 * long-running turn can get its socket killed mid-step at any point — not
 * just at the wall-clock limit — because the supervisor sees no outstanding
 * request/promise it's tracking. See:
 * https://supabase.com/docs/guides/troubleshooting/edge-functions-worker-timeouts-and-websocket-drops
 */
function keepWorkerAliveUntilSocketCloses(socket: WebSocket): void {
  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve());
  });
  EdgeRuntime.waitUntil(closed);
}

/**
 * Mirrors withSupabase for WebSocket edge functions.
 * Handles CORS, auth, context, upgrade, and the edge-stream protocol.
 */
export function withWebSocketSupabase<TSession>(
  config: WebSocketSupabaseConfig,
  handlers: WebSocketStreamHandlers<TSession>,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (config.cors !== false && req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(config.cors),
      });
    }

    const ctx = await createWebSocketSupabaseContext(req, config);
    if (ctx instanceof Response) return ctx;

    const upgrade = req.headers.get("upgrade") || "";
    if (upgrade.toLowerCase() === "websocket") {
      // idleTimeout: 0 disables the platform's own socket-level idle close —
      // long silent AI steps must not get the connection reaped mid-turn.
      const { socket, response } = Deno.upgradeWebSocket(req, {
        idleTimeout: 0,
      });
      wireEdgeStreamSession(socket, ctx, handlers);
      keepWorkerAliveUntilSocketCloses(socket);
      // Never clone 101 responses — addCorsHeaders breaks the live socket
      return response;
    }

    if (config.onHttp) {
      return addCorsHeaders(await config.onHttp(req, ctx), config.cors);
    }

    return addCorsHeaders(
      Response.json({ error: "Not found" }, { status: 404 }),
      config.cors,
    );
  };
}

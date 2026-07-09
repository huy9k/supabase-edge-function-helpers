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

/**
 * Wires client_warmup / client_message / client_control with a per-socket session gate.
 */
function wireEdgeStreamSession<TSession>(
  socket: WebSocket,
  ctx: SupabaseContext,
  handlers: WebSocketStreamHandlers<TSession>,
): void {
  let session: TSession | null = null;

  const send: EdgeStreamSend = (type, data) => {
    if (type === "error") console.error(data);
    socket.send(JSON.stringify({ type, data }));
  };

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
          if (session === null) {
            send("error", "Warmup required");
            return;
          }

          const body = message.data as Record<string, unknown>;
          const action = typeof body.action === "string" ? body.action : "";
          await handlers.onMessage(action, body, { ctx, send, session });
          break;
        }

        case "client_control": {
          if (session === null) {
            send("error", "Warmup required");
            return;
          }

          if (!handlers.onControl) {
            send("error", "Control not supported");
            return;
          }

          const body = message.data as Record<string, unknown>;
          const action = typeof body.action === "string" ? body.action : "";
          await handlers.onControl(action, body, { ctx, send, session });
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
      const { socket, response } = Deno.upgradeWebSocket(req);
      wireEdgeStreamSession(socket, ctx, handlers);
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

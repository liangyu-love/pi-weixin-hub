// ── Localhost Webhook API ──────────────────────────────────────────────
// A tiny HTTP server bound to 127.0.0.1 that lets Pi extensions, cron
// jobs, or CI send proactive messages to WeChat.
//
// Endpoints (all require `Authorization: Bearer <webhookToken>`):
//   POST /send    { user?, text }      → formatted text reply (with prefix)
//   POST /notify  { user?, text }      → plain informational push
//   POST /media   { user?, url, type?, caption? } → image/file message
//
// `user` is optional: omit it to target the default (most recent) sender.

import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

// ── Types ──────────────────────────────────────────────────────────────

export interface WebhookHandlers {
  sendText: (user: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sendNotify: (user: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sendMedia: (
    user: string,
    media: { type?: string; url: string; caption?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
}

export interface WebhookServer {
  port: number;
  close: () => Promise<void>;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Constant-time string comparison for the bearer token. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
      if (data.length > 256 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

// ── Server ─────────────────────────────────────────────────────────────

/**
 * Start the webhook HTTP server on 127.0.0.1.
 * Resolves once the server is listening (with the actual port).
 */
export function startWebhookServer(
  token: string,
  handlers: WebhookHandlers,
  port = 8787,
): Promise<WebhookServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }

        // ── Auth ────────────────────────────────────────────────────
        const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!auth || !tokenMatches(auth, token)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        // ── Body ────────────────────────────────────────────────────
        let payload: Record<string, unknown>;
        try {
          const raw = await readBody(req);
          payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch (err) {
          sendJson(res, err instanceof Error && err.message === "body too large" ? 413 : 400, {
            error: err instanceof Error ? err.message : "invalid body",
          });
          return;
        }

        const user = typeof payload.user === "string" ? payload.user : "";

        // ── Routes ──────────────────────────────────────────────────
        let result: { ok: boolean; error?: string };
        switch (req.url) {
          case "/send": {
            const text = typeof payload.text === "string" ? payload.text : "";
            if (!text.trim()) {
              sendJson(res, 400, { error: "text required" });
              return;
            }
            result = await handlers.sendText(user, text);
            break;
          }
          case "/notify": {
            const text = typeof payload.text === "string" ? payload.text : "";
            if (!text.trim()) {
              sendJson(res, 400, { error: "text required" });
              return;
            }
            result = await handlers.sendNotify(user, text);
            break;
          }
          case "/media": {
            const url = typeof payload.url === "string" ? payload.url : "";
            if (!url) {
              sendJson(res, 400, { error: "url required" });
              return;
            }
            result = await handlers.sendMedia(user, {
              type: typeof payload.type === "string" ? payload.type : undefined,
              url,
              caption: typeof payload.caption === "string" ? payload.caption : undefined,
            });
            break;
          }
          default:
            sendJson(res, 404, { error: "not found" });
            return;
        }

        sendJson(res, result.ok ? 200 : 502, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

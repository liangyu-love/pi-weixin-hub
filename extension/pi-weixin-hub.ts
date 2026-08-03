// ── pi-weixin-hub extension ────────────────────────────────────────────
// Lets Pi proactively send messages to WeChat through the pi-weixin-hub
// daemon's localhost webhook API.
//
// Install:
//   copy this file to ~/.pi/agent/extensions/pi-weixin-hub.ts
//   (or run: pi -e ./extension/pi-weixin-hub.ts)
//
// Requires the daemon running with webhook enabled:
//   pi-weixin-hub config set webhookPort 8787
//   pi-weixin-hub daemon
//
// Usage by the model (tool):
//   weixin_send({ text: "任务完成！", user?: "userId" })
//   weixin_media({ url: "https://...", type?: "image"|"file", caption?, user? })
//
// Usage by the user (commands):
//   /weixin-send <文本>      /weixin-media <URL> [type] [caption]

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Webhook config discovery ───────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), ".config", "pi-weixin-cli", "settings.json");

function loadWebhook(): { baseUrl: string; token: string } | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const port = Number(cfg.webhookPort ?? 0);
    const token = String(cfg.webhookToken ?? "");
    if (!port || !token) return null;
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  } catch {
    return null;
  }
}

async function webhookCall(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const wh = loadWebhook();
  if (!wh) {
    return { ok: false, error: "webhook 未启用（请先设置 webhookPort 并启动 daemon）" };
  }
  try {
    const resp = await fetch(`${wh.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${wh.token}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await resp.json().catch(() => ({}))) as { error?: string };
    return resp.ok ? { ok: true } : { ok: false, error: data.error ?? `HTTP ${resp.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ── Tool: model-callable proactive send ──────────────────────────────
  pi.registerTool("weixin_send", {
    description:
      "Send a text message to the user's WeChat through the pi-weixin-hub daemon. " +
      "Use for proactive notifications, progress updates, or delivering results " +
      "without waiting for the user to message you.",
    params: Type.Object({
      text: Type.String({ description: "Message text to send to WeChat" }),
      user: Type.Optional(Type.String({ description: "Target user id; omit for the default (most recent) user" })),
    }),
    async execute(
      _toolCallId: string,
      params: { text: string; user?: string },
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const res = await webhookCall("/send", { text: params.text, user: params.user });
      return {
        content: [
          {
            type: "text",
            text: res.ok ? "消息已发送到微信 ✅" : `发送失败: ${res.error ?? "未知错误"}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool("weixin_media", {
    description:
      "Send a media item (image or file URL) to the user's WeChat through the pi-weixin-hub daemon.",
    params: Type.Object({
      url: Type.String({ description: "Public URL of the image or file" }),
      type: Type.Optional(Type.String({ description: "image (default) or file" })),
      caption: Type.Optional(Type.String({ description: "File name or caption" })),
      user: Type.Optional(Type.String({ description: "Target user id; omit for default user" })),
    }),
    async execute(
      _toolCallId: string,
      params: { url: string; type?: string; caption?: string; user?: string },
      _signal: AbortSignal,
      _onUpdate: unknown,
      _ctx: unknown,
    ) {
      const res = await webhookCall("/media", {
        url: params.url,
        type: params.type ?? "image",
        caption: params.caption,
        user: params.user,
      });
      return {
        content: [
          {
            type: "text",
            text: res.ok ? "媒体已发送到微信 ✅" : `发送失败: ${res.error ?? "未知错误"}`,
          },
        ],
        details: {},
      };
    },
  });

  // ── Commands: user-callable ──────────────────────────────────────────
  pi.registerCommand("weixin-send", {
    description: "Send a text message to WeChat via the pi-weixin-hub daemon",
    handler: async (args: string, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("用法: /weixin-send <文本>", "warning");
        return;
      }
      const res = await webhookCall("/send", { text: args.trim() });
      ctx.ui.notify(
        res.ok ? "✅ 已发送到微信" : `❌ 发送失败: ${res.error ?? "未知错误"}`,
        res.ok ? "info" : "error",
      );
    },
  });

  pi.registerCommand("weixin-media", {
    description: "Send a media URL (image/file) to WeChat via the pi-weixin-hub daemon",
    handler: async (args: string, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const url = parts[0];
      if (!url) {
        ctx.ui.notify("用法: /weixin-media <URL> [image|file] [caption]", "warning");
        return;
      }
      const type = parts[1] === "file" ? "file" : "image";
      const caption = parts.slice(2).join(" ") || undefined;
      const res = await webhookCall("/media", { url, type, caption });
      ctx.ui.notify(
        res.ok ? "✅ 媒体已发送到微信" : `❌ 发送失败: ${res.error ?? "未知错误"}`,
        res.ok ? "info" : "error",
      );
    },
  });
}

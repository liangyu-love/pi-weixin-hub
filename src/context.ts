// ── Message context enrichment ─────────────────────────────────────────
// Pure helpers that enrich WeChat messages with context Pi benefits from,
// and build the persona/memory prefix injected into prompts.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WeixinMessage } from "./types.js";

// ── C1: message enrichment ─────────────────────────────────────────────

/** Extract the quoted message text from a Weixin message (ref_msg), if any. */
export function extractRefText(msg: WeixinMessage): string | null {
  if (!msg.item_list) return null;
  for (const item of msg.item_list) {
    const refText = item.ref_msg?.message_item?.text_item?.text;
    if (refText) return refText;
  }
  return null;
}

/**
 * Enrich an incoming message with context Pi benefits from:
 *   - group messages: sender attribution
 *   - quoted messages: the quoted text (ref_msg)
 * Returns the original text unchanged when there is nothing to add.
 */
export function enrichMessageText(msg: WeixinMessage, text: string): string {
  const parts: string[] = [];
  if (msg.group_id) {
    parts.push(`[群聊消息 · 发送者ID: ${msg.from_user_id ?? "未知"}]`);
  }
  const refText = extractRefText(msg);
  if (refText) {
    parts.push(`[引用消息] ${refText}`);
  }
  if (text) parts.push(text);
  return parts.length > 0 ? parts.join("\n") : text;
}

// ── C2: persona / memory prefix ────────────────────────────────────────

/** Path of the user-maintained long-term memory file. */
export function memoryFilePath(): string {
  return path.join(os.homedir(), ".config", "pi-weixin-cli", "memory.md");
}

/** Read the memory file contents (trimmed), or null when absent/empty. */
export function readMemoryFile(): string | null {
  try {
    const memPath = memoryFilePath();
    if (!fs.existsSync(memPath)) return null;
    const mem = fs.readFileSync(memPath, "utf-8").trim();
    return mem || null;
  } catch {
    return null;
  }
}

/**
 * Build the system-context prefix prepended to each prompt:
 * persona (config) + long-term memory (memory.md).
 * Returns "" when neither is present.
 */
export function buildContextPrefix(persona: string | undefined): string {
  const parts: string[] = [];
  const personaText = (persona ?? "").trim();
  if (personaText) parts.push(`【人设】${personaText}`);
  const memory = readMemoryFile();
  if (memory) parts.push(`【长期记忆】${memory}`);
  return parts.length > 0 ? parts.join("\n\n") + "\n\n---\n\n" : "";
}

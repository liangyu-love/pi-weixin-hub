#!/usr/bin/env node
// ── pi-weixin-hub RPC Entry Point ──────────────────────────────────────
// Standalone process that bridges WeChat messages to Pi via RPC protocol.
//
// Architecture:
//   WeChat API (getUpdates long-poll)
//     → Poller (per-account message pump)
//       → StateMachine (message routing: normal vs UI response)
//         → RpcClient (JSONL stdin/stdout to Pi subprocess)
//           → UIBridge (extension_ui_request ↔ WeChat messages)
//         → WeixinApi.sendMessage (reply back to WeChat)
//
// The RPC client spawns `pi --mode rpc` (sessions persist by default;
// set persistentSession=false to add --no-session) and communicates
// via JSONL on stdin/stdout. Each WeChat message becomes a `prompt`
// command, and the assistant's reply is extracted from the `agent_end`
// event and sent back to the WeChat user.
//
// When Pi's extension calls ctx.ui.select/confirm/input/editor, the
// StateMachine transitions to WAITING_UI_RESPONSE and the UIBridge
// forwards the prompt to WeChat. The user's reply is parsed and sent
// back as extension_ui_response, allowing Pi to continue.
//
// If the Pi RPC subprocess crashes or exits unexpectedly, the daemon
// automatically reconnects with exponential backoff (max 10 retries).

import process from "node:process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WeixinApi } from "./api.js";
import { Poller, type MessageCallback, type LogCallback } from "./poller.js";
import { RpcClient, setRpcLogLevel } from "./rpc-client.js";
import { loadAccounts, saveContextToken, loadContextTokens, loadUserSession, saveUserSession, pruneSessionMap, loadUsage, addUsage, totalAccountCost } from "./storage.js";
import { loadConfig, saveConfig } from "./config.js";
import { startWebhookServer, type WebhookServer } from "./webhook.js";
import { Logger, resolveLogLevel, setLogFile } from "./logger.js";
import { formatAndSplit } from "./format-reply.js";
import { classifyError, formatClassifiedError } from "./error-classifier.js";
import { buildContextPrefix, enrichMessageText, memoryFilePath, readMemoryFile } from "./context.js";
import type { WeixinAccount, WeixinMessage, ImageItem, FileItem, VoiceItem, VideoItem } from "./types.js";
import { MessageItemType, MessageType, MessageState } from "./types.js";
import type { AgentEndEvent, ExtensionUIRequestEvent, ImageContent } from "./types-rpc.js";
import { downloadImageForWeixin, saveFileLocally, saveVoiceLocally, saveVideoLocally, setMediaLogLevel } from "./media-handler.js";
import { convertDocumentToMarkdown, setDocConvertLogLevel } from "./document-converter.js";
import { StateMachine, type UIMethod, type UIRequestContext } from "./state-machine.js";
import { formatUIRequestForWeixin, isFireAndForget, parseUserResponse } from "./ui-bridge.js";
import { runCLI } from "./cli.js";

// ── Pending Context (for reply routing) ────────────────────────────────

interface PendingContext {
  account: WeixinAccount;
  userId: string;
  contextToken: string;
  sessionId: string;
  /** Session routing key ("" = default/private, otherwise a from_user_id). */
  sessionKey: string;
}

// ── Message Queue Entry ────────────────────────────────────────────────

interface QueuedMessage {
  account: WeixinAccount;
  userId: string;
  contextToken: string;
  sessionId: string;
  /** Session routing key ("" = default/private, otherwise a from_user_id). */
  sessionKey: string;
  text: string;
  /** Enqueue time (ms) — used for crash-recovery TTL. */
  createdAt?: number;
  /** Optional image item from the WeChat message. */
  imageItem?: ImageItem;
  /** Optional file item from the WeChat message. */
  fileItem?: FileItem;
  /** Optional voice item from the WeChat message. */
  voiceItem?: VoiceItem;
  /** Optional video item from the WeChat message. */
  videoItem?: VideoItem;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract the last assistant text reply from Pi's agent_end messages array.
 * Mirrors bridge.ts extractAssistantReply().
 */
function extractAssistantReply(messages: unknown[] | undefined): string | null {
  if (!messages || messages.length === 0) return null;

  let lastAssistantText = "";
  for (const msg of messages) {
    if (msg === null || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m["role"] !== "assistant") continue;
    const content = m["content"];
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      if (c === null || typeof c !== "object") continue;
      const item = c as Record<string, unknown>;
      if (item["type"] !== "text") continue;
      const text = item["text"];
      if (typeof text === "string" && text) {
        lastAssistantText = text;
      }
    }
  }

  return lastAssistantText || null;
}

/**
 * Send a text reply back to a WeChat user.
 * Mirrors bridge.ts sendReply.
 */
async function sendWeixinReply(
  api: WeixinApi,
  account: WeixinAccount,
  toUserId: string,
  contextToken: string,
  sessionId: string,
  replyText: string,
): Promise<void> {
  try {
    await api.sendMessage(
      {
        msg: {
          from_user_id: "",
          client_id: crypto.randomUUID(),
          to_user_id: toUserId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          create_time_ms: Date.now(),
          item_list: [
            {
              type: MessageItemType.TEXT,
              text_item: { text: replyText },
            },
          ],
          context_token: contextToken,
          session_id: sessionId || undefined,
        },
      },
      account.botToken,
      account.baseUrl,
    );
    log(`[weixin] 回复已发送 (${replyText.length} 字符) → ${toUserId}`);
  } catch (err) {
    const cls = classifyError(err);
    logWarn(`[weixin] 回复发送失败: ${err instanceof Error ? err.message : String(err)} (${cls.category})`);
  }
}

// ── Logging ────────────────────────────────────────────────────────────

const logger = new Logger("info", "daemon");

/** Info-level log (kept as a bare function so existing call sites stay short). */
function log(msg: string): void {
  logger.info(msg);
}

/** Debug-level log — only visible when logLevel=debug. */
function logDebug(msg: string): void {
  logger.debug(msg);
}

/** Warn-level log. */
function logWarn(msg: string): void {
  logger.warn(msg);
}

// ── Slash Command Type ─────────────────────────────────────────────────

interface SlashCommand {
  command: string;
  args: string;
}

interface BashCommand {
  command: string;
}

// ── Daemon ─────────────────────────────────────────────────────────────

async function runDaemon(): Promise<void> {
  log("pi-weixin-hub RPC 模式启动中...");
  const daemonCwd = process.cwd();

  // ── Load config ──────────────────────────────────────────────────────
  const config = loadConfig();
  // When forked into the background, default to a log file if none is set
  if (!config.logFile && process.env.PI_FORKED === "1") {
    config.logFile = path.join(os.homedir(), ".config", "pi-weixin-cli", "daemon.log");
  }
  const effectiveLogLevel = resolveLogLevel(config.logLevel);
  logger.setLevel(effectiveLogLevel);
  setMediaLogLevel(effectiveLogLevel);
  setDocConvertLogLevel(effectiveLogLevel);
  setRpcLogLevel(effectiveLogLevel);
  if (config.logFile) {
    setLogFile(config.logFile, config.logMaxBytes ?? 5 * 1024 * 1024);
    log(`[log] 日志文件: ${config.logFile} (轮转上限 ${((config.logMaxBytes ?? 5 * 1024 * 1024) / 1024 / 1024).toFixed(1)}MB)`);
  }

  // ── Respect config.enabled ───────────────────────────────────────────
  if (!config.enabled) {
    log("配置中消息接收已禁用。使用 'pi-weixin-hub toggle' 启用。");
    process.exit(0);
  }

  // ── Load accounts ────────────────────────────────────────────────────
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    log("错误: 没有已登录的微信账号。");
    log("请先使用 'pi-weixin-hub login' 命令登录，或手动编辑 accounts.json。");
    log("账号文件位于: ~/.config/pi-weixin-cli/accounts.json");
    process.exit(1);
  }

  log(`已加载 ${accounts.length} 个微信账号: ${accounts.map((a) => a.id).join(", ")}`);

  // ── Media / session retention (D3) ───────────────────────────────────
  const RETENTION_DIRS = ["images", "files", "voices", "videos"];

  /** Delete media files and session-map entries older than `days`. */
  function pruneRetention(days: number): void {
    if (days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const base = path.join(os.homedir(), ".config", "pi-weixin-cli");
    let removed = 0;
    for (const dir of RETENTION_DIRS) {
      const dirPath = path.join(base, dir);
      try {
        if (!fs.existsSync(dirPath)) continue;
        for (const file of fs.readdirSync(dirPath)) {
          try {
            if (fs.statSync(path.join(dirPath, file)).mtimeMs < cutoff) {
              fs.unlinkSync(path.join(dirPath, file));
              removed++;
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }
    for (const account of accounts) {
      try {
        removed += pruneSessionMap(account.id, cutoff);
      } catch {
        /* ignore */
      }
    }
    if (removed > 0) log(`[retention] 已清理 ${removed} 个超过 ${days} 天的媒体/会话文件`);
  }

  pruneRetention(config.retentionDays ?? 30);
  setInterval(() => pruneRetention(config.retentionDays ?? 30), 24 * 60 * 60 * 1000).unref();

  // ── Default model + persistent session helpers ───────────────────────

  /**
   * Apply config.defaultModel to the given RPC client (best effort).
   * Accepts "provider/modelId" or a bare model id/name.
   */
  async function applyDefaultModel(client: RpcClient): Promise<void> {
    const model = config.defaultModel;
    if (!model) return;
    try {
      await setModelByPattern(model);
      invalidateVisionCache();
      log(`[rpc] 默认模型已应用: ${model}`);
    } catch (err) {
      logWarn(`[rpc] 应用默认模型失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Set a model from a pattern: "provider/modelId" or a bare id/name
   * resolved against the available-model list. Throws on failure.
   */
  async function setModelByPattern(pattern: string): Promise<void> {
    if (!rpcClient) throw new Error("RpcClient 未连接");
    if (pattern.includes("/")) {
      const [provider, modelId] = pattern.split("/", 2);
      await rpcClient.setModel(provider, modelId);
      return;
    }
    const result = (await rpcClient.getAvailableModels()) as {
      models?: Array<Record<string, unknown>>;
    } | null;
    const found = (result?.models ?? []).find(
      (m) => (m.id ?? m.modelId ?? m.name) === pattern,
    ) as Record<string, unknown> | undefined;
    if (!found) throw new Error(`模型未找到: ${pattern}`);
    await rpcClient.setModel((found.provider as string) ?? "", (found.id ?? found.modelId) as string);
  }

  // ── Per-user model mapping (E2) ───────────────────────────────────────

  /** Last applied per-user model: { userId, model } for change detection. */
  let appliedUserModel: { userId: string; model: string | null } | null = null;

  /**
   * Apply config.userModels for a user; when the user has no mapping,
   * restore config.defaultModel if we previously applied a mapped model.
   */
  async function applyUserModel(userId: string): Promise<void> {
    if (!rpcClient) return;
    const mapped = config.userModels?.[userId]?.trim();
    if (mapped) {
      if (appliedUserModel?.userId === userId && appliedUserModel.model === mapped) return;
      try {
        await setModelByPattern(mapped);
        invalidateVisionCache();
        appliedUserModel = { userId, model: mapped };
        log(`[rpc] 用户模型已应用 (${userId}): ${mapped}`);
      } catch (err) {
        logWarn(`[rpc] 用户模型应用失败 (${userId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (appliedUserModel && appliedUserModel.userId !== userId) {
      // Switching to an unmapped user — restore the default model if configured
      if (config.defaultModel) {
        try {
          await setModelByPattern(config.defaultModel);
          invalidateVisionCache();
        } catch (err) {
          logWarn(`[rpc] 恢复默认模型失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      appliedUserModel = { userId, model: null };
    }
  }

  // ── Multi-session routing state ──────────────────────────────────────

  /**
   * Session key of the session currently active in the shared RPC process.
   * "" = default/private session; otherwise a from_user_id (group sender).
   * Reset to null when the RPC process restarts (it holds a fresh session).
   */
  let sessionOwnerKey: string | null = null;

  /**
   * Switch the shared RPC process to the session belonging to `sessionKey`
   * ("" = default/private). Must be called while Pi is idle.
   * Creates a fresh session for the key if none is saved.
   */
  async function ensureSessionFor(account: WeixinAccount, sessionKey: string): Promise<void> {
    if (!rpcClient) return;
    if (sessionOwnerKey === sessionKey) return;
    const label = sessionKey === "" ? "默认" : sessionKey.slice(0, 12);
    const saved = loadUserSession(account.id, sessionKey);
    try {
      if (saved && fs.existsSync(saved)) {
        await rpcClient.switchSession(saved);
        log(`[rpc] 会话已切换到 (${label}): ${saved}`);
      } else {
        await rpcClient.newSession();
        log(`[rpc] 为 (${label}) 创建新会话`);
      }
      sessionOwnerKey = sessionKey;
      needsCompact = false; // the compact flag belongs to the previous session
    } catch (err) {
      logWarn(`[rpc] 切换会话失败 (${label}): ${err instanceof Error ? err.message : String(err)}`);
      // Claim ownership optimistically so the turn proceeds; the session
      // path is re-saved on agent_end regardless.
      sessionOwnerKey = sessionKey;
    }
  }

  /**
   * Persist the RPC process's current session file under a session key.
   * Called after session-changing commands (/new, /resume, /fork, /clone)
   * so a later user switch resolves to the new file, not the stale one.
   */
  async function persistCurrentSession(accountId: string, sessionKey: string): Promise<void> {
    if (!config.persistentSession || !rpcClient) return;
    try {
      const state = (await rpcClient.getState()) as { sessionFile?: string } | null;
      if (state?.sessionFile) {
        saveUserSession(accountId, sessionKey, state.sessionFile);
      }
    } catch {
      /* best effort */
    }
  }

  // ── Vision capability detection (adaptive image handling) ────────────

  /** Cache of the active model's vision capability: key → hasVision. */
  let visionCache: { key: string; hasVision: boolean } | null = null;

  /** Invalidate the vision cache (call after any model switch). */
  function invalidateVisionCache(): void {
    visionCache = null;
  }

  /**
   * Whether the currently active Pi model supports image input.
   * Cached per model; falls back to false (subagent path) on failure.
   */
  async function getModelHasVision(client: RpcClient): Promise<boolean> {
    try {
      const state = (await client.getState()) as {
        model?: { provider?: string; id?: string; input?: string[] } | null;
      } | null;
      const model = state?.model;
      const key = model ? `${model.provider ?? ""}/${model.id ?? ""}` : "";
      if (!key) return visionCache?.hasVision ?? false;
      if (visionCache && visionCache.key === key) return visionCache.hasVision;
      const hasVision = Array.isArray(model?.input) && model.input.includes("image");
      visionCache = { key, hasVision };
      return hasVision;
    } catch {
      return visionCache?.hasVision ?? false;
    }
  }

  // ── Initialize API client ────────────────────────────────────────────
  const api = new WeixinApi();

  // ── Mutable state (may be reset during reconnect) ────────────────────
  let rpcClient: RpcClient | null = null;
  let shuttingDown = false;

  // ── Daemon status heartbeat (for the CLI dashboard) ──────────────────
  const daemonStartTime = Date.now();
  let lastActivityAt = daemonStartTime;
  let pkgVersion = "unknown";
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url)); // dist/
    pkgVersion =
      JSON.parse(fs.readFileSync(path.join(moduleDir, "..", "package.json"), "utf-8")).version ??
      "unknown";
  } catch {
    /* keep unknown */
  }

  const STATUS_PATH = path.join(os.homedir(), ".config", "pi-weixin-cli", "daemon-status.json");

  /** Atomically write the daemon heartbeat file (tmp + rename). */
  function writeStatusHeartbeat(): void {
    // Prune stale rate-limit state (per-user buckets older than the window)
    const cutoff = Date.now() - 60_000;
    for (const [uid, b] of rateBuckets) {
      if (b.windowStart < cutoff) rateBuckets.delete(uid);
    }
    for (const [uid, t] of rateLimitedNotifiedAt) {
      if (t < cutoff) rateLimitedNotifiedAt.delete(uid);
    }

    const status = {
      pid: process.pid,
      startTime: daemonStartTime,
      uptimeSec: Math.round((Date.now() - daemonStartTime) / 1000),
      version: pkgVersion,
      accounts: accounts.map((a) => a.id),
      sessionOwner: sessionOwnerKey ?? null,
      queueLength: messageQueue.length,
      processing: processingWeixin,
      piRunning: rpcClient?.isRunning ?? false,
      lastActivityAt,
    };
    try {
      const tmp = `${STATUS_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf-8");
      fs.renameSync(tmp, STATUS_PATH);
    } catch {
      /* best effort */
    }
  }

  // ── State Machine ────────────────────────────────────────────────────
  const sm = new StateMachine();

  /** Queue of messages waiting to be sent to Pi. */
  const messageQueue: QueuedMessage[] = [];

  // ── Persistent message queue (crash recovery, D4) ───────────────────
  const QUEUE_FILE = path.join(os.homedir(), ".config", "pi-weixin-cli", "queue.jsonl");

  /** Persist the in-memory queue to disk (tmp + rename, small queues). */
  function persistQueueNow(): void {
    try {
      const tmp = `${QUEUE_FILE}.tmp`;
      const lines = messageQueue.map((m) => JSON.stringify(m));
      fs.writeFileSync(tmp, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf-8");
      fs.renameSync(tmp, QUEUE_FILE);
    } catch {
      /* best effort */
    }
  }

  /** Enqueue a message and persist. */
  function enqueueMessage(qm: QueuedMessage): void {
    messageQueue.push({ ...qm, createdAt: qm.createdAt ?? Date.now() });
    persistQueueNow();
  }

  /** Dequeue the next message and persist. */
  function dequeueMessage(): QueuedMessage | undefined {
    const next = messageQueue.shift();
    persistQueueNow();
    return next;
  }

  /** Load persisted messages from a previous run (TTL-filtered). */
  function loadPersistedQueue(): void {
    const ttlMin = config.queueTtlMin ?? 30;
    const cutoff = Date.now() - ttlMin * 60_000;
    try {
      if (!fs.existsSync(QUEUE_FILE)) return;
      const lines = fs.readFileSync(QUEUE_FILE, "utf-8").split("\n").filter(Boolean);
      let loaded = 0;
      for (const line of lines) {
        try {
          const qm = JSON.parse(line) as QueuedMessage;
          const createdAt = qm.createdAt ?? 0;
          if (ttlMin > 0 && createdAt && createdAt < cutoff) continue; // stale
          messageQueue.push(qm);
          loaded++;
        } catch {
          /* skip malformed */
        }
      }
      // NOTE: do NOT delete the file here — the on-disk copy remains the
      // recovery source until the next enqueue/dequeue rewrites it. If the
      // daemon dies before processing, the items are recovered again
      // (at-least-once delivery). persistQueueNow() on the next mutation
      // replaces the file with the correct in-memory state.
      if (loaded > 0) {
        log(`[queue] 已从磁盘恢复 ${loaded} 条未处理消息`);
      }
    } catch (err) {
      logWarn(`[queue] 队列恢复失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Recover the persisted message queue from a previous run (D4) ─────
  // Must run after QUEUE_FILE/messageQueue are declared.
  loadPersistedQueue();

  /** Context of the currently processing WeChat message. */
  let pendingContext: PendingContext | null = null;

  /** Data of the in-flight agent run (updated on each agent_end). */
  let turnData: { messages: unknown[] | undefined; aborted: boolean } | null = null;
  /** Backstop timer if agent_settled never arrives after a retrying run. */
  let turnWatchdog: ReturnType<typeof setTimeout> | null = null;
  /** Set when the user issues /abort; forces the next finalize to be treated as aborted. */
  let pendingAbort = false;
  /** Fallback timer to force a clean turn reset if pi emits no agent_end after /abort. */
  let turnAbortTimer: ReturnType<typeof setTimeout> | null = null;

  /** Most recent routing context per account (for webhook default target). */
  const lastSenders = new Map<string, PendingContext>();
  /** Most recent sender across all accounts (webhook default target). */
  let lastSenderGlobal: PendingContext | null = null;
  /** Running webhook server (started when config.webhookPort > 0). */
  let webhookServer: WebhookServer | null = null;

  /** Pending model selections: userId → models array (for /model flow). */
  const pendingModelSelections = new Map<string, unknown[]>();

  /** Pending session selections: userId → sessions array (for /resume flow). */
  const pendingResumeSelections = new Map<
    string,
    { path: string; label: string }[]
  >();

  /** Pending fork selections: userId → fork messages array (for /fork flow). */
  const pendingForkSelections = new Map<
    string,
    { entryId: string; text: string }[]
  >();

  // ── Session listing helper ─────────────────────────────────────────

  /** Scan ~/.pi/agent/sessions/ and return the most recent N sessions. */
  /**
   * Read the first 16KB of a session file to extract a human-readable title.
   * Returns the session name (set_session_name), first user message, or null.
   */
  function extractSessionTitle(filePath: string): string | null {
    const BUF_SIZE = 16384;
    const buf = Buffer.alloc(BUF_SIZE);
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, "r");
      const bytesRead = fs.readSync(fd, buf, 0, BUF_SIZE, 0);
      const raw = buf.toString("utf-8", 0, bytesRead);

      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          // Prefer explicit session name
          if (entry.type === "set_session_name" && entry.name) return entry.name;
          // Fall back to first user message
          if (entry.type === "message" && entry.message?.role === "user") {
            const content = entry.message.content;
            if (Array.isArray(content) && content.length > 0) {
              const first = content[0];
              if (first?.type === "text" && first.text) {
                return first.text.replace(/\n/g, " ").slice(0, 60);
              }
            }
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* file read error */
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return null;
  }

  /** Scan ~/.pi/agent/sessions/ and return the most recent N sessions. */
  function listRecentSessions(limit = 10): { path: string; label: string }[] {
    const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
    const entries: { path: string; mtime: number; label: string }[] = [];

    try {
      for (const project of fs.readdirSync(sessionsDir)) {
        const projectDir = path.join(sessionsDir, project);
        let isDir = false;
        try { isDir = fs.statSync(projectDir).isDirectory(); } catch { continue; }
        if (!isDir) continue;

        for (const file of fs.readdirSync(projectDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(projectDir, file);
          let fileStat: fs.Stats;
          try { fileStat = fs.statSync(filePath); } catch { continue; }

          // Parse filename timestamp: "2026-05-27T11-13-09-592Z_uuid.jsonl"
          const tsMatch = file.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2})-(\d{2})/);
          const shortTs = tsMatch
            ? `${tsMatch[1]}-${tsMatch[2]} ${tsMatch[3]}:${tsMatch[4]}`
            : file.slice(0, 20);

          const title = extractSessionTitle(filePath);
          const displayTitle = title ?? "(无标题)";

          entries.push({
            path: filePath,
            mtime: fileStat.mtimeMs,
            label: `${shortTs}  ${displayTitle}  [${project}]`,
          });
        }
      }
    } catch {
      return [];
    }

    entries.sort((a, b) => b.mtime - a.mtime);
    return entries.slice(0, limit);
  }

  // ── Slash command helpers ──────────────────────────────────────────

  /** Parse a slash command from message text. Returns null if not a command. */
  function parseSlashCommand(text: string): SlashCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) {
      return { command: trimmed.slice(1).toLowerCase(), args: "" };
    }
    return {
      command: trimmed.slice(1, spaceIdx).toLowerCase(),
      args: trimmed.slice(spaceIdx + 1).trim(),
    };
  }

  /** Parse a bash command from message text. Returns null if not a command. */
  function parseBashCommand(text: string): BashCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("!")) return null;
    return { command: trimmed.startsWith("!!") ? trimmed.slice(2).trim() : trimmed.slice(1).trim() };
  }

  /** Format session state into a human-readable text block. */
  /** Format a number of tokens in compact form: 75000 → "75.0k", 3000000 → "3.0M". */
  function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  /** Read the session JSONL file's first event to extract cwd. */
  function getSessionCwd(sessionFile: string): string | null {
    try {
      const fd = fs.openSync(sessionFile, "r");
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString("utf-8", 0, n).split("\n")[0];
      const entry = JSON.parse(firstLine);
      return (entry.cwd as string) ?? null;
    } catch {
      return null;
    }
  }

  function formatSessionState(state: unknown, stats?: unknown): string {
    const lines: string[] = [];
    let autoCompactTag = "";

    // ── Header: model + thinking ────────────────────────────────────
    if (state !== null && typeof state === "object") {
      const s = state as Record<string, unknown>;
      const model = s.model as Record<string, unknown> | string | undefined;
      const modelName = typeof model === "string"
        ? model
        : (model?.name ?? model?.id ?? "?") as string;
      const thinking = (s.thinkingLevel ?? "?") as string;
      const msgCount = s.messageCount !== undefined ? ` · ${s.messageCount}msgs` : "";
      autoCompactTag = s.autoCompactionEnabled ? "(auto)" : "";

      // Get cwd from session file (first JSONL event), fallback to daemon cwd
      const sessionFile = s.sessionFile as string | undefined;
      const cwd = sessionFile ? (getSessionCwd(sessionFile) ?? daemonCwd) : daemonCwd;

      lines.push(`📊 ${modelName} · ${thinking}${msgCount}` + (cwd ? ` · ${cwd}` : ""));
    } else {
      lines.push("📊 Session 状态");
    }

    // ── Stats line: ↑input ↓output Rremaining $cost percent%/window ──
    if (stats !== null && typeof stats === "object") {
      const st = stats as Record<string, unknown>;
      const tokens = st.tokens as Record<string, number> | undefined;
      const ctx = st.contextUsage as Record<string, unknown> | undefined;

      if (tokens) {
        const input = tokens.input ?? 0;
        const output = tokens.output ?? 0;
        const total = tokens.total ?? 0;
        const cost = (st.cost as number) ?? 0;

        const statsParts: string[] = [];
        statsParts.push(`↑${fmtTokens(input)}`);
        statsParts.push(`↓${fmtTokens(output)}`);

        if (ctx) {
          const ctxWindow = ctx.contextWindow as number;
          const ctxPercent = ctx.percent as number | null;
          if (ctxWindow) {
            const remaining = ctxWindow - (tokens.input + tokens.cacheWrite + tokens.output);
            statsParts.push(`R${fmtTokens(Math.max(0, remaining))}`);
          }
          if (ctxPercent !== null && ctxPercent !== undefined) {
            statsParts.push(`${ctxPercent.toFixed(1)}%/${fmtTokens(ctxWindow)}`);
          }
        }

        statsParts.push(cost === 0 ? "$0" : `$${cost.toFixed(2)}`);
        if (autoCompactTag) statsParts.push(autoCompactTag);
        lines.push(statsParts.join(" "));
      }
    }

    return lines.join("\n");
  }

  /**
   * Handle a slash command from a WeChat user.
   * Executes immediately (does not enter the message queue).
   */
  async function handleSlashCommand(
    cmd: SlashCommand,
    account: WeixinAccount,
    userId: string,
    contextToken: string,
    sessionId: string,
    sessionKey: string,
  ): Promise<void> {
    if (!rpcClient) return;

    try {
      switch (cmd.command) {
        case "new": {
          const result = (await rpcClient.newSession()) as { cancelled?: boolean } | null;
          const cancelled = result?.cancelled;
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            cancelled ? "⚠️ 新建 session 被取消" : "✅ 已新建 session");
          if (!cancelled) await persistCurrentSession(account.id, sessionKey);
          log(`[slash] /new (user=${userId})`);
          break;
        }

        case "compact": {
          const result = (await rpcClient.compact(cmd.args || undefined)) as { summary?: string } | null;
          const summary = result?.summary ? `\n\n摘要: ${result.summary.slice(0, 200)}` : "";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 上下文已压缩${summary}`);
          log(`[slash] /compact (user=${userId})`);
          break;
        }

        case "abort": {
          pendingAbort = true;
          // Schedule the fallback BEFORE any awaits: agent_end's finalize
          // clears this timer, so it only fires if pi never responds to
          // the abort (avoiding the race where a late-set timer would
          // fire during the NEXT turn and mislabel it as aborted).
          if (turnAbortTimer) clearTimeout(turnAbortTimer);
          turnAbortTimer = setTimeout(() => {
            turnAbortTimer = null;
            // Nudge pi to actually stop, then force a clean turn reset.
            try {
              rpcClient?.sendAbort();
            } catch {
              /* ignore */
            }
            if (turnData) {
              turnData = { ...turnData, aborted: true };
              void finalizeTurn();
            } else if (processingWeixin) {
              turnData = { messages: [], aborted: true };
              void finalizeTurn();
            }
          }, 15_000);
          rpcClient.sendAbort();
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 已中止当前任务");
          log(`[slash] /abort (user=${userId})`);
          break;
        }

        case "session": {
          const [state, stats] = await Promise.all([
            rpcClient.getState(),
            rpcClient.getSessionStats().catch(() => null),
          ]);
          const formatted = formatSessionState(state, stats);
          await sendWeixinReply(api, account, userId, contextToken, sessionId, formatted);
          log(`[slash] /session (user=${userId})`);
          break;
        }

        case "messages": {
          const result = (await rpcClient.getMessages()) as { messages?: unknown[] } | null;
          const messages = result?.messages ?? [];
          if (messages.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "📭 当前 session 没有消息");
            return;
          }
          const lines: string[] = [`📋 最近 ${Math.min(messages.length, 20)} 条消息：`];
          const recent = messages.slice(-20);
          for (const msg of recent) {
            const m = msg as Record<string, unknown>;
            const role = (m.role ?? "unknown") as string;
            let text = "";
            const content = m.content;
            if (Array.isArray(content)) {
              const first = content[0] as Record<string, unknown> | undefined;
              text = (first?.text ?? first?.data ?? "") as string;
            } else if (typeof content === "string") {
              text = content;
            }
            text = text.replace(/\n/g, " ").slice(0, 60);
            lines.push(`[${role}] ${text || "(无文本)"}`);
          }
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /messages (user=${userId}, count=${messages.length})`);
          break;
        }

        case "export": {
          const result = (await rpcClient.exportHtml(cmd.args || undefined)) as { path?: string } | null;
          const exportPath = result?.path ?? "(未知路径)";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Session 已导出\n📄 ${exportPath}`);
          log(`[slash] /export → ${exportPath} (user=${userId})`);
          break;
        }

        case "clone": {
          const result = (await rpcClient.clone()) as { cancelled?: boolean } | null;
          const cancelled = result?.cancelled;
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            cancelled ? "⚠️ 克隆被取消" : "✅ 已克隆当前 session");
          if (!cancelled) await persistCurrentSession(account.id, sessionKey);
          log(`[slash] /clone (user=${userId})`);
          break;
        }

        case "last": {
          const result = (await rpcClient.getLastAssistantText()) as { text?: string | null } | null;
          const text = result?.text ?? "(无 assistant 回复)";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `🤖 最后一条回复:\n\n${text}`);
          log(`[slash] /last (user=${userId})`);
          break;
        }

        case "cycle-model": {
          const result = (await rpcClient.cycleModel()) as { model?: { name?: string; id?: string } } | null;
          invalidateVisionCache();
          const modelName = result?.model?.name ?? result?.model?.id ?? "未知模型";
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 已切换模型: ${modelName}`);
          log(`[slash] /cycle-model → ${modelName} (user=${userId})`);
          break;
        }

        case "thinking": {
          if (cmd.args) {
            await rpcClient.setThinkingLevel(cmd.args);
            await sendWeixinReply(api, account, userId, contextToken, sessionId,
              `✅ Thinking level 已设置为: ${cmd.args}`);
            log(`[slash] /thinking ${cmd.args} (user=${userId})`);
          } else {
            const result = (await rpcClient.cycleThinkingLevel()) as { level?: string } | null;
            const level = result?.level ?? "未知";
            await sendWeixinReply(api, account, userId, contextToken, sessionId,
              `✅ Thinking level 已切换为: ${level}`);
            log(`[slash] /thinking cycle → ${level} (user=${userId})`);
          }
          break;
        }

        case "steer-mode": {
          const mode = cmd.args || "one-at-a-time";
          await rpcClient.setSteeringMode(mode);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Steering mode 已设置为: ${mode}`);
          log(`[slash] /steer-mode ${mode} (user=${userId})`);
          break;
        }

        case "follow-mode": {
          const mode = cmd.args || "one-at-a-time";
          await rpcClient.setFollowUpMode(mode);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Follow-up mode 已设置为: ${mode}`);
          log(`[slash] /follow-mode ${mode} (user=${userId})`);
          break;
        }

        case "auto-compact": {
          const enabled = cmd.args === "on" || cmd.args === "true";
          await rpcClient.setAutoCompaction(enabled);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 自动压缩已${enabled ? "开启" : "关闭"}`);
          log(`[slash] /auto-compact ${enabled} (user=${userId})`);
          break;
        }

        case "auto-retry": {
          const enabled = cmd.args === "on" || cmd.args === "true";
          await rpcClient.setAutoRetry(enabled);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 自动重试已${enabled ? "开启" : "关闭"}`);
          log(`[slash] /auto-retry ${enabled} (user=${userId})`);
          break;
        }

        case "abort-retry": {
          await rpcClient.abortRetry();
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "✅ 已中止重试");
          log(`[slash] /abort-retry (user=${userId})`);
          break;
        }

        case "name": {
          if (!cmd.args) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 用法: /name <session名称>");
            return;
          }
          await rpcClient.setSessionName(cmd.args);
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ Session 名称已设置为: ${cmd.args}`);
          log(`[slash] /name ${cmd.args} (user=${userId})`);
          break;
        }

        case "model": {
          // Direct switch: /model <name-or-id>
          if (cmd.args) {
            const result = (await rpcClient.getAvailableModels()) as Record<string, unknown> | null;
            const models = result?.models as unknown[] | undefined;
            const q = cmd.args.trim().toLowerCase();
            const found = (models ?? []).find((m: unknown) => {
              const item = m as Record<string, unknown>;
              const id = (item.id ?? item.modelId ?? "") as string;
              const name = (item.name ?? "") as string;
              return name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
            }) as Record<string, unknown> | undefined;
            if (!found) {
              await sendWeixinReply(api, account, userId, contextToken, sessionId,
                `⚠️ 未找到匹配模型: ${cmd.args}`);
              return;
            }
            await rpcClient.setModel(
              (found.provider as string) ?? "",
              (found.id ?? found.modelId) as string,
            );
            invalidateVisionCache();
            await sendWeixinReply(api, account, userId, contextToken, sessionId,
              `✅ 已切换模型: ${(found.name ?? found.id) as string}`);
            log(`[slash] /model ${cmd.args} → ${(found.id ?? found.modelId) as string} (user=${userId})`);
            return;
          }

          const result = (await rpcClient.getAvailableModels()) as Record<string, unknown> | null;
          const models = result?.models as unknown[] | undefined;
          if (!models || models.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 未获取到可用模型列表");
            return;
          }
          pendingModelSelections.set(userId, models);
          const lines = ["📋 可用模型列表："];
          models.forEach((m: unknown, i: number) => {
            const item = m as Record<string, unknown>;
            const provider = item.provider ? `[${item.provider}] ` : "";
            const name = (item.name ?? item.id ?? item.modelId ?? `模型 ${i + 1}`) as string;
            const current = item.current ? " ← 当前" : "";
            lines.push(`${i + 1}. ${provider}${name}${current}`);
          });
          lines.push("", "回复数字编号切换模型");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /model → ${models.length} 个模型 (user=${userId})`);
          break;
        }

        case "usage": {
          const map = loadUsage(account.id);
          const totalTokens = Object.values(map).reduce((s, u) => s + u.tokens, 0);
          const totalCost = Object.values(map).reduce((s, u) => s + u.cost, 0);
          const lines = ["📊 用量统计："];
          for (const [key, u] of Object.entries(map)) {
            const label = key === "" ? "默认会话" : key.slice(0, 16);
            lines.push(`  ${label}: ${fmtTokens(u.tokens)} tokens · $${u.cost.toFixed(4)} · ${u.turns} 轮`);
          }
          lines.push(`\n合计: ${fmtTokens(totalTokens)} tokens · $${totalCost.toFixed(2)}`);
          const budget = config.costAlert ?? 0;
          if (budget > 0) {
            lines.push(`预算: $${budget}/月 ${totalCost >= budget ? "（已超限）" : ""}`);
          }
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /usage (user=${userId})`);
          break;
        }

        case "memory": {
          const memPath = memoryFilePath();
          const content = readMemoryFile() ?? "";
          const text = content
            ? `📝 当前长期记忆：\n\n${content}\n\n（如需修改，可直接告诉 Pi 更新此文件）`
            : "📝 暂无长期记忆。\n\n告诉我你想记住的事情，我会写进 memory.md；或直接编辑该文件。";
          await sendWeixinReply(api, account, userId, contextToken, sessionId, text);
          log(`[slash] /memory (user=${userId})`);
          break;
        }

        case "status": {
          const [state, stats] = await Promise.all([
            rpcClient.getState(),
            rpcClient.getSessionStats().catch(() => null),
          ]);
          const formatted = formatSessionState(state, stats);
          const queueInfo = `\n\n📬 待处理消息: ${messageQueue.length}` +
            (sessionOwnerKey !== null
              ? ` | 当前会话: ${sessionOwnerKey === "" ? "默认" : sessionOwnerKey.slice(0, 12)}`
              : "");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, formatted + queueInfo);
          log(`[slash] /status (user=${userId})`);
          break;
        }

        case "image": {
          const url = cmd.args.trim();
          if (!url) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 用法: /image <图片URL>");
            return;
          }
          if (rpcClient.isStreaming || processingWeixin) {
            enqueueMessage({ account, userId, contextToken, sessionId, sessionKey, text: `/image ${url}` });
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⏳ 当前任务进行中，图片分析已排队");
            return;
          }
          const fakeImageItem = { media: { full_url: url } } as ImageItem;
          void injectMessage({
            account, userId, contextToken, sessionId, sessionKey,
            text: "", imageItem: fakeImageItem,
          }).catch((err) => log(`[slash] /image 注入失败: ${err instanceof Error ? err.message : String(err)}`));
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "🖼️ 正在分析图片，请稍候...");
          log(`[slash] /image ${url.slice(0, 60)} (user=${userId})`);
          break;
        }

        case "send-image": {
          const url = cmd.args.trim();
          if (!url) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 用法: /send-image <图片URL>");
            return;
          }
          await sendWeixinMedia(account, userId, contextToken, sessionId, { type: "image", url });
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "🖼️ 图片已发送");
          log(`[slash] /send-image ${url.slice(0, 60)} (user=${userId})`);
          break;
        }

        case "send-file": {
          const url = cmd.args.trim();
          if (!url) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 用法: /send-file <文件URL> [文件名]");
            return;
          }
          const [urlPart, ...nameParts] = url.split(/\s+/);
          await sendWeixinMedia(account, userId, contextToken, sessionId, {
            type: "file",
            url: urlPart,
            caption: nameParts.join(" ") || undefined,
          });
          await sendWeixinReply(api, account, userId, contextToken, sessionId, "📄 文件已发送");
          log(`[slash] /send-file ${urlPart.slice(0, 60)} (user=${userId})`);
          break;
        }

        case "search": {
          const query = cmd.args.trim();
          if (!query) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 用法: /search <关键词>");
            return;
          }
          const text = `请联网搜索并总结：${query}\n\n【要求】使用可用的搜索工具/技能查找最新信息，用中文总结要点，并注明来源。`;
          if (rpcClient.isStreaming || processingWeixin) {
            enqueueMessage({ account, userId, contextToken, sessionId, sessionKey, text });
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⏳ 当前任务进行中，搜索已排队");
          } else {
            void injectMessage({
              account, userId, contextToken, sessionId, sessionKey, text,
            }).catch((err) => log(`[slash] /search 注入失败: ${err instanceof Error ? err.message : String(err)}`));
            await sendWeixinReply(api, account, userId, contextToken, sessionId, `🔍 已开始搜索：${query}`);
          }
          log(`[slash] /search ${query.slice(0, 40)} (user=${userId})`);
          break;
        }

        case "resume": {
          const sessions = listRecentSessions(10);
          if (sessions.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 未找到历史 session");
            return;
          }
          pendingResumeSelections.set(userId, sessions);
          const lines = ["📋 最近 session："];
          sessions.forEach((s, i) => {
            lines.push(`${i + 1}. ${s.label}`);
          });
          lines.push("", "回复数字编号恢复 session");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /resume → ${sessions.length} 个 session (user=${userId})`);
          break;
        }

        case "fork": {
          const result = (await rpcClient.getForkMessages()) as { messages?: { entryId: string; text: string }[] } | null;
          const messages = result?.messages ?? [];
          if (messages.length === 0) {
            await sendWeixinReply(api, account, userId, contextToken, sessionId, "⚠️ 没有可 fork 的消息");
            return;
          }
          pendingForkSelections.set(userId, messages);
          const lines = ["📋 可 fork 的消息："];
          messages.forEach((m, i) => {
            const preview = m.text.replace(/\n/g, " ").slice(0, 60);
            lines.push(`${i + 1}. ${preview || "(空消息)"}`);
          });
          lines.push("", "回复数字编号选择 fork 起点");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, lines.join("\n"));
          log(`[slash] /fork → ${messages.length} 条消息 (user=${userId})`);
          break;
        }

        case "help": {
          const helpText = [
            "📋 可用命令：",
            "/new — 新建 session",
            "/compact [instructions] — 压缩上下文",
            "/abort — 中止当前任务",
            "/session — 查看 session 状态",
            "/status — 查看会话状态 + 队列信息",
            "/usage — 查看用量统计（token/费用）",
            "/messages — 查看对话消息",
            "/export [path] — 导出 session 为 HTML",
            "/resume — 恢复历史 session",
            "/model [name] — 切换模型（带参数直接切换，无参数列出）",
            "/cycle-model — 轮播模型",
            "/image <url> — 分析一张网络图片",
            "/send-image <url> — 直接发送一张图片到微信",
            "/send-file <url> [name] — 发送一个文件到微信",
            "/search <query> — 联网搜索并总结",
            "/thinking [level] — 设置/切换 thinking level",
            "/steer-mode <mode> — 设置 steering 模式",
            "/follow-mode <mode> — 设置 follow-up 模式",
            "/auto-compact <on|off> — 自动压缩开关",
            "/auto-retry <on|off> — 自动重试开关",
            "/abort-retry — 中止重试",
            "/clone — 克隆当前 session",
            "/fork — 从历史消息 fork",
            "/last — 最后一条 assistant 回复",
            "/name <name> — 设置 session 名称",
            "/memory — 查看长期记忆",
            "/help — 显示此帮助",
            "",
            "Pi 扩展命令也可以直接发送，如 /skill:xxx",
          ].join("\n");
          await sendWeixinReply(api, account, userId, contextToken, sessionId, helpText);
          log(`[slash] /help (user=${userId})`);
          break;
        }

        default: {
          // 未知命令 —— 通用转发给 Pi
          const fullCmd = cmd.args ? `/${cmd.command} ${cmd.args}` : `/${cmd.command}`;
          if (rpcClient.isStreaming) {
            rpcClient.sendPromptSteer(fullCmd);
          } else {
            rpcClient.sendPrompt(fullCmd);
          }
          await sendWeixinReply(api, account, userId, contextToken, sessionId,
            `✅ 已转发: ${fullCmd}`);
          log(`[slash] 通用转发: ${fullCmd} (user=${userId})`);
          break;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logWarn(`[slash] 命令 /${cmd.command} 执行失败: ${errMsg}`);
      await sendWeixinReply(
        api,
        account,
        userId,
        contextToken,
        sessionId,
        formatClassifiedError(err),
      ).catch(() => {});
    }
  }

  /**
   * Execute a shell command via Pi's RPC bash tool and reply the output to the WeChat user.
   * The bash result is automatically stored as a BashExecutionMessage in Pi's message state
   * and will be included in the LLM context on the next prompt (same as TUI `!` behavior).
   */
  async function handleBashCommand(
    cmd: BashCommand,
    account: WeixinAccount,
    userId: string,
    contextToken: string,
    sessionId: string,
    sessionKey: string,
  ): Promise<void> {
    if (!rpcClient) return;

    try {
      const result = (await rpcClient.sendBash(cmd.command)) as {
        output: string;
        exitCode: number;
        cancelled: boolean;
        truncated: boolean;
        fullOutputPath?: string;
      };

      let outputText = result.output ?? "";
      if (result.truncated && result.fullOutputPath) {
        outputText += `\n\n(输出已截断，完整日志: ${result.fullOutputPath})`;
      }

      const exitEmoji = result.exitCode === 0 ? "✅" : `❌ (exit ${result.exitCode})`;
      const cancelledTag = result.cancelled ? " ⏹️ 已取消" : "";

      // Reply to WeChat user with command output
      const userReply = `${exitEmoji} \`${cmd.command}\`${cancelledTag}\n\`\`\`\n${outputText}\n\`\`\``;
      await sendWeixinReply(api, account, userId, contextToken, sessionId, userReply);


    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logWarn(`[bash] 执行失败: ${errMsg}`);
      await sendWeixinReply(
        api,
        account,
        userId,
        contextToken,
        sessionId,
        formatClassifiedError(err),
      ).catch(() => {});
    }
  }

  /** Whether we're currently processing a WeChat-triggered agent turn. */
  let processingWeixin = false;

  /** Text of the most recent RPC/agent error, used to classify failed turns. */
  let lastAgentError: string | null = null;

  // ── Rate limiting (anti-spam) ────────────────────────────────────────
  /** Per-user token buckets: userId → {count, windowStart}. */
  const rateBuckets = new Map<string, { count: number; windowStart: number }>();
  /** Last time a rate-limit notice was sent to each user. */
  const rateLimitedNotifiedAt = new Map<string, number>();

  /** Whether this user has exceeded their per-minute message budget. */
  function isRateLimited(userId: string): boolean {
    const max = config.rateLimitMax ?? 0;
    if (max <= 0) return false;
    const now = Date.now();
    const windowMs = 60_000;
    const bucket = rateBuckets.get(userId);
    if (!bucket || now - bucket.windowStart >= windowMs) {
      rateBuckets.set(userId, { count: 1, windowStart: now });
      return false;
    }
    bucket.count += 1;
    return bucket.count > max;
  }

  /** Send a rate-limit notice to a user, at most once per minute. */
  function notifyRateLimited(account: WeixinAccount, userId: string, contextToken: string, sessionId: string): void {
    const now = Date.now();
    if ((rateLimitedNotifiedAt.get(userId) ?? 0) + 60_000 > now) return;
    rateLimitedNotifiedAt.set(userId, now);
    sendWeixinReply(api, account, userId, contextToken, sessionId,
      "⏳ 消息发送过于频繁，请稍后再试。").catch(() => {});
  }

  // ── Fire-and-forget UI notification buffer (debounced merging) ───────
  /** Buffered notification lines waiting to be sent. */
  const uiNotifyBuffer: string[] = [];
  /** Routing context captured with the first buffered notification. */
  let uiNotifyCtx: PendingContext | null = null;
  let uiNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last forwarded notification text + time (for progress-spam dedup). */
  let lastNotifyText = "";
  let lastNotifyAt = 0;

  /** Flush buffered notifications as a single WeChat message. */
  function flushUiNotifications(): void {
    if (uiNotifyTimer) {
      clearTimeout(uiNotifyTimer);
      uiNotifyTimer = null;
    }
    if (uiNotifyBuffer.length === 0) return;
    const batch = uiNotifyBuffer.splice(0);
    const ctx = uiNotifyCtx;
    uiNotifyCtx = null;
    if (ctx) {
      sendWeixinReply(
        api, ctx.account, ctx.userId, ctx.contextToken, ctx.sessionId,
        batch.join("\n"),
      ).catch((err) => log(`[weixin] 通知合并发送失败: ${err}`));
    }
  }

  /** Buffer a notification; consecutive ones are merged after 1.5s. */
  function bufferUiNotification(ctx: PendingContext, text: string): void {
    // Dedup: identical notification text within 30s is progress spam from
    // a long agentic turn — forward it only once.
    const now = Date.now();
    if (text === lastNotifyText && now - lastNotifyAt < 30_000) {
      logDebug(`[rpc] 忽略重复通知: ${text.slice(0, 60)}`);
      return;
    }
    lastNotifyText = text;
    lastNotifyAt = now;
    logDebug(`[rpc] notify 转发: ${text.slice(0, 80)}`);

    uiNotifyCtx = uiNotifyCtx ?? ctx;
    uiNotifyBuffer.push(text);
    if (uiNotifyTimer) return;
    uiNotifyTimer = setTimeout(() => {
      uiNotifyTimer = null;
      flushUiNotifications();
    }, 1500);
  }

  /** Active poller instances (stopped/restarted during reconnect). */
  const pollers: Poller[] = [];

  // ── Poller callbacks ─────────────────────────────────────────────────

  const onPollLog: LogCallback = (msg) => {
    log(`[poller] ${msg}`);
  };

  const onMessage: MessageCallback = (account, msg, text, imageItem, fileItem, voiceItem, videoItem) => {
    // Guard: if Pi is not connected, discard messages (reconnect in progress)
    if (!rpcClient) {
      log(`[weixin] 收到消息但 Pi 未连接，丢弃: ${text.slice(0, 40)}...`);
      return;
    }
    lastActivityAt = Date.now();

    const userId = msg.from_user_id ?? "";
    const contextToken = msg.context_token ?? "";
    const sessionId = msg.session_id ?? "";

    // ── Allowlist check ─────────────────────────────────────────────
    const allow = config.allowlist ?? [];
    if (allow.length > 0 && !allow.includes(userId)) {
      logDebug(`[weixin] 用户 ${userId} 不在白名单，忽略消息: ${text.slice(0, 40)}`);
      return;
    }

    // ── Blocklist check ─────────────────────────────────────────────
    const blocked = config.blocklist ?? [];
    if (blocked.includes(userId)) {
      logDebug(`[weixin] 用户 ${userId} 在黑名单，忽略消息`);
      return;
    }

    // ── Rate limit (anti-spam) ──────────────────────────────────────
    if (isRateLimited(userId)) {
      logDebug(`[weixin] 用户 ${userId} 触发限流，丢弃消息: ${text.slice(0, 40)}`);
      notifyRateLimited(account, userId, contextToken, sessionId);
      return;
    }

    // ── Group chat mode check ───────────────────────────────────────
    if (msg.group_id && !config.groupChat) {
      logDebug(`[weixin] 群聊消息 (group=${msg.group_id}) 已忽略（groupChat=false）`);
      return;
    }

    // ── Session routing key ─────────────────────────────────────────
    // Private messages share the default session (""); group messages
    // (when enabled) use a per-sender session keyed by from_user_id,
    // gated on @<botName> mentions when botName is configured.
    let sessionKey = "";
    if (msg.group_id) {
      const botName = (config.botName ?? "").trim();
      if (botName && !text.includes(`@${botName}`)) {
        logDebug(`[weixin] 群聊消息未 @${botName}，忽略 (group=${msg.group_id})`);
        return;
      }
      sessionKey = userId;
    }

    // Save context token for this user (must echo verbatim in replies)
    if (userId && contextToken) {
      saveContextToken(account.id, userId, contextToken);
    }

    log(`[weixin] 收到消息: ${text.slice(0, 60)}${text.length > 60 ? "..." : ""} | from=${userId} ctx=${contextToken.slice(0, 20)}...`);

    // Load latest context token from storage (may have been updated)
    const tokens = loadContextTokens(account.id);
    const latestToken = tokens[userId] ?? contextToken;

    // Track the most recent routing context (webhook default target)
    const senderCtx: PendingContext = { account, userId, contextToken: latestToken, sessionId, sessionKey };
    lastSenders.set(account.id, senderCtx);
    lastSenderGlobal = senderCtx;

    // ── Pending model selection check (for /model flow) ─────────────
    const pendingModels = pendingModelSelections.get(userId);
    if (pendingModels) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= pendingModels.length) {
        pendingModelSelections.delete(userId);
        const model = pendingModels[num - 1] as Record<string, unknown>;
        const modelId = (model.id ?? model.modelId ?? "") as string;
        const provider = (model.provider ?? "") as string;

        void (async () => {
          try {
            await rpcClient!.setModel(provider, modelId);
            invalidateVisionCache();
            const name = (model.name ?? modelId) as string;
            await sendWeixinReply(
              api,
              account,
              userId,
              latestToken,
              sessionId,
              `✅ 已切换模型: ${name}`,
            );
            log(`[slash] 模型已切换: ${name} (user=${userId})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logWarn(`[slash] 切换模型失败: ${errMsg}`);
            await sendWeixinReply(
              api,
              account,
              userId,
              latestToken,
              sessionId,
              formatClassifiedError(err),
            ).catch(() => {});
          }
        })();
        return;
      }
      // Not a valid selection number — clear pending and fall through
      pendingModelSelections.delete(userId);
    }

    // ── Pending resume selection check (for /resume flow) ──────────
    const pendingSessions = pendingResumeSelections.get(userId);
    if (pendingSessions) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= pendingSessions.length) {
        pendingResumeSelections.delete(userId);
        const session = pendingSessions[num - 1];

        void (async () => {
          try {
            const result = (await rpcClient!.switchSession(session.path)) as Record<string, unknown> | null;
            const cancelled = result?.data ? (result.data as Record<string, unknown>).cancelled : false;
            if (cancelled) {
              await sendWeixinReply(api, account, userId, latestToken, sessionId, "⚠️ Session 切换被取消");
            } else {
              await sendWeixinReply(
                api, account, userId, latestToken, sessionId,
                `✅ 已恢复 session: ${session.label}`,
              );
              await persistCurrentSession(account.id, sessionKey);
            }
            log(`[slash] session 已切换: ${session.path} (user=${userId})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logWarn(`[slash] 切换 session 失败: ${errMsg}`);
            await sendWeixinReply(
              api, account, userId, latestToken, sessionId,
              formatClassifiedError(err),
            ).catch(() => {});
          }
        })();
        return;
      }
      // Not a valid selection — clear pending and fall through
      pendingResumeSelections.delete(userId);
    }

    // ── Pending fork selection check (for /fork flow) ─────────────────
    const pendingForks = pendingForkSelections.get(userId);
    if (pendingForks) {
      const num = parseInt(text.trim(), 10);
      if (!isNaN(num) && num >= 1 && num <= pendingForks.length) {
        pendingForkSelections.delete(userId);
        const forkMsg = pendingForks[num - 1];

        void (async () => {
          try {
            const result = (await rpcClient!.fork(forkMsg.entryId)) as { text?: string; cancelled?: boolean } | null;
            const cancelled = result?.cancelled;
            if (cancelled) {
              await sendWeixinReply(api, account, userId, latestToken, sessionId, "⚠️ Fork 被取消");
            } else {
              const preview = result?.text ? result.text.replace(/\n/g, " ").slice(0, 60) : "";
              await sendWeixinReply(
                api, account, userId, latestToken, sessionId,
                `✅ 已从消息 fork\n原文: ${preview || "(空)"}`,
              );
              await persistCurrentSession(account.id, sessionKey);
            }
            log(`[slash] fork 完成: ${forkMsg.entryId} (user=${userId})`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            logWarn(`[slash] fork 失败: ${errMsg}`);
            await sendWeixinReply(
              api, account, userId, latestToken, sessionId,
              formatClassifiedError(err),
            ).catch(() => {});
          }
        })();
        return;
      }
      // Not a valid selection — clear pending and fall through
      pendingForkSelections.delete(userId);
    }

    // ── Slash command detection ───────────────────────────────────────
    const slashResult = parseSlashCommand(text);
    if (slashResult) {
      void handleSlashCommand(slashResult, account, userId, latestToken, sessionId, sessionKey);
      return;
    }

    // ── Bash command detection (! / !!) ───────────────────────────────
    const bashResult = parseBashCommand(text);
    if (bashResult) {
      void handleBashCommand(bashResult, account, userId, latestToken, sessionId, sessionKey);
      return;
    }

    // ── Route by state machine ─────────────────────────────────────────
    if (sm.isWaitingUIResponse) {
      const uiReq = sm.pendingUIRequest!;

      // Only the user whose turn is waiting may answer the dialog;
      // other users' messages are queued until the turn completes.
      if (pendingContext && userId !== pendingContext.userId) {
        logDebug(`[weixin] 用户 ${userId} 的消息在 UI 等待期间被排队`);
        enqueueMessage({
          account, userId, contextToken: latestToken, sessionId, sessionKey,
          text: enrichMessageText(msg, text), imageItem, fileItem, voiceItem, videoItem,
        });
        return;
      }

      log(`[weixin] 当前状态=WAITING_UI_RESPONSE (${uiReq.method}), 解释为 UI 回复`);

      // Parse the user's response into an extension_ui_response payload
      const parsed = parseUserResponse(text, uiReq.method, uiReq.options);
      log(`[weixin] 解析 UI 回复: ${JSON.stringify(parsed)}`);

      // Send the response back to Pi via stdin
      try {
        rpcClient.sendExtensionUIResponse(uiReq.requestId, parsed);
      } catch (err) {
        log(`[rpc] 发送 UI 响应失败: ${err}`);
      }

      // Transition back to agent-running (Pi continues processing)
      sm.setAgentRunning();

      return;
    }

    // ── Enrich message text (group attribution, quoted message) ───────
    const enrichedText = enrichMessageText(msg, text);

    // ── Normal message: inject or queue ────────────────────────────────
    if (!processingWeixin && !rpcClient.isStreaming) {
      // Pi is idle — inject immediately
      injectMessage({
        account,
        userId,
        contextToken: latestToken,
        sessionId,
        sessionKey,
        text: enrichedText,
        imageItem,
        fileItem,
        voiceItem,
        videoItem,
      }).catch((err) => log(`[weixin] 注入失败: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      // Pi is busy or already processing — queue
      const wasQueueEmpty = messageQueue.length === 0;
      log(`[weixin] Pi 忙碌，消息入队 (队列长度: ${messageQueue.length + 1})`);
      enqueueMessage({
        account,
        userId,
        contextToken: latestToken,
        sessionId,
        sessionKey,
        text: enrichedText,
        imageItem,
        fileItem,
        voiceItem,
        videoItem,
      });
      // Let the user know their message is queued (first one per busy period)
      if (wasQueueEmpty) {
        sendWeixinReply(api, account, userId, latestToken, sessionId,
          "⏳ 前一条消息还在处理中，你的消息已排队，完成后会回复。",
        ).catch(() => {});
      }
    }
  };

  // ── Message injection / queue ────────────────────────────────────────

  /**
   * Inject a WeChat message into Pi.
   * Appends TUI-disable hint at configured interval.
   * If the message contains an image, downloads and converts it first.
   */
  async function injectMessage(qm: QueuedMessage): Promise<void> {
    if (!rpcClient) return;

    processingWeixin = true;
    pendingContext = {
      account: qm.account,
      userId: qm.userId,
      contextToken: qm.contextToken,
      sessionId: qm.sessionId,
      sessionKey: qm.sessionKey,
    };

    // ── Ensure the correct per-user session is active before prompting ──
    try {
      await ensureSessionFor(qm.account, qm.sessionKey);
    } catch (err) {
      logWarn(`[weixin] 会话切换异常: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Auto-compact if the previous turn left the context near full ──
    await compactIfNeeded();

    // ── Per-user model mapping (E2) ─────────────────────────────────
    await applyUserModel(qm.userId);

    // ── Snapshot usage baseline for cost attribution (E1) ──────────
    usageBaseline = null;
    try {
      const stats = (await rpcClient.getSessionStats()) as {
        tokens?: { total?: number } | null;
        cost?: number | null;
      } | null;
      usageBaseline = { tokens: stats?.tokens?.total ?? 0, cost: stats?.cost ?? 0 };
    } catch {
      /* ignore */
    }

    let messageText = qm.text;
    let imagePath: string | null = null;
    let imageContent: ImageContent | null = null;

    // ── Image processing (single download: save locally + base64) ──────
    if (qm.imageItem) {
      try {
        log(`[weixin] 处理图片...`);
        const media = await downloadImageForWeixin(qm.imageItem);
        if (media) {
          imagePath = media.path;
          imageContent = media.content;
          log(`[weixin] 图片已保存: ${media.path}`);
        } else {
          log(`[weixin] 图片处理失败：无法获取图片 URL`);
          await sendWeixinReply(
            api,
            qm.account,
            qm.userId,
            qm.contextToken,
            qm.sessionId,
            "⚠️ 图片下载失败，仅发送文本",
          );
        }
      } catch (err) {
        log(`[weixin] 图片处理异常: ${err instanceof Error ? err.message : String(err)}`);
        await sendWeixinReply(
          api,
          qm.account,
          qm.userId,
          qm.contextToken,
          qm.sessionId,
          "⚠️ 图片下载失败，仅发送文本",
        ).catch(() => {});
      }
    }

    // ── Append image path; decide attach-vs-subagent by model capability ──
    //   * attachImages=true       → always attach base64 (user override)
    //   * visionAgent + vision    → attach base64 directly (primary model sees)
    //   * visionAgent + no vision → instruct Pi to delegate to the vision subagent
    let attachImage = false;
    if (imagePath) {
      messageText += `\n\n[用户发送了一张图片]\n🖼️ ${imagePath}`;
      if (config.attachImages) {
        attachImage = true;
      } else if (config.visionAgent && rpcClient) {
        const modelVision = await getModelHasVision(rpcClient);
        if (modelVision) {
          attachImage = true;
        } else {
          const subagent = config.visionSubagent ?? "vision";
          messageText +=
            `\n\n【系统指令】当前模型不支持图片输入。请使用 subagent 工具调用 "${subagent}"` +
            ` 子代理来分析这张图片（该子代理使用多模态模型描述图片内容），然后基于它的描述回复用户。`;
        }
      }
    }

    // ── File processing (store locally, give path to Pi) ──────────────
    let filePath: string | null = null;
    if (qm.fileItem) {
      try {
        log(`[weixin] 处理文件...`);
        const savedPath = await saveFileLocally(qm.fileItem);
        if (savedPath) {
          filePath = savedPath;
          log(`[weixin] 文件已保存: ${savedPath}`);
        } else {
          log(`[weixin] 文件处理失败：无法获取下载 URL`);
        }
      } catch (err) {
        const fileName = qm.fileItem.file_name ?? "unknown";
        log(`[weixin] 文件处理异常 (${fileName}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append file path to message text if present
    if (filePath) {
      const fileName = qm.fileItem?.file_name ?? "unknown";
      let fileNote = `\n\n[用户发送了一个文件：${fileName}]\n📄 ${filePath}`;

      // Auto-convert documents to Markdown in the pipeline (deterministic):
      // the model receives the document content directly, no tool call needed.
      if (config.autoConvertDocuments !== false) {
        const converted = await convertDocumentToMarkdown(filePath, {
          maxChars: config.documentMaxChars,
          maxFileMb: config.documentMaxMb,
        });
        if (converted && converted.markdown.trim().length > 0) {
          fileNote += `\n\n【文档内容（已自动转换为 Markdown）】\n${converted.markdown}`;
          if (converted.truncated) {
            fileNote += `\n\n…[文档全文共 ${converted.totalChars} 字符，仅显示前 ${config.documentMaxChars ?? 8000} 字符；如需完整内容，可让 Pi 用 convert_document 工具读取整个文件]`;
          }
        } else if (converted && converted.markdown.trim().length === 0) {
          fileNote += `\n（该文件未能提取出文本内容，可能为扫描件/纯图片，可让 Pi 用视觉能力分析）`;
        } else {
          fileNote += `\n（如需读取该文件内容，请调用 convert_document 工具转换）`;
        }
      } else {
        fileNote += `\n（如需读取该文件内容，请调用 convert_document 工具转换）`;
      }

      messageText += fileNote;
    }

    // ── Voice processing (save locally, give path + transcript to Pi) ─
    let voicePath: string | null = null;
    if (qm.voiceItem) {
      try {
        log(`[weixin] 处理语音...`);
        const savedPath = await saveVoiceLocally(qm.voiceItem);
        if (savedPath) {
          voicePath = savedPath;
          log(`[weixin] 语音已保存: ${savedPath}`);
        } else {
          log(`[weixin] 语音处理失败：无法获取下载 URL`);
        }
      } catch (err) {
        log(`[weixin] 语音处理异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append voice path to message text if present
    if (voicePath) {
      messageText += `\n\n[用户发送了一条语音]\n🎤 ${voicePath}`;
    }

    // ── Video processing (save locally, give path to Pi) ────────────
    let videoPath: string | null = null;
    if (qm.videoItem) {
      try {
        log(`[weixin] 处理视频...`);
        const savedPath = await saveVideoLocally(qm.videoItem);
        if (savedPath) {
          videoPath = savedPath;
          log(`[weixin] 视频已保存: ${savedPath}`);
        } else {
          log(`[weixin] 视频处理失败：无法获取下载 URL`);
        }
      } catch (err) {
        log(`[weixin] 视频处理异常: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Append video path to message text if present
    if (videoPath) {
      messageText += `\n\n[用户发送了一个视频]\n🎬 ${videoPath}`;
    }

    // Ensure message is not empty
    if (!messageText.trim()) {
      // Image-only message whose download failed and no other content:
      // nothing meaningful to send to Pi — abort this turn quietly.
      if (qm.imageItem && !imagePath && !filePath && !voicePath && !videoPath) {
        log("[weixin] 图片下载失败且无其他内容，跳过本次处理");
        pendingContext = null;
        processingWeixin = false;
        flushQueue();
        return;
      }
      messageText = imagePath ? "[图片]" : filePath ? "[文件]" : voicePath ? "[语音]" : videoPath ? "[视频]" : "[空消息]";
    }

    // ── Attach base64 image when the active model supports vision ──
    let imageContents: ImageContent[] | null = null;
    if (attachImage && imageContent) {
      imageContents = [imageContent];
      log(`[weixin] 图片已附加到 prompt (${imageContent.mimeType})`);
    }

    // ── Prepend persona / memory context ─────────────────────────────
    const ctxPrefix = buildContextPrefixForConfig();
    if (ctxPrefix) {
      messageText = ctxPrefix + messageText;
    }

    const summary = messageText.slice(0, 60) || "[空消息]";
    const fileInfo = qm.fileItem ? ` + 文件: ${qm.fileItem.file_name ?? "unknown"}` : "";
    log(`[weixin] 发送 prompt: ${summary}${messageText.length > 60 ? "..." : ""}${imagePath ? ` + 图片: ${imagePath}` : ""}${voicePath ? ` + 语音: ${voicePath}` : ""}${videoPath ? ` + 视频: ${videoPath}` : ""}${fileInfo}`);
    rpcClient.sendPrompt(messageText, imageContents ?? undefined);
  }

  /**
   * Process the message queue.
   * Only injects when Pi is truly idle (not streaming, not waiting for UI).
   */
  function flushQueue(): void {
    if (!rpcClient || processingWeixin || messageQueue.length === 0) return;

    // Don't dequeue while Pi is busy or waiting for user input
    if (rpcClient.isStreaming || sm.isWaitingUIResponse) return;

    const next = dequeueMessage()!;
    log(`[weixin] 队列有 ${messageQueue.length + 1} 条消息，注入下一条`);
    setImmediate(() => {
      injectMessage(next).catch((err) => log(`[weixin] 队列注入失败: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  // ── Typing indicator ─────────────────────────────────────────────────
  /** Cached typing tickets: `${accountId}:${userId}` → ticket. */
  const typingTickets = new Map<string, string>();

  async function getTypingTicket(
    account: WeixinAccount,
    userId: string,
    contextToken: string,
  ): Promise<string | null> {
    const key = `${account.id}:${userId}`;
    const cached = typingTickets.get(key);
    if (cached) return cached;
    try {
      const resp = await api.getConfig(userId, account.botToken, contextToken, account.baseUrl);
      if (resp.typing_ticket) {
        typingTickets.set(key, resp.typing_ticket);
        return resp.typing_ticket;
      }
    } catch (err) {
      logDebug(`[weixin] 获取 typing ticket 失败 (${userId}): ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }

  /** Fire-and-forget typing status to a user. */
  function sendTypingStatus(
    account: WeixinAccount,
    userId: string,
    contextToken: string,
    status: 1 | 2,
  ): void {
    if (!config.typingIndicator) return;
    void getTypingTicket(account, userId, contextToken)
      .then((ticket) => {
        if (!ticket) return;
        return api
          .sendTyping(userId, ticket, status, account.botToken, account.baseUrl)
          .catch((err) => {
            logDebug(`[weixin] typing 状态发送失败: ${err instanceof Error ? err.message : String(err)}`);
          });
      });
  }

  /** Keepalive interval that refreshes the typing indicator during long turns. */
  let typingKeepalive: ReturnType<typeof setInterval> | null = null;

  /** Keep the '正在输入' indicator alive every 5s while a turn runs. */
  function startTypingKeepalive(ctx: PendingContext): void {
    if (!config.typingIndicator) return;
    stopTypingKeepalive();
    typingKeepalive = setInterval(() => {
      sendTypingStatus(ctx.account, ctx.userId, ctx.contextToken, 1);
    }, 5_000);
    typingKeepalive.unref?.();
  }

  /** Stop the typing keepalive (called at turn finalize). */
  function stopTypingKeepalive(): void {
    if (typingKeepalive) {
      clearInterval(typingKeepalive);
      typingKeepalive = null;
    }
  }

  // ── Media outbox (Pi writes manifests; daemon sends them as attachments) ──
  const OUTBOX_DIR = path.join(os.homedir(), ".config", "pi-weixin-cli", "outbox");

  interface OutboxManifest {
    type?: string;
    url?: string;
    caption?: string;
  }

  /** Scan and remove outbox manifests; returns the media items to send. */
  function drainOutbox(): OutboxManifest[] {
    const items: OutboxManifest[] = [];
    try {
      if (!fs.existsSync(OUTBOX_DIR)) return items;
      for (const file of fs.readdirSync(OUTBOX_DIR)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(OUTBOX_DIR, file);
        try {
          const manifest = JSON.parse(fs.readFileSync(filePath, "utf-8")) as OutboxManifest;
          if (manifest && typeof manifest.url === "string" && manifest.url) {
            items.push(manifest);
          }
        } catch {
          logWarn(`[weixin] outbox 清单解析失败: ${file}`);
        }
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      logWarn(`[weixin] 扫描 outbox 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    return items;
  }

  /** Send a URL-based media item to a WeChat user. */
  async function sendWeixinMedia(
    account: WeixinAccount,
    toUserId: string,
    contextToken: string,
    sessionId: string,
    manifest: OutboxManifest,
  ): Promise<void> {
    const isFile = manifest.type === "file";
    const item = isFile
      ? { type: MessageItemType.FILE, file_item: { media: { full_url: manifest.url }, file_name: manifest.caption ?? "file" } }
      : { type: MessageItemType.IMAGE, image_item: { url: manifest.url } };
    try {
      await api.sendMessage(
        {
          msg: {
            from_user_id: "",
            client_id: crypto.randomUUID(),
            to_user_id: toUserId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            create_time_ms: Date.now(),
            item_list: [item] as never[],
            context_token: contextToken,
            session_id: sessionId || undefined,
          },
        },
        account.botToken,
        account.baseUrl,
      );
      log(`[weixin] 媒体消息已发送 (${isFile ? "file" : "image"}): ${(manifest.url ?? "").slice(0, 80)}`);
    } catch (err) {
      logWarn(`[weixin] 媒体消息发送失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Persona / memory / execution-rule injection (C2 + habit) ─────────

  /**
   * Build the system-context prefix for prompts:
   * persona + long-term memory + the discussion-first execution rule.
   */
  function buildContextPrefixForConfig(): string {
    const parts: string[] = [];
    const base = buildContextPrefix(config.persona);
    if (base) parts.push(base);
    if (config.requireApproval !== false) {
      parts.push(
        "【执行规则】除非用户明确要求执行（如说“请执行/请修改/请运行/帮我做/直接改”），" +
        "否则只进行讨论和回答，不要调用工具、运行命令或修改任何文件。" +
        "如果用户的需求需要执行操作，先给出简短计划并询问“是否执行？”，" +
        "得到用户明确同意后再行动。",
      );
    }
    return parts.length > 0 ? parts.join("\n\n") + "\n\n---\n\n" : "";
  }

  // ── Auto-compact + usage tracking (C3/E1) ────────────────────────────

  /** Whether the next idle turn should compact first (set by stats check). */
  let needsCompact = false;

  /** Baseline (tokens/cost) captured at inject time for this turn's deltas. */
  let usageBaseline: { tokens: number; cost: number } | null = null;
  /** Whether the cost alert has already fired this run. */
  let costAlerted = false;

  /**
   * After a turn: record usage deltas, set the auto-compact flag, and
   * fire the cost alert when the monthly budget is exceeded.
   */
  async function afterTurnStats(accountId: string, sessionKey: string): Promise<void> {
    if (!rpcClient) return;
    try {
      const stats = (await rpcClient.getSessionStats()) as {
        tokens?: { total?: number } | null;
        cost?: number | null;
        contextUsage?: { percent?: number | null } | null;
      } | null;
      const totalTokens = stats?.tokens?.total ?? 0;
      const totalCost = stats?.cost ?? 0;

      // ── Usage deltas (E1) ─────────────────────────────────────────
      if (usageBaseline) {
        const tDelta = totalTokens - usageBaseline.tokens;
        const cDelta = totalCost - usageBaseline.cost;
        if (tDelta > 0 || cDelta > 0) {
          addUsage(accountId, sessionKey, tDelta, cDelta);
        }
      }
      usageBaseline = null;

      // ── Auto-compact flag (C3) ────────────────────────────────────
      const threshold = config.autoCompactThreshold ?? 0;
      const percent = stats?.contextUsage?.percent;
      if (threshold > 0 && typeof percent === "number" && percent >= threshold) {
        needsCompact = true;
        log(`[rpc] 上下文使用率 ${percent.toFixed(1)}% ≥ ${threshold}%，下轮自动压缩`);
      }

      // ── Cost alert (E1) ───────────────────────────────────────────
      const budget = config.costAlert ?? 0;
      if (budget > 0 && !costAlerted) {
        const spent = totalAccountCost(accountId);
        if (spent >= budget) {
          costAlerted = true;
          logWarn(`[usage] 本月费用 $${spent.toFixed(2)} 已超过预算 $${budget}！`);
          const target = lastSenderGlobal;
          if (target) {
            sendWeixinReply(
              api, target.account, target.userId, target.contextToken, target.sessionId,
              `💸 费用提醒：本月已花费 $${spent.toFixed(2)}，达到预算上限 $${budget}。`,
            ).catch(() => {});
          }
        }
      }
    } catch {
      usageBaseline = null;
    }
  }

  /** Compact once if flagged (idle-only; clears the flag either way). */
  async function compactIfNeeded(): Promise<void> {
    if (!needsCompact || !rpcClient) return;
    needsCompact = false;
    try {
      await rpcClient.compact();
      log("[rpc] 已自动压缩上下文");
    } catch (err) {
      logWarn(`[rpc] 自动压缩失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── RPC Event Binding ────────────────────────────────────────────────

  /**
   * Finalize the current WeChat-triggered turn: send the reply, release the
   * typing indicator, drain the media outbox, persist the session, and
   * resume queue processing. Idempotent (no-op when no turn is pending).
   */
  async function finalizeTurn(): Promise<void> {
    if (!turnData) return;
    const aborted = pendingAbort || turnData.aborted;
    const wasUserAbort = pendingAbort;
    pendingAbort = false;
    const { messages } = turnData;
    turnData = null;
    if (turnWatchdog) {
      clearTimeout(turnWatchdog);
      turnWatchdog = null;
    }
    if (turnAbortTimer) {
      clearTimeout(turnAbortTimer);
      turnAbortTimer = null;
    }

    const reply = extractAssistantReply(messages);
    const hasPending = pendingContext !== null;
    lastActivityAt = Date.now();

    // Deliver buffered notifications before the turn's context is cleared
    // (prevents them leaking into the next user's turn).
    flushUiNotifications();

    log(`[rpc] finalize turn | aborted=${aborted} hasPending=${hasPending} hasReply=${!!reply}`);

    if (hasPending && pendingContext) {
      const ctx = pendingContext;
      pendingContext = null;

      // Release the typing indicator first (and stop the keepalive)
      stopTypingKeepalive();
      sendTypingStatus(ctx.account, ctx.userId, ctx.contextToken, 2);

      if (aborted) {
        if (wasUserAbort) {
          // The /abort command already acknowledged with ✅ — sending a
          // second ⏹️ here would duplicate the confirmation.
          log("[rpc] 回合已按用户中止处理");
        } else {
          // Pi aborted on its own (no /abort) — inform the user.
          await sendWeixinReply(
            api, ctx.account, ctx.userId, ctx.contextToken, ctx.sessionId,
            "⏹️ 已中止当前任务",
          ).catch(() => {});
        }
      } else if (reply) {
        // ── Format + split long replies, apply status prefix ────────
        const chunks = formatAndSplit(reply, config.maxReplyLength ?? 2000);
        const prefix = config.replyPrefix ?? "";
        for (const chunk of chunks) {
          await sendWeixinReply(
            api, ctx.account, ctx.userId, ctx.contextToken, ctx.sessionId,
            `${prefix}${chunk}`,
          );
        }

        // ── Media outbox: Pi-written manifests are sent as attachments ──
        const outboxItems = drainOutbox();
        for (const item of outboxItems) {
          await sendWeixinMedia(ctx.account, ctx.userId, ctx.contextToken, ctx.sessionId, item);
        }
      } else {
        log("[weixin] 未找到 assistant 文本回复");
        // Notify user with a classified error prompt when possible
        const msg = lastAgentError
          ? formatClassifiedError(lastAgentError)
          : "⚠️ Pi 未生成回复。可能是当前模型不支持此输入（如图片），或处理异常。可发送 /model 切换模型。";
        await sendWeixinReply(
          api, ctx.account, ctx.userId, ctx.contextToken, ctx.sessionId,
          msg,
        ).catch(() => {});
      }

      // ── Persist the session file path (per-user map, for resume) ──
      await persistCurrentSession(ctx.account.id, ctx.sessionKey);

      // ── Usage tracking + auto-compact flag + cost alert (E1/C3) ──
      void afterTurnStats(ctx.account.id, ctx.sessionKey);

      processingWeixin = false;
    } else if (reply) {
      // Got a reply but no pending context — Pi retried after we cleared context
      log(`[weixin] 发现延迟回复但 pendingContext 已清空: ${reply.slice(0, 60)}...`);
    }

    // Transition to idle + process next queued message
    sm.setIdle();
    flushQueue();
  }

  /**
   * Bind all RPC event handlers to a (new) RpcClient instance.
   * The "exit" handler triggers the reconnect loop instead of exiting.
   */
  function bindRpcEvents(client: RpcClient): void {
    client.on("agent_start", () => {
      log("[rpc] agent_start");
      lastAgentError = null;
      pendingAbort = false; // a new turn means the previous abort is moot
      sm.setAgentRunning();
      // Show the typing indicator while Pi works, refreshed by a keepalive
      if (pendingContext) {
        sendTypingStatus(pendingContext.account, pendingContext.userId, pendingContext.contextToken, 1);
        startTypingKeepalive(pendingContext);
      }
    });

    client.on("agent_end", (event: AgentEndEvent) => {
      const willRetry = event.willRetry ?? false;
      turnData = { messages: event.messages, aborted: event.aborted ?? false };
      lastActivityAt = Date.now();

      if (willRetry) {
        // An automatic retry follows — hold the turn instead of replying
        // prematurely with an error. Finalize on the retried run's
        // agent_end or on agent_settled (with a watchdog backstop).
        log(`[rpc] agent_end (willRetry=true) — 等待重试...`);
        if (turnWatchdog) clearTimeout(turnWatchdog);
        turnWatchdog = setTimeout(() => {
          logWarn(`[rpc] agent_settled 未在超时内到达，强制结束回合`);
          void finalizeTurn();
        }, 120_000);
        return;
      }

      void finalizeTurn();
    });

    client.on("agent_settled", () => {
      log("[rpc] agent_settled");
      // Finalize any still-pending turn (retries, queued continuations).
      if (turnData) {
        void finalizeTurn();
      }
    });

    client.on("message_update", () => {
      // Silent — we only care about the final reply
    });

    /**
     * Handle extension_ui_request events from Pi.
     *
     * Two categories:
     *   1. Fire-and-forget (notify, setStatus, setWidget, setTitle,
     *      set_editor_text) — just forward to WeChat, no response expected.
     *   2. Dialog (select, confirm, input, editor) — store pending UI request,
     *      forward to WeChat, wait for user's reply.
     */
    client.on("extension_ui_request", (event: ExtensionUIRequestEvent) => {
      const method = event.method;
      log(`[rpc] extension_ui_request: method=${method} id=${event.id}`);

      // ── Fire-and-forget: merge into a debounced notification buffer ──
      if (isFireAndForget(method)) {
        if (pendingContext) {
          const formatted = formatUIRequestForWeixin(event);
          if (formatted) {
            bufferUiNotification(pendingContext, formatted);
          }
        } else {
          log(`[rpc] 忽略 ${method} (无活跃微信会话)`);
        }
        return;
      }

      // ── Dialog: block until user responds ──────────────────────────────
      // Only bridge to WeChat if we're currently processing a WeChat message
      if (!pendingContext) {
        log(`[rpc] 忽略 ${method} (无活跃微信会话，Pi 将等待超时)`);
        return;
      }

      const ctx = pendingContext;
      // Deliver any buffered notifications before asking the question
      flushUiNotifications();
      const formatted = formatUIRequestForWeixin(event);

      // Send the question to WeChat
      if (formatted) {
        sendWeixinReply(
          api,
          ctx.account,
          ctx.userId,
          ctx.contextToken,
          ctx.sessionId,
          formatted,
        ).catch((err) => log(`[weixin] UI 请求发送失败: ${err}`));
      }

      // Extract timeout (in ms) from the event — it's optional on select/confirm/input
      const timeoutMs = event.timeout;

      // Build UI request context for the state machine
      const uiCtx: UIRequestContext = {
        requestId: event.id,
        method: method as UIMethod,
        account: ctx.account,
        userId: ctx.userId,
        contextToken: ctx.contextToken,
        sessionId: ctx.sessionId,
        title: event.title,
        message: event.message,
        placeholder: event.placeholder,
        prefill: event.prefill,
        options: event.options,
      };

      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        uiCtx.timeoutAt = Date.now() + timeoutMs;
        uiCtx.timeoutId = setTimeout(() => {
          log(`[rpc] UI 请求 ${event.id} (${method}) 超时，发送 cancelled`);
          try {
            // Use the current rpcClient at timeout time, not the closure
            if (rpcClient && rpcClient.isRunning) {
              rpcClient.sendExtensionUIResponse(event.id, { cancelled: true });
            }
          } catch (err) {
            log(`[rpc] 发送 cancelled 响应失败: ${err}`);
          }
          sm.setAgentRunning();
        }, timeoutMs);
      }

      sm.setWaitingUIResponse(uiCtx);
    });

    client.on("tool_execution_start", (event) => {
      log(`[rpc] tool_start: ${event.toolName ?? "unknown"}`);
    });

    client.on("tool_execution_end", () => {
      // Silent — tool results are large
    });

    client.on("response", (event) => {
      if (!event.success) {
        const errText = event.error ?? "unknown";
        lastAgentError = errText;
        logWarn(`[rpc] response error: ${event.command} → ${errText} (${classifyError(errText).category})`);

        // A rejected prompt/steer produces no agent events — finalize the
        // pending turn so the user gets the classified error instead of
        // waiting forever.
        if ((event.command === "prompt" || event.command === "steer") && pendingContext && !turnData) {
          turnData = { messages: [], aborted: false };
          void finalizeTurn();
        }
      }
    });

    client.on("error", (err) => {
      lastAgentError = err.message;
      logWarn(`[rpc] error: ${err.message} (${classifyError(err).category})`);
    });

    // ── Exit → Auto-Reconnect ──────────────────────────────────────────
    client.on("exit", async (code, signal) => {
      log(`[rpc] Pi 子进程已退出 (code=${code}, signal=${signal})`);
      rpcClient = null;
      await reconnect();
    });
  }

  // ── Reconnect Logic ──────────────────────────────────────────────────

  /**
   * Restart the Pi RPC subprocess with exponential backoff.
   *
   * Parameters:
   *   - Base delay: 2s, max: 60s
   *   - Jitter: random 0–1000ms per attempt
   *   - Max retries: 10 (total worst-case ≈ 570s)
   *
   * On success: pollers are restarted, message flow resumes.
   * On failure after max retries: process exits with code 1.
   */
  async function reconnect(): Promise<void> {
    if (shuttingDown) return;

    // ── Stop all pollers (no point receiving messages without Pi) ─────
    for (const poller of pollers) {
      poller.stop();
    }
    pollers.length = 0;
    log("[rpc] 所有轮询器已停止（等待 Pi 重连）");

    // ── Reset volatile state ──────────────────────────────────────────
    sm.setIdle();
    messageQueue.length = 0;
    try {
      fs.rmSync(QUEUE_FILE, { force: true });
    } catch {
      /* ignore */
    }
    pendingContext = null;
    processingWeixin = false;
    turnData = null;
    stopTypingKeepalive();
    if (turnWatchdog) {
      clearTimeout(turnWatchdog);
      turnWatchdog = null;
    }

    // ── Exponential backoff retry loop ────────────────────────────────
    const maxRetries = 10;
    const baseDelay = 2_000;
    const maxDelay = 60_000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (shuttingDown) {
        log("[rpc] 重连期间收到关闭信号，退出。");
        process.exit(0);
      }

      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      const jitter = Math.random() * 1_000;
      const totalDelay = delay + jitter;

      log(
        `[rpc] 重连尝试 ${attempt}/${maxRetries}，等待 ${Math.round(totalDelay)}ms...`,
      );
      await new Promise((r) => setTimeout(r, totalDelay));

      try {
        const newClient = new RpcClient(undefined, {
          persistentSession: config.persistentSession ?? true,
        });
        await newClient.spawn();
        rpcClient = newClient;
        bindRpcEvents(newClient);

        // Re-apply default model after reconnect
        await applyDefaultModel(newClient);
        sessionOwnerKey = null; // fresh RPC process → fresh session

        log(
          `[rpc] 重连成功 (PID: ${(newClient as any).proc?.pid ?? "unknown"})`,
        );

        // ── Restart pollers ───────────────────────────────────────────
        for (const account of accounts) {
          const poller = new Poller(api, account, onMessage, onPollLog);
          poller.start();
          pollers.push(poller);

          api
            .notifyStart(account.botToken, account.baseUrl)
            .then(() => log(`[weixin] notifyStart OK for ${account.id}`))
            .catch((err) =>
              log(`[weixin] notifyStart failed for ${account.id}: ${err}`),
            );
        }
        log(`[rpc] 已重启 ${pollers.length} 个轮询器`);

        return; // Success — reconnect complete
      } catch (err) {
        log(
          `[rpc] 重连失败 (${attempt}/${maxRetries}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ── Exhausted retries ──────────────────────────────────────────────
    log(`[rpc] 重连失败，已达最大重试次数 (${maxRetries})，退出。`);
    process.exit(1);
  }

  // ── Spawn initial Pi RPC subprocess ──────────────────────────────────
  log("正在启动 Pi RPC 子进程...");

  try {
    const initialClient = new RpcClient(undefined, {
      persistentSession: config.persistentSession ?? true,
    });
    await initialClient.spawn();
    rpcClient = initialClient;
    bindRpcEvents(initialClient);

    // ── Apply default model ────────────────────────────────────────
    await applyDefaultModel(initialClient);

    log(
      `Pi RPC 子进程已启动 (PID: ${(initialClient as any).proc?.pid ?? "unknown"})`,
    );
  } catch (err) {
    log(
      `启动 Pi RPC 子进程失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  // ── Start Pollers ────────────────────────────────────────────────────

  for (const account of accounts) {
    const poller = new Poller(api, account, onMessage, onPollLog);
    poller.start();
    pollers.push(poller);

    // Notify WeChat backend that this bot is online
    api
      .notifyStart(account.botToken, account.baseUrl)
      .then(() => log(`[weixin] notifyStart OK for ${account.id}`))
      .catch((err) => log(`[weixin] notifyStart failed for ${account.id}: ${err}`));
  }

  log(`${pollers.length} 个轮询器已启动`);

  // ── Webhook API (Pi extensions / scripts can push messages) ──────────

  /** Resolve the target routing context for a webhook/scheduler push. */
  function resolveWebhookTarget(user: string): PendingContext | null {
    if (user) {
      // Explicit user: look up their saved context token on any account
      for (const account of accounts) {
        const tokens = loadContextTokens(account.id);
        if (tokens[user]) {
          return { account, userId: user, contextToken: tokens[user], sessionId: "", sessionKey: "" };
        }
      }
      return null;
    }
    // Default: most recent in-memory sender, else any stored user token
    // (so scheduled pushes work right after a daemon restart).
    if (lastSenderGlobal) return lastSenderGlobal;
    if (lastSenders.size > 0) return lastSenders.values().next().value as PendingContext;
    for (const account of accounts) {
      const tokens = loadContextTokens(account.id);
      const entries = Object.entries(tokens);
      if (entries.length > 0) {
        return {
          account,
          userId: entries[0][0],
          contextToken: entries[0][1],
          sessionId: "",
          sessionKey: "",
        };
      }
    }
    return null;
  }

  /** Webhook /send and /notify handler (same formatting pipeline as replies). */
  async function sendWebhookText(
    user: string,
    text: string,
    asNotify: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const target = resolveWebhookTarget(user);
    if (!target) {
      return { ok: false, error: "没有可用的接收者（用户尚未发过消息，或未指定 user）" };
    }
    const prefix = asNotify ? "⚡ " : (config.replyPrefix ?? "");
    const chunks = formatAndSplit(text, config.maxReplyLength ?? 2000);
    for (const chunk of chunks) {
      await sendWeixinReply(
        api, target.account, target.userId, target.contextToken, target.sessionId,
        `${prefix}${chunk}`,
      );
    }
    return { ok: true };
  }

  /** Webhook /media handler. */
  async function sendWebhookMedia(
    user: string,
    media: { type?: string; url: string; caption?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const target = resolveWebhookTarget(user);
    if (!target) {
      return { ok: false, error: "没有可用的接收者（用户尚未发过消息，或未指定 user）" };
    }
    await sendWeixinMedia(target.account, target.userId, target.contextToken, target.sessionId, {
      type: media.type,
      url: media.url,
      caption: media.caption,
    });
    return { ok: true };
  }

  const webhookPort = config.webhookPort ?? 0;
  if (webhookPort > 0) {
    try {
      if (!config.webhookToken) {
        config.webhookToken = crypto.randomBytes(16).toString("hex");
        saveConfig(config);
      }
      webhookServer = await startWebhookServer(
        config.webhookToken,
        {
          sendText: (user, text) => sendWebhookText(user, text, false),
          sendNotify: (user, text) => sendWebhookText(user, text, true),
          sendMedia: (user, media) => sendWebhookMedia(user, media),
        },
        webhookPort,
      );
      log(`[webhook] HTTP API 已启动: http://127.0.0.1:${webhookServer.port} (token: ${config.webhookToken.slice(0, 6)}...)`);
    } catch (err) {
      logWarn(`[webhook] 启动失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Graceful Shutdown ────────────────────────────────────────────────

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log(`收到 ${signal}，正在优雅关闭...`);

    // Stop all pollers
    for (const poller of pollers) {
      poller.stop();
    }
    log("所有轮询器已停止");

    // Close the webhook server
    if (webhookServer) {
      await webhookServer.close();
      webhookServer = null;
      log("[webhook] HTTP API 已关闭");
    }

    // Notify backend that we're going offline
    for (const account of accounts) {
      try {
        await api.notifyStop(account.botToken, account.baseUrl);
        log(`[weixin] notifyStop OK for ${account.id}`);
      } catch {
        // Best effort
      }
    }

    // Kill Pi subprocess (if still running)
    if (rpcClient && rpcClient.isRunning) {
      rpcClient.kill();
      log("已发送 SIGTERM 到 Pi 子进程");
    }

    // Give a short grace period for cleanup, then exit
    setTimeout(() => {
      log("退出。");
      process.exit(0);
    }, 2000).unref();
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch(() => {});
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch(() => {});
  });

  // ── Scheduler (cron-style: daily HH:MM or every:N minutes) ───────────
  /** Last time each schedule key fired (ms) — for every:N and dedup. */
  const scheduleLastFired = new Map<string, number>();
  /** Which day a daily schedule already fired (key → YYYY-MM-DD). */
  const scheduleFiredDay = new Map<string, string>();

  function parseScheduleKey(
    key: string,
  ): { kind: "daily"; hh: number; mm: number; ss: number } | { kind: "every"; minutes: number } | null {
    const trimmed = key.trim();
    const everyMatch = trimmed.match(/^every:(\d+)$/i);
    if (everyMatch) {
      const minutes = parseInt(everyMatch[1], 10);
      if (minutes > 0) return { kind: "every", minutes };
      return null;
    }
    const dailyMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (dailyMatch) {
      const hh = parseInt(dailyMatch[1], 10);
      const mm = parseInt(dailyMatch[2], 10);
      const ss = dailyMatch[3] ? parseInt(dailyMatch[3], 10) : 0;
      if (hh < 24 && mm < 60 && ss < 60) return { kind: "daily", hh, mm, ss };
    }
    return null;
  }

  /** Fire one schedule: push-mode sends text directly; otherwise inject a pi prompt. */
  async function fireSchedule(key: string, message: string): Promise<void> {
    const target = resolveWebhookTarget("");
    if (!target) {
      logWarn(`[sched] ${key} 触发但没有可用的接收者（用户尚未发过消息）`);
      return;
    }
    const pushMode = message.startsWith("push:");
    const text = pushMode ? message.slice(5).trim() : message;

    if (pushMode) {
      const prefix = config.replyPrefix ?? "";
      await sendWeixinReply(api, target.account, target.userId, target.contextToken, target.sessionId, `${prefix}${text}`);
      log(`[sched] ${key} 推送: ${text.slice(0, 60)}`);
      return;
    }

    // Prompt mode: inject into pi like a user message
    const qm: QueuedMessage = {
      account: target.account,
      userId: target.userId,
      contextToken: target.contextToken,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      text: `【定时任务 ${key}】${text}`,
    };
    if (!processingWeixin && !rpcClient?.isStreaming && !sm.isWaitingUIResponse) {
      await injectMessage(qm).catch((err) =>
        logWarn(`[sched] 注入失败: ${err instanceof Error ? err.message : String(err)}`),
      );
    } else {
      enqueueMessage(qm);
      setImmediate(() => flushQueue());
      log(`[sched] ${key} 已排队注入`);
    }
  }

  /** Check all schedules; fires due ones. Called every 15s. */
  async function checkSchedules(): Promise<void> {
    const schedules = config.schedules ?? {};
    const now = new Date();
    const nowMs = Date.now();
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    for (const [key, message] of Object.entries(schedules)) {
      const spec = parseScheduleKey(key);
      if (!spec) {
        if (!scheduleLastFired.has(key)) {
          logWarn(`[sched] 无效的调度键 "${key}"（支持 HH:MM 或 every:N）`);
          scheduleLastFired.set(key, nowMs);
        }
        continue;
      }

      if (spec.kind === "daily") {
        if (scheduleFiredDay.get(key) === today) continue;
        const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        const targetSeconds = spec.hh * 3600 + spec.mm * 60 + spec.ss;
        // Fire within the 15s check window right after the target time
        if (currentSeconds >= targetSeconds && currentSeconds < targetSeconds + 20) {
          scheduleFiredDay.set(key, today);
          await fireSchedule(key, message);
        }
      } else {
        const last = scheduleLastFired.get(key) ?? 0;
        if (nowMs - last >= spec.minutes * 60_000) {
          scheduleLastFired.set(key, nowMs);
          await fireSchedule(key, message);
        }
      }
    }
  }

  // ── Start status heartbeat ──────────────────────────────────────────
  writeStatusHeartbeat();
  setInterval(writeStatusHeartbeat, 5_000).unref();

  // ── Start scheduler (every 15s) ─────────────────────────────────────
  setInterval(() => {
    void checkSchedules();
  }, 15_000).unref();

  // ── Process any messages recovered from a previous run ──────────────
  // flushQueue normally only fires on agent_end; at startup nothing
  // triggers it, so recovered queue items would sit forever.
  if (messageQueue.length > 0) {
    log(`[queue] 开始处理 ${messageQueue.length} 条恢复的消息`);
    setImmediate(() => flushQueue());
  }

  log("pi-weixin-hub RPC 模式已启动，等待微信消息...");
}

// ── Entry ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ── Background fork (E3) ────────────────────────────────────────────
  if (args[0] === "--fork") {
    const stateDir = path.join(os.homedir(), ".config", "pi-weixin-cli");
    fs.mkdirSync(stateDir, { recursive: true });
    const ownEntry = fileURLToPath(import.meta.url); // dist/main.js
    const child = spawn(process.execPath, [ownEntry, "daemon"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true, // hide the console window on Windows
      env: { ...process.env, PI_FORKED: "1" },
    });
    child.unref();
    try {
      fs.writeFileSync(path.join(stateDir, "daemon.pid"), String(child.pid ?? ""), "utf-8");
    } catch {
      /* ignore */
    }
    console.log(`pi-weixin-hub daemon 已后台启动 (PID ${child.pid ?? "?"})`);
    console.log("日志: ~/.config/pi-weixin-cli/daemon.log（未配置 logFile 时自动启用）");
    process.exit(0);
  }

  if (args.length === 0 || args[0] === "daemon") {
    await runDaemon();
  } else {
    const exitCode = await runCLI(args);
    process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(`致命错误: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

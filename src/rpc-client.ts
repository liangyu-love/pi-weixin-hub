// ── Pi RPC Client ──────────────────────────────────────────────────────
// JSONL communication layer for the Pi RPC protocol.
// Spawns `pi --mode rpc` and communicates via stdin/stdout.
//
// Protocol:
//   stdin  → write JSONL commands (each line is a JSON object terminated by \n)
//   stdout → read JSONL events  (each line is a JSON object terminated by \n)
//   stderr → diagnostic output (collected for debugging)
//
// JSONL parsing uses raw Buffer scanning for \n (0x0A) — Node's readline
// is NOT used because it also splits on U+2028/U+2029, violating JSONL spec.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { EventEmitter } from "node:events";
import { Logger, type LogLevel } from "./logger.js";
import type {
  RpcStdinCommand,
  RpcStdoutEvent,
  AgentStartEvent,
  AgentEndEvent,
  AgentSettledEvent,
  MessageUpdateEvent,
  ExtensionUIRequestEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
  ResponseEvent,
  ImageContent,
} from "./types-rpc.js";

// ── Constants ──────────────────────────────────────────────────────────

const DEFAULT_PI_PATH = "/home/qq110/.npm-global/bin/pi";

// ── Module logger (level synced from the daemon config) ─────────────────

const rpcLogger = new Logger("info", "rpc");

/** Sync the RPC module's log level from the daemon config. */
export function setRpcLogLevel(level: LogLevel): void {
  rpcLogger.setLevel(level);
}

// ── Pi executable resolution ────────────────────────────────────────────

/** A resolved spawn target: an executable plus optional leading args. */
interface ResolvedTarget {
  command: string;
  args: string[];
}

/** PATH entries, split per platform. */
export function pathEntries(): string[] {
  const raw = process.env.PATH ?? "";
  return raw.split(path.delimiter).filter(Boolean);
}

/** Find `pi` (or pi.exe/.cmd/.bat on Windows) on PATH. */
export function findPiOnPath(): string | null {
  const isWin = process.platform === "win32";
  const names = isWin ? ["pi.exe", "pi.cmd", "pi.bat", "pi"] : ["pi"];
  for (const dir of pathEntries()) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* keep searching */
      }
    }
  }
  return null;
}

/**
 * Resolve how to launch the `pi` CLI:
 *   1. PI_PATH env var (spawned directly)
 *   2. Hardcoded upstream Linux install path, if present locally
 *   3. `pi` found on PATH — derive the real Node entry
 *      (node_modules/@earendil-works/pi-coding-agent/dist/cli.js) and
 *      spawn `node <cli.js>`; this works for npm/scoop shims (pi.cmd)
 *      that Node's spawn cannot execute directly on Windows.
 */
export function resolvePiTarget(piPath?: string): ResolvedTarget {
  const explicit = piPath ?? process.env.PI_PATH;
  if (explicit) {
    // If PI_PATH points directly at the CLI JS entry, run it via node
    // (a .js file is not directly executable on Windows).
    if (/cli\.js$/i.test(explicit)) {
      return { command: process.execPath, args: [explicit] };
    }
    return { command: explicit, args: [] };
  }

  try {
    if (fs.existsSync(DEFAULT_PI_PATH)) {
      return { command: DEFAULT_PI_PATH, args: [] };
    }
  } catch {
    /* fall through */
  }

  const found = findPiOnPath();
  if (found) {
    const base = path.dirname(found);
    const cliJs = path.join(
      base,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    try {
      if (fs.existsSync(cliJs)) {
        return { command: process.execPath, args: [cliJs] };
      }
    } catch {
      /* fall through */
    }
    return { command: found, args: [] };
  }

  // Last resort: let the OS resolve "pi" (works when shell is involved).
  return { command: "pi", args: [] };
}

/** Max accumulated stderr bytes to retain for diagnostics. */
const MAX_STDERR_BYTES = 64 * 1024;

// ── Spawn options ────────────────────────────────────────────────────────

/** Options controlling how the Pi RPC subprocess is spawned. */
export interface RpcSpawnOptions {
  /**
   * Whether to persist the Pi session across restarts.
   * true  → omit `--no-session` (Pi saves the session, can be resumed).
   * false → pass `--no-session` (ephemeral, context is discarded on exit).
   */
  persistentSession?: boolean;
}

// ── Event payload types for strongly-typed listeners ──────────────────

export interface RpcClientEvents {
  agent_start: [event: AgentStartEvent];
  agent_end: [event: AgentEndEvent];
  agent_settled: [event: AgentSettledEvent];
  message_update: [event: MessageUpdateEvent];
  extension_ui_request: [event: ExtensionUIRequestEvent];
  tool_execution_start: [event: ToolExecutionStartEvent];
  tool_execution_end: [event: ToolExecutionEndEvent];
  response: [event: ResponseEvent];
  /** Emitted when the Pi child process writes to stderr. */
  stderr: [text: string];
  /** Emitted when the Pi child process exits. */
  exit: [code: number | null, signal: string | null];
  /** Emitted on fatal errors (spawn failure, JSON parse errors, etc). */
  error: [err: Error];
}

// ── RpcClient ──────────────────────────────────────────────────────────

export class RpcClient extends EventEmitter<RpcClientEvents> {
  private proc: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private stderrAcc = "";
  private _isStreaming = false;
  private readonly piPath: string;
  private readonly persistentSession: boolean;
  private readonly spawnTarget: ResolvedTarget;

  /** Pending requests awaiting a response event, keyed by request id. */
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private requestIdCounter = 0;

  constructor(piPath?: string, opts: RpcSpawnOptions = {}) {
    super();
    this.spawnTarget = resolvePiTarget(piPath);
    this.piPath = this.spawnTarget.command;
    this.persistentSession = opts.persistentSession ?? true;
  }

  // ── Public accessors ─────────────────────────────────────────────────

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  get stderr(): string {
    return this.stderrAcc;
  }

  get exitCode(): number | null {
    return this.proc?.exitCode ?? null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Spawn the Pi RPC subprocess.
   * Returns a Promise that resolves once the process is spawned and
   * stdout is ready for reading (or rejects on immediate spawn failure).
   */
  spawn(): Promise<void> {
    if (this.proc) {
      throw new Error("RpcClient: already spawned");
    }

    return new Promise<void>((resolve, reject) => {
      const args = [...this.spawnTarget.args, "--mode", "rpc"];
      if (!this.persistentSession) {
        args.push("--no-session");
      }
      const child = spawn(this.spawnTarget.command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.proc = child;

      // Handle immediate spawn errors (e.g. ENOENT)
      child.on("error", (err: Error) => {
        this.emit("error", err);
        reject(err);
      });

      // stdout: JSONL event stream
      child.stdout?.on("data", (chunk: Buffer) => {
        this.onStdoutData(chunk);
      });

      // stderr: diagnostic output
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8");
        this.stderrAcc += text;
        // Truncate to prevent unbounded memory growth
        if (this.stderrAcc.length > MAX_STDERR_BYTES) {
          this.stderrAcc = this.stderrAcc.slice(-MAX_STDERR_BYTES);
        }
        this.emit("stderr", text);
      });

      child.on("exit", (code, signal) => {
        this._isStreaming = false;
        this.emit("exit", code, signal);
      });

      // Give the process a moment to start
      const checkTimer = setTimeout(() => {
        if (child.exitCode !== null) {
          const errMsg = this.stderrAcc.slice(0, 500) || "(no stderr output)";
          const err = new Error(
            `Pi RPC process exited immediately (code ${child.exitCode}). Stderr: ${errMsg}`,
          );
          this.emit("error", err);
          reject(err);
        } else {
          resolve();
        }
      }, 800);

      child.on("exit", () => {
        clearTimeout(checkTimer);
      });
    });
  }

  /**
   * Kill the Pi subprocess gracefully (SIGTERM).
   * Returns true if a signal was sent, false if already exited.
   */
  kill(): boolean {
    if (!this.proc) return false;
    return this.proc.kill("SIGTERM");
  }

  // ── Commands ─────────────────────────────────────────────────────────

  /** Send a prompt command to Pi, optionally with images. */
  sendPrompt(message: string, images?: ImageContent[]): void {
    if (images && images.length > 0) {
      this.sendCommand({ type: "prompt", message, images } as unknown as RpcStdinCommand);
    } else {
      this.sendCommand({ type: "prompt", message });
    }
  }

  /** Send a steer command to Pi (interrupt + redirect), optionally with images. */
  sendSteer(message: string, images?: ImageContent[]): void {
    if (images && images.length > 0) {
      this.sendCommand({ type: "steer", message, images } as unknown as RpcStdinCommand);
    } else {
      this.sendCommand({ type: "steer", message });
    }
  }

  /** Send an abort command to Pi. */
  sendAbort(): void {
    this.sendCommand({ type: "abort" });
  }

  /**
   * Send an extension UI response back to Pi.
   * Used to answer select/confirm/input/editor requests from extensions.
   */
  sendExtensionUIResponse(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: true },
  ): void {
    const cmd: RpcStdinCommand = {
      type: "extension_ui_response",
      id,
      ...response,
    };
    this.sendCommand(cmd);
  }

  /**
   * Send a raw command object as a JSON line to Pi's stdin.
   * Automatically appends the \n record delimiter.
   * If the command doesn't have an id, one is auto-generated.
   */
  sendCommand(cmd: RpcStdinCommand): void {
    if (!this.proc || !this.proc.stdin || this.proc.exitCode !== null) {
      throw new Error("RpcClient: Pi process is not running");
    }
    const cmdRec = cmd as unknown as Record<string, unknown>;
    if (!cmdRec.id) {
      cmdRec.id = `req-${++this.requestIdCounter}`;
    }
    const line = JSON.stringify(cmd) + "\n";

    // Debug: log outgoing commands (truncate images to avoid noise)
    const cmdType = cmdRec.type as string;
    if (cmdType === "prompt" || cmdType === "steer") {
      const msg = cmdRec.message as string | undefined;
      const images = cmdRec.images as Array<{ mimeType?: string; data?: string }> | undefined;
      const imgInfo = images && images.length > 0
        ? images.map((img) => `${img.mimeType ?? "?"}(${(img.data ?? "").length}chars)`).join(", ")
        : "none";
      rpcLogger.debug(`[rpc→pi] ${cmdType} | msg="${msg?.slice(0, 200) ?? ""}${(msg?.length ?? 0) > 200 ? "..." : ""}" | images=${imgInfo}`);
    }

    this.proc.stdin.write(line);
  }

  // ── Synchronous commands (send + await response) ───────────────────

  /**
   * Send a command and wait for its response event.
   * The command's id is auto-generated and used to correlate the response.
   * Rejects after 30 seconds if no response arrives.
   */
  async sendCommandAndWaitResponse(
    cmd: { type: string; [key: string]: unknown },
  ): Promise<unknown> {
    const id = `req-${++this.requestIdCounter}`;
    const cmdWithId = { ...cmd, id } as RpcStdinCommand;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RpcClient: request ${id} timed out after 30s`));
      }, 30_000);

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.sendCommand(cmdWithId);
    });
  }

  /** Get current Pi session state (model, thinkingLevel, etc). */
  async getState(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_state" });
  }

  /** Create a new Pi session. */
  async newSession(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "new_session" });
  }

  /** Compact Pi conversation context. */
  async compact(customInstructions?: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({
      type: "compact",
      customInstructions,
    });
  }

  /** Get the list of available models from Pi. */
  async getAvailableModels(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_available_models" });
  }

  /** Set the active model in Pi. */
  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({
      type: "set_model",
      provider,
      modelId,
    });
  }

  /** Get the list of registered extension commands. */
  async getCommands(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_commands" });
  }

  /** Switch to an existing session by file path. */
  async switchSession(sessionPath: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({
      type: "switch_session",
      sessionPath,
    });
  }

  /** Get detailed session statistics (tokens, cost, context usage). */
  async getSessionStats(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_session_stats" });
  }

  /** Execute a shell command via Pi's bash tool and wait for the result. */
  async sendBash(command: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "bash", command });
  }

  /** Abort a running bash command. */
  async sendAbortBash(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "abort_bash" });
  }

  /** Get all messages in the current conversation. */
  async getMessages(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_messages" });
  }

  /** Cycle to the next available model. */
  async cycleModel(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "cycle_model" });
  }

  /** Set the thinking/reasoning level. */
  async setThinkingLevel(level: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "set_thinking_level", level });
  }

  /** Cycle through available thinking levels. */
  async cycleThinkingLevel(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "cycle_thinking_level" });
  }

  /** Set steering message delivery mode. */
  async setSteeringMode(mode: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "set_steering_mode", mode });
  }

  /** Set follow-up message delivery mode. */
  async setFollowUpMode(mode: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "set_follow_up_mode", mode });
  }

  /** Enable or disable automatic compaction. */
  async setAutoCompaction(enabled: boolean): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "set_auto_compaction", enabled });
  }

  /** Enable or disable automatic retry on transient errors. */
  async setAutoRetry(enabled: boolean): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "set_auto_retry", enabled });
  }

  /** Abort an in-progress retry. */
  async abortRetry(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "abort_retry" });
  }

  /** Export session to HTML. */
  async exportHtml(outputPath?: string): Promise<unknown> {
    const cmd: { type: string; [key: string]: unknown } = { type: "export_html" };
    if (outputPath) cmd.outputPath = outputPath;
    return this.sendCommandAndWaitResponse(cmd);
  }

  /** Fork from a previous user message. */
  async fork(entryId: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "fork", entryId });
  }

  /** Clone the current active branch into a new session. */
  async clone(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "clone" });
  }

  /** Get user messages available for forking. */
  async getForkMessages(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_fork_messages" });
  }

  /** Get the text of the last assistant message. */
  async getLastAssistantText(): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "get_last_assistant_text" });
  }

  /** Set a display name for the current session. */
  async setSessionName(name: string): Promise<unknown> {
    return this.sendCommandAndWaitResponse({ type: "set_session_name", name });
  }

  /** Send a prompt with steer streaming behavior (for forwarding unknown slash commands during streaming). */
  sendPromptSteer(message: string): void {
    this.sendCommand({ type: "prompt", message, streamingBehavior: "steer" } as unknown as RpcStdinCommand);
  }

  // ── Convenience ──────────────────────────────────────────────────────

  /**
   * Returns a Promise that resolves when Pi is idle (not streaming).
   * If already idle, resolves immediately.
   */
  waitForIdle(): Promise<void> {
    if (!this._isStreaming) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.once("agent_end", () => resolve());
    });
  }

  // ── Stdout parsing ───────────────────────────────────────────────────

  /**
   * Process incoming stdout data. Accumulates into an internal Buffer and
   * scans for \n (0x0A) to split JSONL records.
   *
   * JSONL spec: records are separated by a single newline character (\n).
   * We MUST NOT use readline because it also splits on U+2028 (LINE SEPARATOR)
   * and U+2029 (PARAGRAPH SEPARATOR), which can appear inside JSON string values.
   */
  private onStdoutData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf(0x0a)) !== -1) {
      const lineBytes = this.buffer.subarray(0, newlineIdx);
      this.buffer = this.buffer.subarray(newlineIdx + 1);

      // Skip empty lines
      if (lineBytes.length === 0) continue;

      const lineStr = lineBytes.toString("utf-8").trim();
      if (!lineStr) continue;

      try {
        const event = JSON.parse(lineStr) as RpcStdoutEvent;
        this.dispatchEvent(event);
      } catch {
        // Malformed JSON line — emit as error but don't crash
        this.emit("error", new Error(`RpcClient: failed to parse JSON line: ${lineStr.slice(0, 200)}`));
      }
    }
  }

  /**
   * Route a parsed stdout event to the appropriate typed event emitter.
   */
  private dispatchEvent(event: RpcStdoutEvent): void {
    switch (event.type) {
      case "agent_start":
        this._isStreaming = true;
        this.emit("agent_start", event as AgentStartEvent);
        break;

      case "agent_end":
        this._isStreaming = false;
        this.emit("agent_end", event as AgentEndEvent);
        break;

      case "agent_settled":
        this.emit("agent_settled", event as AgentSettledEvent);
        break;

      case "message_update":
        this.emit("message_update", event as MessageUpdateEvent);
        break;

      case "extension_ui_request":
        this.emit("extension_ui_request", event as ExtensionUIRequestEvent);
        break;

      case "tool_execution_start":
        this.emit("tool_execution_start", event as ToolExecutionStartEvent);
        break;

      case "tool_execution_end":
        this.emit("tool_execution_end", event as ToolExecutionEndEvent);
        break;

      case "response": {
        const resp = event as ResponseEvent;
        // Correlate with pending request if id matches
        if (resp.id && this.pendingRequests.has(resp.id)) {
          const pending = this.pendingRequests.get(resp.id)!;
          this.pendingRequests.delete(resp.id);
          if (resp.success === false) {
            pending.reject(
              new Error(resp.error ?? "RPC command failed"),
            );
          } else {
            pending.resolve(resp.data);
          }
        }
        // Always emit for other listeners (logging, etc)
        this.emit("response", resp);
        break;
      }

      default:
        // Unknown event type — log but don't crash
        break;
    }
  }
}

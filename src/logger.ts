// ── Logging ────────────────────────────────────────────────────────────
// Hierarchical log levels with timestamped output to stderr.
//
// Levels (increasing severity): debug < info < warn < error
//   - debug: verbose internals (message payloads, queue states, RPC noise)
//   - info:  normal operational events (startup, messages, replies)
//   - warn:  recoverable problems (download failures, send retries)
//   - error: fatal or serious failures (spawn failure, exhausted retries)
//
// The level is configurable via config.logLevel or the LOG_LEVEL env var.
// All output goes to stderr so stdout stays clean for RPC JSONL.

import process from "node:process";

// ── Types ──────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_NAMES: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

// ── Helpers ────────────────────────────────────────────────────────────

function toLocalISOString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, "0")}${tz}`;
}

// ── Logger ─────────────────────────────────────────────────────────────

export class Logger {
  private level: LogLevel;
  private readonly tag: string;

  constructor(level: LogLevel, tag = "") {
    this.level = level;
    this.tag = tag ? `[${tag}]` : "";
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  isEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  private write(level: LogLevel, msg: string): void {
    if (!this.isEnabled(level)) return;
    const ts = toLocalISOString(new Date());
    const levelTag = LEVEL_NAMES[level];
    process.stderr.write(`[${ts}] [${levelTag}]${this.tag} ${msg}\n`);
  }

  debug(msg: string): void {
    this.write("debug", msg);
  }

  info(msg: string): void {
    this.write("info", msg);
  }

  warn(msg: string): void {
    this.write("warn", msg);
  }

  error(msg: string): void {
    this.write("error", msg);
  }
}

// ── Level resolution ───────────────────────────────────────────────────

const VALID_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);

/** Parse a log level string (case-insensitive). Falls back to "info". */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value) {
    const normalized = value.trim().toLowerCase();
    if (VALID_LEVELS.has(normalized)) {
      return normalized as LogLevel;
    }
  }
  return "info";
}

/** Resolve the effective log level: LOG_LEVEL env var wins, else the given config value. */
export function resolveLogLevel(configLevel: LogLevel | undefined): LogLevel {
  return parseLogLevel(process.env.LOG_LEVEL ?? configLevel);
}

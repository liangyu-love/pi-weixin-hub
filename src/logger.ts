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
import fs from "node:fs";
import path from "node:path";

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

// ── File sink (shared across all Logger instances) ─────────────────────
// Optional file logging with size-based rotation: file, file.1, file.2.

let logFilePath: string | null = null;
let logFileMaxBytes = 5 * 1024 * 1024;

/**
 * Enable file logging for all loggers with size-based rotation.
 * Keeps at most 2 backups (file.1, file.2). Pass maxBytes=0 to disable rotation.
 */
export function setLogFile(filePath: string, maxBytes = 5 * 1024 * 1024): void {
  logFilePath = filePath;
  logFileMaxBytes = maxBytes > 0 ? maxBytes : 5 * 1024 * 1024;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    /* ignore */
  }
}

function rotateIfNeeded(): void {
  if (!logFilePath) return;
  try {
    if (!fs.existsSync(logFilePath)) return;
    if (fs.statSync(logFilePath).size < logFileMaxBytes) return;
    const f1 = `${logFilePath}.1`;
    const f2 = `${logFilePath}.2`;
    try {
      if (fs.existsSync(f2)) fs.unlinkSync(f2);
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync(f1)) fs.renameSync(f1, f2);
    } catch {
      /* ignore */
    }
    fs.renameSync(logFilePath, f1);
  } catch {
    /* ignore */
  }
}

function writeToFile(line: string): void {
  if (!logFilePath) return;
  rotateIfNeeded();
  try {
    fs.appendFileSync(logFilePath, line);
  } catch {
    /* ignore */
  }
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
    const line = `[${ts}] [${levelTag}]${this.tag} ${msg}\n`;
    process.stderr.write(line);
    writeToFile(line);
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

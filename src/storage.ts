// ── Local State Persistence ────────────────────────────────────────────
// All data stored under ~/.config/pi-weixin-cli/

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { WeixinAccount, WeixinSyncState } from "./types.js";

// ── Paths ──────────────────────────────────────────────────────────────

function getStateDir(): string {
  return path.join(os.homedir(), ".config", "pi-weixin-cli");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Sanitize an ID for use as a filename. */
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ── Account Storage ────────────────────────────────────────────────────

const ACCOUNTS_FILE = "accounts.json";

export function loadAccounts(): WeixinAccount[] {
  const filePath = path.join(getStateDir(), ACCOUNTS_FILE);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a: unknown): a is WeixinAccount =>
        typeof a === "object" &&
        a !== null &&
        typeof (a as WeixinAccount).userId === "string" &&
        typeof (a as WeixinAccount).botToken === "string",
    );
  } catch {
    return [];
  }
}

function saveAccounts(accounts: WeixinAccount[]): void {
  const dir = getStateDir();
  ensureDir(dir);
  fs.writeFileSync(
    path.join(dir, ACCOUNTS_FILE),
    JSON.stringify(accounts, null, 2),
    "utf-8",
  );
}

/** Add or update an account. */
export function registerAccount(account: WeixinAccount): void {
  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) {
    accounts[idx] = account;
  } else {
    accounts.push(account);
  }
  saveAccounts(accounts);
}

/** Remove an account and all its associated state. */
export function unregisterAccount(accountId: string): void {
  const accounts = loadAccounts().filter((a) => a.id !== accountId);
  saveAccounts(accounts);
  deleteSyncState(accountId);
  deleteContextTokens(accountId);
}

/** Find an account by its ID. */
export function findAccount(id: string): WeixinAccount | undefined {
  return loadAccounts().find((a) => a.id === id);
}

// ── Sync State (per-account) ───────────────────────────────────────────

const SYNC_BUF_DIR = "sync-buf";

function syncStatePath(accountId: string): string {
  return path.join(getStateDir(), SYNC_BUF_DIR, `${safeId(accountId)}.json`);
}

/** Load sync state (getUpdatesBuf + contextTokens) for an account. */
export function loadSyncState(accountId: string): WeixinSyncState {
  try {
    const filePath = syncStatePath(accountId);
    if (!fs.existsSync(filePath)) {
      return { getUpdatesBuf: "", contextTokens: {} };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as WeixinSyncState;
  } catch {
    return { getUpdatesBuf: "", contextTokens: {} };
  }
}

/** Save sync state for an account. */
export function saveSyncState(accountId: string, state: WeixinSyncState): void {
  const filePath = syncStatePath(accountId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

/** Update just the getUpdatesBuf cursor for an account. */
export function updateSyncBuf(accountId: string, buf: string): void {
  const state = loadSyncState(accountId);
  state.getUpdatesBuf = buf;
  saveSyncState(accountId, state);
}

function deleteSyncState(accountId: string): void {
  try {
    const filePath = syncStatePath(accountId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

// ── Per-user Session Map (multi-session routing) ───────────────────────

const SESSION_MAP_FILE = "sessions.json";
const LEGACY_SESSION_SUFFIX = "-last-session.json";

function sessionMapPath(accountId: string): string {
  return path.join(getStateDir(), `${safeId(accountId)}-${SESSION_MAP_FILE}`);
}

function legacySessionPath(accountId: string): string {
  return path.join(getStateDir(), `${safeId(accountId)}${LEGACY_SESSION_SUFFIX}`);
}

function saveSessionMap(accountId: string, map: Record<string, string>): void {
  const filePath = sessionMapPath(accountId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2), "utf-8");
}

/**
 * Load the per-user session map for an account.
 *
 * Session keys: "" = default/private session; otherwise a from_user_id
 * (per-sender session for group messages).
 *
 * Migrates the Phase 1 legacy `<account>-last-session.json` file into the
 * map under the default key ("/") on first load, then removes it.
 */
export function loadSessionMap(accountId: string): Record<string, string> {
  let map: Record<string, string> = {};
  try {
    const mapPath = sessionMapPath(accountId);
    if (fs.existsSync(mapPath)) {
      const parsed = JSON.parse(fs.readFileSync(mapPath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        map = { ...(parsed as Record<string, string>) };
      }
    }
  } catch {
    map = {};
  }

  // Migration: legacy single-session file → default (private) session key.
  try {
    const legacyPath = legacySessionPath(accountId);
    if (fs.existsSync(legacyPath)) {
      const legacy = fs.readFileSync(legacyPath, "utf-8").trim();
      if (legacy && !map[""]) {
        map[""] = legacy;
        saveSessionMap(accountId, map);
      }
      fs.unlinkSync(legacyPath);
    }
  } catch {
    // ignore migration errors
  }

  return map;
}

/** Load one session key's saved session path ("" = default/private). */
export function loadUserSession(accountId: string, sessionKey: string): string | null {
  const map = loadSessionMap(accountId);
  return map[sessionKey] ?? null;
}

/** Save one session key's session path ("" = default/private). */
export function saveUserSession(
  accountId: string,
  sessionKey: string,
  sessionPath: string,
): void {
  const map = loadSessionMap(accountId);
  map[sessionKey] = sessionPath;
  saveSessionMap(accountId, map);
}

// ── Context Token Storage (per-account, per-user) ──────────────────────

const CTX_TOKEN_DIR = "context-tokens";

function contextTokenPath(accountId: string): string {
  return path.join(getStateDir(), CTX_TOKEN_DIR, `${safeId(accountId)}.json`);
}

/** Load all context tokens for an account. */
export function loadContextTokens(accountId: string): Record<string, string> {
  try {
    const filePath = contextTokenPath(accountId);
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Save a single context token (userId → contextToken). */
export function saveContextToken(
  accountId: string,
  userId: string,
  token: string,
): void {
  const tokens = loadContextTokens(accountId);
  tokens[userId] = token;
  const filePath = contextTokenPath(accountId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), "utf-8");
}

/** Delete all context tokens for an account. */
export function deleteContextTokens(accountId: string): void {
  try {
    const filePath = contextTokenPath(accountId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

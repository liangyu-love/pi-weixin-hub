// ── Document converter (MarkItDown wrapper) ─────────────────────────────
// Converts incoming WeChat file messages to Markdown in the hub pipeline
// (deterministic — does not rely on the model choosing to call a tool).
//
// Backend: Microsoft MarkItDown via `python -m markitdown <path>`.
// Requirements: python 3.10+ with `pip install 'markitdown[pdf,docx,pptx,xlsx]'`.
//
// Design:
//   - Whitelist of file extensions; anything else is skipped (null).
//   - Size cap + timeout to keep the WeChat pipeline fast and safe.
//   - Any failure degrades to null → caller falls back to sending the
//     path to Pi (which can still use the convert_document tool).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Logger, type LogLevel } from "./logger.js";

// ── Module logger (level synced from the daemon config) ─────────────────

const logger = new Logger("info", "docconvert");

/** Sync the module log level from the daemon config. */
export function setDocConvertLogLevel(level: LogLevel): void {
  logger.setLevel(level);
}

// ── Constants ──────────────────────────────────────────────────────────

/** Extensions we attempt to convert. Everything else is passed through. */
const CONVERTIBLE_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".xls",
  ".pptx",
  ".html",
  ".htm",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".xml",
  ".epub",
]);

/** Default max size (MB) of files we will convert. */
export const DEFAULT_MAX_FILE_MB = 20;

/** Default max chars of converted Markdown sent to Pi. */
export const DEFAULT_MAX_CHARS = 8000;

/** Convert timeout in milliseconds. */
const CONVERT_TIMEOUT_MS = 60_000;

/** Python candidates; first one that passes `--version` wins. */
function pythonCandidates(): string[] {
  const envPy = process.env.PYTHON;
  const list = envPy ? [envPy, "python", "python3"] : ["python", "python3"];
  return [...new Set(list)];
}

let resolvedPython: string | null = null;

async function findPython(): Promise<string> {
  if (resolvedPython) return resolvedPython;
  for (const cmd of pythonCandidates()) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(cmd, ["--version"], { windowsHide: true });
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (ok) {
      resolvedPython = cmd;
      return cmd;
    }
  }
  throw new Error("未找到可用的 Python（需要 Python 3.10+）");
}

function runMarkItDown(python: string, filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-m", "markitdown", filePath], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), CONVERT_TIMEOUT_MS);
    child.on("error", (err) => { clearTimeout(timer); reject(new Error(`启动转换进程失败: ${err.message}`)); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const tail = stderr.trim().split("\n").slice(-3).join("\n");
        reject(new Error(`markitdown 转换失败 (exit ${code}): ${tail || "未知错误"}`));
      }
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────

export interface ConvertResult {
  /** Converted Markdown, truncated to maxChars when too long. */
  markdown: string;
  /** Total character count of the full converted output. */
  totalChars: number;
  /** True when output was truncated to maxChars. */
  truncated: boolean;
}

/**
 * Try to convert a document to Markdown.
 * Returns null when the file type is not convertible, the file is too
 * large, or conversion failed (caller should fall back to sending the
 * path to Pi). Never throws.
 */
export async function convertDocumentToMarkdown(
  filePath: string,
  opts: { maxChars?: number; maxFileMb?: number } = {},
): Promise<ConvertResult | null> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxFileMb = opts.maxFileMb ?? DEFAULT_MAX_FILE_MB;

  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!CONVERTIBLE_EXTENSIONS.has(ext)) return null;

    let sizeMb = 0;
    try {
      const st = await fs.promises.stat(filePath);
      sizeMb = st.size / (1024 * 1024);
    } catch {
      logger.warn(`文件不存在或不可读，跳过转换: ${filePath}`);
      return null;
    }
    if (sizeMb > maxFileMb) {
      logger.warn(`文件过大 (${sizeMb.toFixed(1)}MB > ${maxFileMb}MB)，跳过自动转换: ${filePath}`);
      return null;
    }

    const python = await findPython();
    const markdown = await runMarkItDown(python, filePath);
    const total = markdown.length;
    if (total === 0) {
      logger.info(`转换完成但无文本内容（可能为扫描件/纯图片）: ${filePath}`);
      return { markdown: "", totalChars: 0, truncated: false };
    }

    let out = markdown;
    let truncated = false;
    if (total > maxChars) {
      out = markdown.slice(0, maxChars);
      truncated = true;
    }
    logger.debug(`转换成功 ${filePath}: ${total} 字符${truncated ? `（截断至 ${maxChars}）` : ""}`);
    return { markdown: out, totalChars: total, truncated };
  } catch (err) {
    logger.warn(`文档转换失败，降级为发送路径: ${filePath} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

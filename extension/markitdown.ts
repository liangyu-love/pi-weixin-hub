// ── markitdown extension ───────────────────────────────────────────────
// Wraps Microsoft's MarkItDown (https://github.com/microsoft/markitdown)
// as a custom tool so Pi can convert documents (PDF/Word/Excel/PPT/HTML/
// text/EPUB/...) to Markdown in any session — global TUI chats AND the
// pi-weixin-hub RPC subprocess (global extensions load in both).
//
// Install: pip install 'markitdown[pdf,docx,pptx,xlsx]'  (see tool for deps)
//
// Tool the model can call:
//   convert_document({ path, max_chars? })
//
// Notes:
//  - Input is treated as untrusted (MarkItDown does I/O with process
//    privileges). Only pass paths you already trust; prefer local files.
//  - Output is truncated to max_chars to protect context budget.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

// ── Constants ──────────────────────────────────────────────────────────

const MAX_FILE_MB = 50; // refuse files larger than this
const CONVERT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CHARS = 20_000;

// Python candidates: env override first, then common names. On Windows the
// .cmd shim for `python` is unreliable when spawned non-interactively, but
// scoop's python.exe (in PATH) spawns fine. First candidate that passes a
// `--version` probe wins.
function pythonCandidates(): string[] {
  const envPy = process.env.PYTHON;
  const list = envPy ? [envPy, "python", "python3"] : ["python", "python3"];
  return [...new Set(list)];
}

let resolvedPython: string | null = null;

function findPython(): Promise<string> {
  if (resolvedPython) return Promise.resolve(resolvedPython);
  return new Promise((resolve, reject) => {
    const candidates = pythonCandidates();
    const tryNext = (i: number) => {
      if (i >= candidates.length) {
        reject(new Error("未找到可用的 Python。请安装 Python 3.10+ 并确保 `python` 在 PATH 中。"));
        return;
      }
      const cmd = candidates[i];
      const child = spawn(cmd, ["--version"], { windowsHide: true });
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on("error", () => { clearTimeout(timer); tryNext(i + 1); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) { resolvedPython = cmd; resolve(cmd); }
        else tryNext(i + 1);
      });
    };
    tryNext(0);
  });
}

function checkMarkItDownInstalled(python: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", "import markitdown; print(markitdown.__version__)"], {
      windowsHide: true,
    });
    let ok = false;
    child.stdout.on("data", () => { ok = true; });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0 && ok));
  });
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
        const tail = stderr.trim().split("\n").slice(-5).join("\n");
        reject(new Error(`markitdown 转换失败 (exit ${code}): ${tail || "未知错误"}`));
      }
    });
  });
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "convert_document",
    label: "Convert Document to Markdown",
    description:
      "把文档文件（PDF/Word/Excel/PPT/HTML/文本/CSV/JSON/XML/EPUB 等）转换为 Markdown 文本，便于 LLM 阅读与分析。传入本地文件绝对路径。返回转换后的 Markdown（超过 max_chars 会被截断）。适用于用户发来文档、需要读取其内容时。",
    parameters: Type.Object({
      path: Type.String({
        description:
          "本地文件的绝对路径（Windows 用 C:/... 或 C:\\... 格式）。PDF/Office/HTML/文本等格式均可。",
      }),
      max_chars: Type.Optional(
        Type.Number({
          description: "返回内容的最大字符数，超出自动截断并提示。默认 20000。",
          default: DEFAULT_MAX_CHARS,
        }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate) {
      try {
        const filePath = String(params.path ?? "").trim();
        if (!filePath) {
          return {
            content: [{ type: "text", text: "错误：必须提供 path 参数。" }],
            details: { isError: true },
          };
        }
        const maxChars = typeof params.max_chars === "number" ? params.max_chars : DEFAULT_MAX_CHARS;

        // Refuse URLs unless explicitly http(s) — keep I/O local-first
        if (/^https?:\/\//i.test(filePath)) {
          return {
            content: [
              {
                type: "text",
                text: "出于安全考虑，convert_document 只接受本地文件路径。如需处理 URL，请先下载到本地再转换。",
              },
            ],
            details: { isError: true },
          };
        }

        const { stat, realpath } = await import("node:fs/promises");
        let exists = false;
        let sizeMb = 0;
        try {
          const st = await stat(filePath);
          exists = true;
          sizeMb = st.size / (1024 * 1024);
        } catch {
          // fall through — also try realpath (handles relative forms)
          try {
            const rp = await realpath(filePath);
            const st = await stat(rp);
            exists = true;
            sizeMb = st.size / (1024 * 1024);
          } catch {
            // not found
          }
        }
        if (!exists) {
          return {
            content: [{ type: "text", text: `错误：文件不存在：${filePath}` }],
            details: { isError: true },
          };
        }
        if (sizeMb > MAX_FILE_MB) {
          return {
            content: [
              {
                type: "text",
                text: `文件过大（${sizeMb.toFixed(1)} MB），超过 ${MAX_FILE_MB} MB 上限。请压缩或分片后重试。`,
              },
            ],
            details: { isError: true },
          };
        }

        const python = await findPython();
        const installed = await checkMarkItDownInstalled(python);
        if (!installed) {
          return {
            content: [
              {
                type: "text",
                text: "MarkItDown 未安装。请运行：\n\n  pip install 'markitdown[pdf,docx,pptx,xlsx]'\n\n（Python 3.10+ 必需）安装后重试。",
              },
            ],
            details: { isError: true },
          };
        }

        const markdown = await runMarkItDown(python, filePath);
        if (markdown.trim().length === 0) {
          return {
            content: [{ type: "text", text: "转换完成，但未提取到任何文本内容（该文件可能为纯图片/扫描件，请考虑用视觉模型分析）。" }],
            details: { charCount: 0 },
          };
        }

        const total = markdown.length;
        let text = markdown;
        let truncated = false;
        if (total > maxChars) {
          text = markdown.slice(0, maxChars) + `\n\n…[已截断，全文共 ${total} 字符，仅显示前 ${maxChars} 字符。如需更多内容，可增大 max_chars 或分段处理。]`;
          truncated = true;
        }

        return {
          content: [{ type: "text", text }],
          details: { charCount: total, truncated, sizeMb: Number(sizeMb.toFixed(2)) },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `转换出错：${msg}` }],
          details: { isError: true },
        };
      }
    },
  });
}

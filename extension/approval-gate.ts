// ── Execution approval gate (pi extension) ─────────────────────────────
// Enforces the user's discussion-first habit at the pi level (terminal
// AND RPC/WeChat): state-changing tool calls (bash, write, edit, subagent,
// mcp, memory writes, ssh, ...) are blocked unless the user confirms.
//
//   - TUI mode: shows a native confirm dialog.
//   - RPC mode (pi-weixin-hub): emits extension_ui_request → the WeChat
//     bridge forwards it → the user replies 确认/取消 → the tool runs or
//     is blocked. No reply within the timeout = blocked (fail-closed).
//
// Read-only tools (read/grep/find/ls/todo/think/search) are NOT gated.
//
// Commands:
//   /approval on|off|status          toggle the gate
//   /approval allow <tool>           permanently allow a tool
//   /approval deny <tool>            remove it from the allowlist
//
// State: ~/.config/pi-weixin-cli/approval-gate.json

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────

const STATE_PATH = path.join(os.homedir(), ".config", "pi-weixin-cli", "approval-gate.json");

/** Tools that never change state — always allowed without asking. */
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "todo", "task", "think", "plan",
  "memory_search", "session_search",
]);

/** How long to wait for user approval before blocking (fail-closed). */
const CONFIRM_TIMEOUT_MS = 90_000;

// ── State ──────────────────────────────────────────────────────────────

interface GateState {
  enabled: boolean;
  alwaysAllow: string[];
}

function loadState(): GateState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as Partial<GateState>;
    return {
      enabled: raw.enabled !== false,
      alwaysAllow: Array.isArray(raw.alwaysAllow) ? raw.alwaysAllow : [],
    };
  } catch {
    return { enabled: true, alwaysAllow: [] };
  }
}

function saveState(state: GateState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    /* ignore */
  }
}

// ── Action summarization ───────────────────────────────────────────────

function summarizeAction(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (toolName) {
    case "bash":
      return `执行命令：${String(i.command ?? "").slice(0, 120)}`;
    case "write":
    case "edit":
    case "patch":
      return `修改文件：${String(i.path ?? i.filePath ?? "?")}`;
    case "subagent":
      return `调用子代理：${String(i.agent ?? i.name ?? "?")}`;
    case "mcp":
      return `调用 MCP 工具：${String(i.tool ?? "?")}`;
    case "memory":
      return `写入记忆（${String(i.target ?? "?")}）`;
    case "skill_manage":
      return `管理技能：${String(i.action ?? i.name ?? "?")}`;
    case "ssh_exec":
    case "ssh_upload":
    case "ssh_download":
      return `远程操作：${String(i.host ?? "?")}`;
    default:
      return `工具 ${toolName}（参数 ${JSON.stringify(input).slice(0, 120)}）`;
  }
}

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.on("tool_call", async (event: unknown, ctx: unknown) => {
    const state = loadState();
    if (!state.enabled) return;

    const ev = event as {
      toolName?: string;
      toolCallId?: string;
      input?: unknown;
    };
    const toolName = ev.toolName ?? "";
    if (!toolName) return;
    if (READ_ONLY_TOOLS.has(toolName)) return;
    if (state.alwaysAllow.includes(toolName)) return;

    const summary = summarizeAction(toolName, ev.input);
    const ui = (ctx as { ui?: { confirm: (t: string, m: string, o?: object) => Promise<boolean> } }).ui;
    if (!ui?.confirm) return; // no UI available — allow (cannot block safely)

    let ok = false;
    try {
      ok = await ui.confirm(
        "🔒 执行审批",
        `${summary}\n\n回复「确认」执行，或「取消」/不回复阻止。`,
        { timeout: CONFIRM_TIMEOUT_MS },
      );
    } catch {
      ok = false;
    }

    if (!ok) {
      return { block: true, reason: "用户未批准执行（讨论模式）" };
    }
  });

  // ── Commands ─────────────────────────────────────────────────────────
  pi.registerCommand("approval", {
    description: "切换执行审批闸门（on/off/status/allow <tool>/deny <tool>）",
    handler: async (args: string, ctx: { ui?: { notify: (m: string, t?: string) => void } }) => {
      const notify = ctx.ui?.notify ?? (() => {});
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase() ?? "";
      const state = loadState();

      switch (cmd) {
        case "on":
          state.enabled = true;
          saveState(state);
          notify("✅ 执行审批已开启：修改类工具需你确认", "info");
          break;
        case "off":
          state.enabled = false;
          saveState(state);
          notify("执行审批已关闭：工具将自动执行", "info");
          break;
        case "allow": {
          const tool = parts[1];
          if (!tool) {
            notify("用法: /approval allow <tool>", "warning");
            return;
          }
          if (!state.alwaysAllow.includes(tool)) state.alwaysAllow.push(tool);
          saveState(state);
          notify(`🔓 已允许 ${tool} 免确认执行`, "info");
          break;
        }
        case "deny": {
          const tool = parts[1];
          if (!tool) {
            notify("用法: /approval deny <tool>", "warning");
            return;
          }
          state.alwaysAllow = state.alwaysAllow.filter((t) => t !== tool);
          saveState(state);
          notify(`🔒 ${tool} 已重新纳入审批`, "info");
          break;
        }
        case "status": {
          const gated = [
            "bash", "write", "edit", "patch", "subagent", "mcp", "memory",
            "skill_manage", "ssh_exec", "computer_use",
          ];
          notify(
            `审批：${state.enabled ? "开启" : "关闭"}` +
              `\n免确认：${state.alwaysAllow.join(", ") || "(无)"}` +
              `\n需审批：${gated.filter((t) => !state.alwaysAllow.includes(t)).join(", ") || "(无)"}`,
            "info",
          );
          break;
        }
        default:
          notify("用法: /approval on|off|status|allow <tool>|deny <tool>", "warning");
      }
    },
  });
}

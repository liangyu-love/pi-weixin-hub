// ── Configuration ──────────────────────────────────────────────────────
// Persistent configuration for pi-weixin-hub.
// Saves to ~/.config/pi-weixin-cli/settings.json
//
// Extensible options added by the pi-weixin-hub fork:
//   - defaultModel      启动时切换到的默认模型（如 "deepseek/deepseek-v4-flash"）
//   - allowlist         允许使用 bot 的用户 ID 列表；空数组 = 允许所有
//   - groupChat         是否处理群聊消息（true=响应群消息，false=忽略）
//   - maxReplyLength    单条回复最大字符数，超过自动拆分（0=不拆分）
//   - replyPrefix       发给用户的 AI 回复前缀（如 "🤖 "，空=无）
//   - logLevel          日志级别: debug / info / warn / error
//   - persistentSession 是否在重启后恢复上下文（持久会话）
//   - visionAgent       收到图片时是否指示 Pi 使用 vision 子代理分析
//   - visionSubagent    vision 子代理名称（对应 ~/.pi/agent/agents/<name>.md）
//   - attachImages      是否将图片以 base64 直接附加到 prompt（仅对支持视觉的模型）

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface WeixinConfig {
  /** 是否启用消息接收（daemon 启动时读取）。CLI 模式下通过 `toggle` 命令切换。 */
  enabled: boolean;
  /** 默认模型：daemon 启动时通过 RPC set_model 切换（"provider/modelId" 或 modelId）。 */
  defaultModel?: string;
  /** 允许的用户 ID 列表；空数组 = 允许所有用户。 */
  allowlist?: string[];
  /** 是否处理群聊消息。 */
  groupChat?: boolean;
  /** 机器人昵称（群聊 @ 触发用）；空 = 处理所有群消息。 */
  botName?: string;
  /** 单条回复最大字符数；0 = 不拆分。默认 2000。 */
  maxReplyLength?: number;
  /** 发送给用户的 AI 回复前缀（emoji 状态前缀）。默认 "🤖 "。 */
  replyPrefix?: string;
  /** 日志级别。 */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** 持久会话：重启后自动恢复上次的 session 上下文。 */
  persistentSession?: boolean;
  /** 图片分析：自动检测模型视觉能力（视觉模型直接附加，文本模型走 vision 子代理）。 */
  visionAgent?: boolean;
  /** vision 子代理名称。默认 "vision"。 */
  visionSubagent?: string;
  /** 强制将图片以 base64 直接附加到 prompt（覆盖自动检测）。默认 false。 */
  attachImages?: boolean;
}

export const DEFAULT_CONFIG: WeixinConfig = {
  enabled: true,
  defaultModel: undefined,
  allowlist: [],
  groupChat: false,
  botName: "",
  maxReplyLength: 2000,
  replyPrefix: "🤖 ",
  logLevel: "info",
  persistentSession: true,
  visionAgent: true,
  visionSubagent: "vision",
  attachImages: false,
};

function getConfigPath(): string {
  return path.join(os.homedir(), ".config", "pi-weixin-cli", "settings.json");
}

export function loadConfig(): WeixinConfig {
  try {
    const filePath = getConfigPath();
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_CONFIG };
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: WeixinConfig): void {
  const filePath = getConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

/** 恢复默认配置并持久化。 */
export function resetConfig(): void {
  saveConfig({ ...DEFAULT_CONFIG });
}

// ── Type helpers for `config set` ──────────────────────────────────────

/** Set a single config key with type coercion, returning an error message if invalid. */
export function setConfigValue(
  config: WeixinConfig,
  key: string,
  rawValue: string,
): string | null {
  switch (key) {
    case "enabled":
      config.enabled = rawValue === "true" || rawValue === "1" || rawValue === "yes";
      return null;

    case "defaultModel":
      config.defaultModel = rawValue || undefined;
      return null;

    case "allowlist": {
      // Comma-separated user IDs
      const ids = rawValue
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      config.allowlist = ids;
      return null;
    }

    case "groupChat":
    case "persistentSession":
    case "visionAgent":
    case "attachImages": {
      const v = rawValue === "true" || rawValue === "1" || rawValue === "yes";
      (config as unknown as Record<string, unknown>)[key] = v;
      return null;
    }

    case "botName":
      config.botName = rawValue.trim();
      return null;

    case "maxReplyLength": {
      const n = parseInt(rawValue, 10);
      if (isNaN(n) || n < 0) return `maxReplyLength 必须是 >= 0 的数字（0=不拆分）`;
      config.maxReplyLength = n;
      return null;
    }

    case "replyPrefix":
      config.replyPrefix = rawValue;
      return null;

    case "logLevel": {
      const level = rawValue.toLowerCase();
      if (!["debug", "info", "warn", "error"].includes(level)) {
        return `logLevel 必须是 debug / info / warn / error 之一`;
      }
      config.logLevel = level as WeixinConfig["logLevel"];
      return null;
    }

    case "visionSubagent":
      config.visionSubagent = rawValue || undefined;
      return null;

    default:
      return `未知配置项 "${key}"`;
  }
}

/** Describe a config value for `config show`. */
export function describeConfig(config: WeixinConfig): string {
  const lines: string[] = [];
  const label = (k: string, v: unknown) => lines.push(`  ${k}:  ${v}`);

  label("enabled", config.enabled ? "启用" : "禁用");
  label("defaultModel", config.defaultModel ?? "(使用 Pi 默认模型)");
  label(
    "allowlist",
    config.allowlist && config.allowlist.length > 0
      ? config.allowlist.join(", ")
      : "(允许所有用户)",
  );
  label("groupChat", config.groupChat ? "启用" : "禁用（忽略群消息）");
  label("botName", config.botName ? `@${config.botName} 触发` : "(处理所有群消息)");
  label("maxReplyLength", config.maxReplyLength === 0 ? "(不拆分)" : `${config.maxReplyLength} 字符`);
  label("replyPrefix", JSON.stringify(config.replyPrefix ?? ""));
  label("logLevel", config.logLevel ?? "info");
  label("persistentSession", config.persistentSession ? "启用" : "禁用");
  label("visionAgent", config.visionAgent ? "启用" : "禁用");
  label("visionSubagent", config.visionSubagent ?? "vision");
  label("attachImages", config.attachImages ? "启用" : "禁用（走 vision 子代理）");
  return lines.join("\n");
}

// ── CLI Command Handler ─────────────────────────────────────────────────
// Implements all CLI subcommands for pi-weixin-hub standalone mode.
// Invoked when the binary is called with arguments (other than "daemon").

import process from "node:process";

import { startQRLogin } from "./auth.js";
import { WeixinApi } from "./api.js";
import {
  loadAccounts,
  unregisterAccount,
} from "./storage.js";
import {
  loadConfig,
  saveConfig,
  resetConfig,
  setConfigValue,
  describeConfig,
} from "./config.js";

// ── Help ──────────────────────────────────────────────────────────────

const HELP = `pi-weixin-hub — 微信消息桥接工具（pi-weixin-cli 的分支增强版）

用法:
  pi-weixin-hub [命令]

命令:
  login              使用手机微信扫描二维码登录账号
  logout [id]        登出账号。不指定 id 时列出所有账号；使用 --all 删除全部
  status             显示所有已登录账号及其状态
  toggle             切换消息接收功能（启用/禁用）
  config show        显示当前配置
  config set <k> <v> 修改配置项（如 allowlist、groupChat、maxReplyLength）
  config reset       恢复默认配置
  --help, -h         显示此帮助信息

不传任何参数则启动 daemon 模式（后台消息轮询）。

可用配置项:
  enabled            消息接收开关 (true/false)
  defaultModel       默认模型 ("provider/modelId" 或模型名，空=使用 Pi 默认)
  allowlist          允许的用户 ID，逗号分隔（空=允许所有）
  groupChat          群聊模式 (true/false)
  maxReplyLength     单条回复最大字符数 (0=不拆分)
  replyPrefix        AI 回复前缀 (如 "🤖 ")
  logLevel           日志级别 (debug/info/warn/error)
  persistentSession  重启后恢复上下文 (true/false)
  visionAgent        图片分析（自动检测模型能力，默认开启） (true/false)
  visionSubagent     vision 子代理名称 (默认 vision)
  attachImages       强制 base64 直接附加图片（覆盖自动检测） (true/false)
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

// ── Utility ────────────────────────────────────────────────────────────

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

// ── Handlers ───────────────────────────────────────────────────────────

/** login — 显示二维码并在终端等待扫码确认。 */
async function handleLogin(): Promise<number> {
  const api = new WeixinApi();
  let qrDisplayed = false;

  const result = await startQRLogin(api, {
    onDisplayQR(qrStr) {
      qrDisplayed = true;
      process.stdout.write(`\n${qrStr}\n\n`);
    },
    onStatus(msg) {
      process.stdout.write(`  ${msg}\n`);
    },
    onError(msg) {
      process.stderr.write(`  错误: ${msg}\n`);
    },
  });

  if (result.success) {
    process.stdout.write(`\n✓ 登录成功！账号 ID: ${result.account.id}\n`);
    process.stdout.write(`  User ID: ${result.account.userId}\n`);
    process.stdout.write(`  Base URL: ${result.account.baseUrl}\n`);
    return 0;
  }

  if (!qrDisplayed) {
    process.stderr.write(`✗ ${result.error}\n`);
  } else {
    process.stdout.write(`✗ ${result.error}\n`);
  }
  return 1;
}

/** logout — 登出并删除账号。 */
function handleLogout(args: string[]): number {
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    process.stdout.write("没有已登录的账号。\n");
    return 0;
  }

  // --all: delete all accounts
  if (args.includes("--all")) {
    for (const a of accounts) {
      unregisterAccount(a.id);
      process.stdout.write(`  已删除: ${a.id}\n`);
    }
    process.stdout.write("已删除所有账号。\n");
    return 0;
  }

  const id = args[0];

  if (id) {
    const found = accounts.find((a) => a.id === id);
    if (!found) {
      process.stderr.write(`错误: 未找到账号 "${id}"。\n`);
      process.stdout.write("\n已保存的账号:\n");
      for (const a of accounts) {
        process.stdout.write(`  ${a.id}\n`);
      }
      return 1;
    }
    unregisterAccount(id);
    process.stdout.write(`已登出账号: ${id}\n`);
    return 0;
  }

  // No id given — list accounts
  process.stdout.write("已保存的账号:\n");
  for (const a of accounts) {
    process.stdout.write(`  ${a.id}\n`);
  }
  process.stdout.write("\n用法: pi-weixin-hub logout <账号ID>\n");
  process.stdout.write("  或: pi-weixin-hub logout --all    (删除全部)\n");
  return 0;
}

/** status — 显示所有已保存的账号。 */
function handleStatus(): number {
  const accounts = loadAccounts();

  if (accounts.length === 0) {
    process.stdout.write("没有已登录的账号。\n");
    return 0;
  }

  process.stdout.write(`已保存 ${accounts.length} 个账号:\n\n`);
  for (const a of accounts) {
    process.stdout.write(`  ID:        ${a.id}\n`);
    process.stdout.write(`  User ID:   ${a.userId}\n`);
    process.stdout.write(`  Base URL:  ${a.baseUrl}\n`);
    process.stdout.write(`  创建时间:  ${formatTime(a.createdAt)}\n`);
    process.stdout.write("\n");
  }
  return 0;
}

/** toggle — 切换全局消息接收开关。 */
function handleToggle(): number {
  const config = loadConfig();
  config.enabled = !config.enabled;
  saveConfig(config);

  const status = config.enabled ? "已启用" : "已禁用";
  process.stdout.write(`消息接收: ${status}\n`);
  process.stdout.write(
    config.enabled
      ? "daemon 启动时将开始接收微信消息。\n"
      : "daemon 启动时将跳过消息接收。\n",
  );
  return 0;
}

// ── Config Subcommands ─────────────────────────────────────────────────

function handleConfig(args: string[]): number {
  const sub = args[0];

  switch (sub) {
    case "show":
      return handleConfigShow();
    case "set":
      return handleConfigSet(args.slice(1));
    case "reset":
      return handleConfigReset();
    default: {
      process.stderr.write(`错误: 未知的 config 子命令 "${sub ?? "(无)"}"。\n\n`);
      process.stdout.write("可用子命令:\n");
      process.stdout.write("  show              显示当前配置\n");
      process.stdout.write("  set <key> <value> 修改配置项\n");
      process.stdout.write("  reset             恢复默认配置\n");
      process.stdout.write('运行 "pi-weixin-hub --help" 查看全部配置项。\n');
      return 1;
    }
  }
}

function handleConfigSet(args: string[]): number {
  const key = args[0];
  const value = args[1];

  if (!key || value === undefined) {
    process.stderr.write("用法: pi-weixin-hub config set <key> <value>\n");
    return 1;
  }

  const config = loadConfig();
  const err = setConfigValue(config, key, value);
  if (err) {
    process.stderr.write(`错误: ${err}\n`);
    return 1;
  }

  saveConfig(config);
  process.stdout.write(`已设置 ${key} = ${value}\n`);
  return 0;
}

function handleConfigShow(): number {
  const config = loadConfig();
  process.stdout.write("当前配置:\n\n");
  process.stdout.write(`${describeConfig(config)}\n`);
  return 0;
}

function handleConfigReset(): number {
  resetConfig();
  process.stdout.write("配置已恢复为默认值。\n");
  return 0;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * 解析并执行 CLI 命令。
 * @returns 进程退出码（0 = 成功，非 0 = 错误）。
 */
export async function runCLI(args: string[]): Promise<number> {
  // Route to command or help
  const cmd = args[0];

  switch (cmd) {
    case "--help":
    case "-h":
      printHelp();
      return 0;

    case "login":
      return await handleLogin();

    case "logout":
      return handleLogout(args.slice(1));

    case "status":
      return handleStatus();

    case "toggle":
      return handleToggle();

    case "config":
      return handleConfig(args.slice(1));

    default: {
      process.stderr.write(
        `未知命令: ${cmd ?? "(无)"}\n`,
      );
      process.stderr.write('运行 "pi-weixin-hub --help" 查看可用命令。\n');
      return 1;
    }
  }
}

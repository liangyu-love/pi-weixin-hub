// ── doctor — self-test diagnostics ─────────────────────────────────────
// `pi-weixin-hub doctor` verifies the installation and runtime:
//   1. Pi executable resolvable
//   2. Config file valid JSON
//   3. Accounts file valid + at least one account
//   4. WeChat API reachable
//   5. Daemon heartbeat (if running)
//   6. Config dir writable
//
// Prints a ✅/❌ report; exits non-zero when any check fails.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { DEFAULT_BASE_URL } from "./api.js";
import { resolvePiTarget, findPiOnPath } from "./rpc-client.js";
import { loadAccounts } from "./storage.js";

// ── Types ──────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

// ── Checks ─────────────────────────────────────────────────────────────

function stateDir(): string {
  return path.join(os.homedir(), ".config", "pi-weixin-cli");
}

function checkPiExecutable(): CheckResult {
  try {
    const target = resolvePiTarget();
    if (target.command === "pi") {
      const found = findPiOnPath();
      return {
        name: "Pi 可执行文件",
        ok: !!found,
        detail: found ? `PATH: ${found}` : "未在 PATH 中找到 pi（可设置 PI_PATH 环境变量）",
      };
    }
    const ok = fs.existsSync(target.command);
    return {
      name: "Pi 可执行文件",
      ok,
      detail: ok
        ? `${target.command}${target.args.length > 0 ? ` ${target.args[0]}` : ""}`
        : `路径不存在: ${target.command}`,
    };
  } catch {
    return { name: "Pi 可执行文件", ok: false, detail: "解析失败" };
  }
}

function checkConfig(): CheckResult {
  try {
    const filePath = path.join(stateDir(), "settings.json");
    if (!fs.existsSync(filePath)) {
      return { name: "配置文件", ok: true, detail: `不存在，将使用默认配置 (${filePath})` };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const ok = parsed && typeof parsed === "object";
    return { name: "配置文件", ok: !!ok, detail: ok ? "JSON 有效" : "JSON 结构无效" };
  } catch (err) {
    return {
      name: "配置文件",
      ok: false,
      detail: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkAccounts(): CheckResult {
  try {
    const accounts = loadAccounts();
    return {
      name: "微信账号",
      ok: accounts.length > 0,
      detail:
        accounts.length > 0
          ? `${accounts.length} 个账号: ${accounts.map((a) => a.id).join(", ")}`
          : "没有已登录账号（运行 pi-weixin-hub login）",
    };
  } catch (err) {
    return {
      name: "微信账号",
      ok: false,
      detail: `读取失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function checkApiReachability(): Promise<CheckResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6_000);
    const resp = await fetch(DEFAULT_BASE_URL, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      name: "微信 API 连通性",
      ok: true,
      detail: `${DEFAULT_BASE_URL} → HTTP ${resp.status}`,
    };
  } catch (err) {
    return {
      name: "微信 API 连通性",
      ok: false,
      detail: `无法连接: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkDaemon(): CheckResult {
  try {
    const filePath = path.join(stateDir(), "daemon-status.json");
    if (!fs.existsSync(filePath)) {
      return { name: "Daemon", ok: false, detail: "未运行（未检测到状态文件）" };
    }
    const st = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const pid = st.pid as number | undefined;
    let alive = false;
    try {
      if (pid) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {
      alive = false;
    }
    return {
      name: "Daemon",
      ok: alive,
      detail: alive
        ? `运行中 (PID ${pid}${st.piRunning ? ", Pi 进程正常" : ", Pi 进程异常"})`
        : `未运行 (PID ${pid ?? "?"} 已退出)`,
    };
  } catch (err) {
    return {
      name: "Daemon",
      ok: false,
      detail: `状态读取失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkWritable(): CheckResult {
  const dir = stateDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".doctor-write-probe");
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.unlinkSync(probe);
    return { name: "配置目录可写", ok: true, detail: dir };
  } catch (err) {
    return {
      name: "配置目录可写",
      ok: false,
      detail: `写入失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Entry ──────────────────────────────────────────────────────────────

/** Run all doctor checks and print the report. Returns process exit code. */
export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [
    checkPiExecutable(),
    checkConfig(),
    checkAccounts(),
    await checkApiReachability(),
    checkDaemon(),
    checkWritable(),
  ];

  console.log("pi-weixin-hub doctor\n");
  for (const r of results) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.name}: ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log("\n全部检查通过 ✓");
    return 0;
  }
  console.log(`\n${failed.length} 项检查未通过，请根据提示修复。`);
  return 1;
}

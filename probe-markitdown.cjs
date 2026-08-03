// Probe: verify the global markitdown extension tool (convert_document)
// is registered and callable in a pi --mode rpc session (the same mode
// pi-weixin-hub uses). Run: node probe-markitdown.js
const { spawn } = require("node:child_process");

const PI_DIST =
  "C:/Users/liang/scoop/persist/nodejs-lts/bin/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const CWD = "D:/workspack/pi-weixin-hub";

const child = spawn(process.execPath, [PI_DIST, "--mode", "rpc"], {
  cwd: CWD,
  windowsHide: true,
});

let buf = "";
let settledCount = 0;
let toolCalls = [];

function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "response" && msg.command === "prompt" && msg.success) {
    console.log("[OK] prompt accepted, id=" + msg.id);
  }
  if (msg.type === "tool_execution_start") {
    toolCalls.push(msg.toolName);
    console.log("[TOOL] " + msg.toolName + " " + JSON.stringify(msg.args ?? {}).slice(0, 300));
  }
  if (msg.type === "tool_execution_end") {
    const text = Array.isArray(msg.result?.content)
      ? msg.result.content.map((c) => c.text ?? "").join("").slice(0, 600)
      : JSON.stringify(msg.result).slice(0, 600);
    console.log("[TOOL-END] " + msg.toolName + " isError=" + (msg.isError ?? false));
    console.log("  -> " + text);
  }
  if (msg.type === "message_end" && msg.message?.role === "assistant") {
    const text = (msg.message.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("")
      .slice(0, 800);
    console.log("[ASSISTANT] " + text);
  }
  if (msg.type === "agent_settled") {
    settledCount++;
    console.log("[SETTLED] #" + settledCount);
    if (settledCount >= 1) {
      console.log("=== SUMMARY ===");
      console.log("tool calls:", toolCalls.length ? toolCalls.join(", ") : "(none)");
      child.stdin.end();
      setTimeout(() => process.exit(0), 500);
    }
  }
  if (msg.type === "error") {
    console.log("[ERROR] " + JSON.stringify(msg).slice(0, 500));
  }
}

child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) onLine(line);
  }
});
child.stderr.on("data", (d) => {
  const s = String(d);
  if (/error|warn|exception/i.test(s)) console.log("[STDERR] " + s.slice(0, 400));
});
child.on("exit", (code) => {
  console.log("[EXIT] code=" + code);
  process.exit(code ?? 0);
});

// Give pi a moment to boot, then ask it to use the tool.
setTimeout(() => {
  const prompt =
    "请调用 convert_document 工具，把文件 C:/Users/liang/AppData/Local/Temp/markitdown-test.md 转换为 Markdown，然后用一两句话告诉我文件内容是什么。";
  child.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
  console.log("[SENT] prompt");
}, 4000);

setTimeout(() => {
  console.log("[TIMEOUT] 90s without settle — aborting");
  child.kill();
  process.exit(2);
}, 90_000);

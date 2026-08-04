// ── Self-check ─────────────────────────────────────────────────────────
// Assertion-based checks for the non-obvious logic in this repo. No test
// framework: run it with `npm run check` (or `node dist/selfcheck.js`).
//
// Scope is deliberately narrow — it covers the pieces where a silent
// regression would corrupt state or leak a path, not every function.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeJsonAtomic } from "./storage.js";
import { sanitizeFileName } from "./media-handler.js";
import { splitReply, previewText, DEFAULT_MAX_REPLY_LENGTH } from "./format-reply.js";
import { classifyError } from "./error-classifier.js";

let passed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── writeJsonAtomic ────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwh-check-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check("writeJsonAtomic writes readable JSON and leaves no .tmp behind", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "nested", "accounts.json");
    writeJsonAtomic(file, [{ id: "a", botToken: "t" }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), [{ id: "a", botToken: "t" }]);
    assert.equal(fs.existsSync(`${file}.tmp`), false, ".tmp should be renamed away");
  });
});

check("writeJsonAtomic keeps the old file when serialization throws", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "settings.json");
    writeJsonAtomic(file, { good: 1 });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => writeJsonAtomic(file, circular));

    // The point of tmp+rename: a failed write must not truncate the target.
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf-8")), { good: 1 });
  });
});

check("writeJsonAtomic creates credential files owner-only", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "context-tokens.json");
    writeJsonAtomic(file, { u: "secret" });
    if (process.platform !== "win32") {
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    }
  });
});

// ── sanitizeFileName ───────────────────────────────────────────────────

check("sanitizeFileName strips directory traversal", () => {
  for (const evil of [
    "../../../etc/passwd",
    "..\\..\\..\\Windows\\System32\\cmd.exe",
    "/etc/shadow",
    "C:\\Windows\\win.ini",
    "..",
    "....//....//x.txt",
  ]) {
    const safe = sanitizeFileName(evil);
    assert.ok(!safe.includes("/"), `${evil} → ${safe} still has /`);
    assert.ok(!safe.includes("\\"), `${evil} → ${safe} still has \\`);
    assert.ok(!safe.startsWith("."), `${evil} → ${safe} still starts with .`);
    // The real guarantee: joining it cannot escape the storage dir.
    const joined = path.resolve("/storage", safe);
    assert.ok(joined.startsWith(path.resolve("/storage")), `${evil} escaped to ${joined}`);
  }
});

check("sanitizeFileName keeps ordinary names intact", () => {
  assert.equal(sanitizeFileName("报告 2026.pdf"), "报告 2026.pdf");
  assert.equal(sanitizeFileName("notes-v2.md"), "notes-v2.md");
  assert.equal(sanitizeFileName(""), "unnamed");
  assert.equal(sanitizeFileName("..."), "unnamed");
});

// ── previewText ────────────────────────────────────────────────────────

check("previewText flattens and bounds queue labels", () => {
  assert.equal(previewText("帮我查一下天气"), "帮我查一下天气");
  // A multi-line paste must collapse to one line, or /queue output explodes.
  assert.equal(previewText("第一行\n第二行\t第三行"), "第一行 第二行 第三行");
  const long = previewText("x".repeat(200), 40);
  assert.ok(long.length <= 40, `got ${long.length}`);
  assert.ok(long.endsWith("…"), "long text should be ellipsized");
  assert.equal(previewText("   \n  "), "(空消息)");
});

// ── splitReply ─────────────────────────────────────────────────────────

check("splitReply respects the max length at the boundary", () => {
  const max = DEFAULT_MAX_REPLY_LENGTH;
  assert.equal(splitReply("x".repeat(max), max).length, 1, "exactly max = one chunk");
  const over = splitReply("x".repeat(max + 1), max);
  assert.ok(over.length > 1, "max+1 must split");
  for (const chunk of over) {
    assert.ok(chunk.length <= max, `chunk of ${chunk.length} exceeds ${max}`);
  }
});

check("splitReply loses no characters", () => {
  const text = Array.from({ length: 300 }, (_, i) => `第 ${i} 行内容`).join("\n");
  const joined = splitReply(text, 500).join("");
  // "（续 n/m）" labels are added by the splitter — strip them, then the
  // payload must be byte-identical to the input.
  const strip = (s: string) => s.replace(/（续\s*\d+\/\d+）/g, "").replace(/\s/g, "");
  assert.equal(strip(joined), strip(text));
});

// ── classifyError ──────────────────────────────────────────────────────

check("classifyError maps the categories we act on", () => {
  const cases: Array<[string, string]> = [
    ["429 Too Many Requests", "rate-limit"],
    ["HTTP 503 Service Unavailable", "server"],
    ["request timed out after 30s", "timeout"],
    ["401 Unauthorized: invalid api key", "permission"],
    ["fetch failed: ECONNREFUSED", "network"],
    ["model not found: foo-9", "model"],
    ["something entirely new exploded", "unknown"],
  ];
  for (const [msg, category] of cases) {
    assert.equal(classifyError(new Error(msg)).category, category, `"${msg}"`);
  }
  // Every branch must yield advice a user can act on.
  for (const [msg] of cases) {
    const c = classifyError(new Error(msg));
    assert.ok(c.suggestion.length > 0, `no suggestion for ${msg}`);
    assert.ok(c.emoji.length > 0, `no emoji for ${msg}`);
  }
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures above)" : ""}`);

// ── Reply Formatting ───────────────────────────────────────────────────
// Converts Pi's Markdown replies into WeChat-friendly plain text and
// splits long replies into multiple messages.
//
// WeChat (iLink channel) renders plain text only — no Markdown. This module
// therefore:
//   1. Converts fenced code blocks into indented blocks with a header.
//   2. Converts inline code `x` into 「x」.
//   3. Converts headings into 📌-prefixed lines.
//   4. Converts `-` / `*` bullet lists into `•` bullets.
//   5. Strips **bold** / __bold__ / *italic* markers.
//   6. Keeps numbered lists and URLs intact.
//
// Long replies are split at `maxReplyLength` on line boundaries, with a
// "（续 n/m）" marker appended to each continuation.

// ── Constants ──────────────────────────────────────────────────────────

/** Default maximum length of a single WeChat reply. */
export const DEFAULT_MAX_REPLY_LENGTH = 2000;

// ── Markdown → WeChat ─────────────────────────────────────────────────

/**
 * Convert a Markdown string into WeChat-friendly plain text.
 *
 * Handles fenced code blocks first (so their inner content is not mangled
 * by the inline transforms), then applies the inline rules line by line.
 */
export function formatForWeixin(markdown: string): string {
  if (!markdown) return markdown;

  // 1. Extract and transform fenced code blocks (```lang ... ```).
  const codeBlocks: string[] = [];
  let text = markdown.replace(
    /```[^\n]*\n([\s\S]*?)```/g,
    (_match, code: string) => {
      const block = transformCodeBlock(code);
      codeBlocks.push(block);
      return `\u0000CODE${codeBlocks.length - 1}\u0000`;
    },
  );

  // Handle unterminated fence (single ``` at start without closing).
  text = text.replace(/```[^\n]*\n?([\s\S]*)$/, (_m, code: string) => {
    const block = transformCodeBlock(code);
    codeBlocks.push(block);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  // 2. Transform each remaining line.
  const lines = text.split("\n").map((line) => transformLine(line));

  // 3. Restore code blocks.
  const result = lines
    .join("\n")
    .replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => {
      return codeBlocks[Number(idx)] ?? "";
    });

  // 4. Clean up: collapse 3+ blank lines to 1, strip trailing whitespace.
  return result
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Transform the inner content of a fenced code block. */
function transformCodeBlock(code: string): string {
  const trimmed = code.replace(/\n$/, "");
  const lines = trimmed.split("\n").map((l) => `    ${l}`);
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

/** Transform a single non-code line. */
function transformLine(line: string): string {
  let out = line;

  // Headings: #, ##, ### ... → 📌 prefix
  out = out.replace(/^#{1,6}\s+/, "📌 ");

  // Bullet lists: "- x", "* x", "+ x" → "• x"
  out = out.replace(/^\s*[-*+]\s+/, "• ");

  // Blockquote: "> x" → "│ x"
  out = out.replace(/^>\s?/, "│ ");

  // Inline code `x` → 「x」(avoid mangling code-block markers already handled)
  out = out.replace(/`([^`\n]+)`/g, "「$1」");

  // Bold **x** / __x__ → x
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");

  // Italic *x* → x (single asterisk; skips multiplication-ish patterns
  // by requiring non-space boundaries)
  out = out.replace(/(^|[\s(])[*]([^*\n]+)[*](?=$|[\s)])/g, "$1$2");

  // Markdown links [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)");

  // Remove trailing markdown emphasis leftovers
  out = out.replace(/\*+/g, "*");

  return out;
}

// ── Long-reply splitting ───────────────────────────────────────────────

/**
 * Split a formatted reply into chunks of at most `maxLength` characters.
 * Prefers breaking on newline boundaries; falls back to hard wrap.
 *
 * Returns a single-element array when the text fits, or the text is empty.
 * Continuations are labeled "（续 n/m）" so users know more is coming.
 */
export function splitReply(text: string, maxLength: number): string[] {
  if (maxLength <= 0) return [text];
  if (text.length <= maxLength) return [text];

  // The "（续 n/m）\n" label is prepended after splitting, so the payload
  // budget has to leave room for it — otherwise a maxLength-sized chunk plus
  // its label overflows the limit we were asked to respect.
  const LABEL_BUDGET = 16;
  const budget = maxLength > LABEL_BUDGET * 2 ? maxLength - LABEL_BUDGET : maxLength;

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > budget) {
    // Find the last newline within the limit.
    const slice = remaining.slice(0, budget + 1);
    const newlineIdx = slice.lastIndexOf("\n");

    let splitAt = newlineIdx;
    if (splitAt <= 0) {
      // No newline in range — prefer the last space before the limit.
      const spaceIdx = slice.lastIndexOf(" ");
      splitAt = spaceIdx > budget * 0.5 ? spaceIdx : -1;
    }

    if (splitAt <= 0) {
      // Hard wrap: prefer the next space within a bounded lookahead so
      // long URLs / words aren't split mid-token. Bounded to what is left in
      // the budget so a lookahead can never push a chunk over the limit.
      const lookaheadLen = Math.min(
        Math.max(0, maxLength - budget),
        remaining.length - budget,
      );
      const nextSpace = remaining
        .slice(budget, budget + lookaheadLen)
        .indexOf(" ");
      splitAt = nextSpace !== -1 ? budget + nextSpace : budget;

      // Never split a UTF-16 surrogate pair (emoji / astral chars).
      if (splitAt > 0 && splitAt < remaining.length) {
        const code = remaining.charCodeAt(splitAt);
        if (code >= 0xdc00 && code <= 0xdfff) splitAt -= 1;
      }
    }
    if (splitAt <= 0) splitAt = budget;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }

  if (remaining.length > 0) chunks.push(remaining);

  // Label continuations.
  if (chunks.length > 1) {
    const total = chunks.length;
    return chunks.map((c, i) =>
      i === 0 ? c : `（续 ${i + 1}/${total}）\n${c}`,
    );
  }
  return chunks;
}

// ── Previews ───────────────────────────────────────────────────────────

/**
 * Condense a message into a one-line label for queue listings.
 *
 * Whitespace collapses to single spaces (a multi-line paste must not blow up
 * the /queue reply) and the result is ellipsized, so users can still recognise
 * which of their own messages an entry refers to.
 */
export function previewText(text: string, maxLen = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(空消息)";
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen - 1)}…`;
}

// ── Convenience ────────────────────────────────────────────────────────

/** Format a raw Pi reply and split it into WeChat messages. */
export function formatAndSplit(
  rawReply: string,
  maxLength: number = DEFAULT_MAX_REPLY_LENGTH,
): string[] {
  const formatted = formatForWeixin(rawReply);
  return splitReply(formatted, maxLength);
}

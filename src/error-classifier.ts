// ── Classified Error Notifications ─────────────────────────────────────
// Maps raw error text (from Pi RPC responses, API failures, or the LLM
// provider) into a human-friendly Chinese prompt with a suggestion.
//
// Categories:
//   1. rate-limit  — 429, quota, overloaded
//   2. timeout     — request timed out, ETIMEDOUT, aborted
//   3. permission  — 401/403, api key, unauthorized, forbidden
//   4. model       — model not found, unsupported model, image/vision input rejected
//   5. server      — 5xx, internal error, temporarily unavailable
//   6. network     — ECONNREFUSED, ENOTFOUND, fetch failed, connection
//   7. unknown     — generic fallback

// ── Types ──────────────────────────────────────────────────────────────

export interface ClassifiedError {
  /** Category id. */
  category: "rate-limit" | "timeout" | "permission" | "model" | "server" | "network" | "unknown";
  /** Short emoji status prefix. */
  emoji: string;
  /** Human-readable Chinese prompt. */
  message: string;
  /** Actionable suggestion. */
  suggestion: string;
}

// ── Classification ─────────────────────────────────────────────────────

/** Classify an error object or message string. */
export function classifyError(err: unknown): ClassifiedError {
  const text = normalizeErrorText(err);

  if (matches(text, ["429", "rate.?limit", "overload", "quota", "限流", "频率", "too many requests", "rate_limit"])) {
    return {
      category: "rate-limit",
      emoji: "⏳",
      message: "请求过于频繁或已超出配额限制（429/限流）",
      suggestion: "请稍等片刻再试，或发送 /auto-retry on 开启自动重试",
    };
  }

  if (matches(text, ["timeout", "timed out", "etimedout", "aborted", "超时", "timeout_error", "deadline"])) {
    return {
      category: "timeout",
      emoji: "⌛",
      message: "请求超时，模型未能及时响应",
      suggestion: "请重试；若频繁超时，可发送 /thinking low 降低思考级别，或 /compact 压缩上下文",
    };
  }

  if (matches(text, ["401", "403", "permission", "forbidden", "unauthorized", "api.?key", "invalid.?key", "无权限", "权限不足", "认证失败", "not authorized"])) {
    return {
      category: "permission",
      emoji: "🔒",
      message: "权限不足或 API Key 无效（401/403）",
      suggestion: "请检查模型提供商的 API Key 配置与余额",
    };
  }

  if (matches(text, ["model not found", "unsupported model", "invalid model", "does not support", "not support image", "no vision", "vision", "image input", "model.?not.?found", "未知模型", "不支持的模型", "not found.*model", "400"])) {
    return {
      category: "model",
      emoji: "🧠",
      message: "当前模型不支持该请求（可能是文本模型收到图片，或模型不可用）",
      suggestion: "请发送 /model 切换模型（图片分析建议使用支持视觉的模型，如 gpt-5.6-luna）",
    };
  }

  if (matches(text, ["50[0-9]", "5xx", "internal server", "internal_error", "temporarily", "unavailable", "服务端", "服务器错误", "overloaded_error", "529", "520", "503", "502", "500"])) {
    return {
      category: "server",
      emoji: "🔧",
      message: "模型服务端暂时不可用（5xx）",
      suggestion: "请稍后再试；可发送 /abort-retry 停止自动重试，或 /cycle-model 换模型",
    };
  }

  if (matches(text, ["econnrefused", "enotfound", "eai_again", "fetch failed", "network", "connection", "socket", "网络", "连接失败", "无法连接", "getaddrinfo"])) {
    return {
      category: "network",
      emoji: "🌐",
      message: "网络连接失败，无法访问模型或微信服务",
      suggestion: "请检查网络连接后重试",
    };
  }

  return {
    category: "unknown",
    emoji: "❌",
    message: "处理请求时发生错误",
    suggestion: "请稍后重试；若持续失败，查看 daemon 日志定位问题",
  };
}

/** Build a full WeChat reply from a classified error. */
export function formatClassifiedError(err: unknown): string {
  const c = classifyError(err);
  return `${c.emoji} ${c.message}\n💡 ${c.suggestion}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeErrorText(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name} ${err.message}`.toLowerCase();
  }
  if (typeof err === "string") return err.toLowerCase();
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err).toLowerCase();
    } catch {
      return String(err).toLowerCase();
    }
  }
  return String(err).toLowerCase();
}

function matches(text: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(p, "i").test(text));
}

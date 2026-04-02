/**
 * 将 Cursor Agent --output-format stream-json 的事件流整理为易读的「对话式」文本。
 * 与 agentDebugLog 的主 .log 并行写入 .chat.txt。
 */

const MAX_TOOL_BODY_CHARS = 12000;
const MAX_USER_PREVIEW_CHARS = 600;

function truncate(s, max) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n\n… (已截断，共 ${t.length} 字符)`;
}

function extractMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const parts = message.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "text") return String(b.text ?? "");
      return `[${b.type}]`;
    })
    .join("");
}

function firstToolEntry(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const keys = Object.keys(toolCall).filter((k) => k.endsWith("ToolCall"));
  if (!keys.length) return null;
  const k = keys[0];
  return { kind: k.replace(/ToolCall$/, ""), payload: toolCall[k] };
}

function summarizeToolArgs(entry) {
  if (!entry || !entry.payload || typeof entry.payload !== "object") return "";
  const args = entry.payload.args;
  if (!args || typeof args !== "object") return "";
  const { kind } = entry;
  try {
    if (kind === "read" && args.path) return `path: ${args.path}${args.limit != null ? ` (limit ${args.limit})` : ""}`;
    if (kind === "write" && args.path) return `path: ${args.path}`;
    if (kind === "edit" && args.path) return `path: ${args.path}`;
    if (kind === "glob" && (args.globPattern || args.pattern))
      return `dir: ${args.targetDirectory || "."}  pattern: ${args.globPattern || args.pattern}`;
    if (kind === "shell" && args.command) return truncate(String(args.command), 2000);
    if (kind === "grep" && args.pattern) return `pattern: ${truncate(String(args.pattern), 200)}`;
  } catch {
    /* ignore */
  }
  const j = JSON.stringify(args);
  return truncate(j, 1500);
}

function summarizeToolResult(entry) {
  if (!entry || !entry.payload || typeof entry.payload !== "object") return "";
  const args = entry.payload.args;
  if (!args || typeof args !== "object") return "";
  const res = args.result;
  if (res == null) return "(无 result 字段)";
  if (typeof res === "string") return truncate(res, MAX_TOOL_BODY_CHARS);
  try {
    return truncate(JSON.stringify(res, null, 2), MAX_TOOL_BODY_CHARS);
  } catch {
    return truncate(String(res), MAX_TOOL_BODY_CHARS);
  }
}

function divider(title) {
  return `\n${"─".repeat(14)} ${title} ${"─".repeat(14)}\n`;
}

/**
 * @param {(chunk: string) => void} append 写入 .chat.txt（可无操作）
 * @param {{
 *   userText?: string;
 *   agentLogBasename?: string;
 *   onBlock?: (piece: string) => void;
 * }} meta onBlock：每完成一个对话块（与 .chat.txt 中一段相同）时回调，用于飞书流式推送
 */
function createStreamJsonChatWriter(append, meta = {}) {
  const onBlock = typeof meta.onBlock === "function" ? meta.onBlock : null;
  let thinkingBuf = "";
  let assistantBuf = "";
  let currentModelCallId = null;
  let systemWritten = false;
  let userWritten = false;

  function writeBlock(title, body) {
    const b = String(body ?? "").trimEnd();
    if (!b) return;
    const piece = `${divider(title)}${b}\n`;
    append(piece);
    onBlock?.(piece);
  }

  function flushThinking() {
    const t = thinkingBuf.trimEnd();
    thinkingBuf = "";
    if (!t) return;
    writeBlock("思考（模型内部）", t);
  }

  function flushAssistant() {
    const t = assistantBuf.trimEnd();
    assistantBuf = "";
    currentModelCallId = null;
    if (!t || !t.replace(/\s+/g, "")) return;
    writeBlock("助手", t);
  }

  /**
   * @param {Record<string, unknown>} obj
   */
  function pushJson(obj) {
    if (!obj || typeof obj !== "object") return;
    const type = String(obj.type ?? "");

    if (type === "system" && obj.subtype === "init") {
      flushThinking();
      flushAssistant();
      if (systemWritten) return;
      systemWritten = true;
      const model = obj.model != null ? String(obj.model) : "";
      const cwd = obj.cwd != null ? String(obj.cwd) : "";
      const sid = obj.session_id != null ? String(obj.session_id) : "";
      writeBlock(
        "系统",
        [`会话初始化`, model && `模型: ${model}`, cwd && `工作目录: ${cwd}`, sid && `session_id: ${sid}`]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    if (type === "user") {
      flushThinking();
      flushAssistant();
      if (userWritten) return;
      userWritten = true;
      const raw = extractMessageText(obj.message);
      const short = (meta.userText && String(meta.userText).trim()) || "";
      let body;
      if (short) {
        body = short;
        if (raw.length > short.length + 80) {
          body += `\n\n（桥接下发的完整 prompt 见同目录 ${meta.agentLogBasename || "agent-*.log"} 中 USER_TEXT / PROMPT 段）`;
        }
      } else {
        body = truncate(raw, MAX_USER_PREVIEW_CHARS);
      }
      writeBlock("用户", body);
      return;
    }

    if (type === "thinking" && obj.subtype === "delta" && typeof obj.text === "string") {
      thinkingBuf += obj.text;
      return;
    }

    if (type === "assistant") {
      flushThinking();
      const text = extractMessageText(obj.message);
      const mid = obj.model_call_id != null ? String(obj.model_call_id) : null;
      if (mid) {
        if (mid !== currentModelCallId) {
          currentModelCallId = mid;
          assistantBuf = text;
        } else {
          assistantBuf = text.length >= assistantBuf.length ? text : assistantBuf;
        }
      } else {
        assistantBuf += text;
      }
      return;
    }

    if (type === "tool_call") {
      flushThinking();
      const sub = String(obj.subtype ?? "");
      const entry = firstToolEntry(obj.tool_call);
      const label = entry ? entry.kind : "tool";

      if (sub === "started") {
        flushAssistant();
        const argLine = summarizeToolArgs(entry);
        writeBlock(`工具 · ${label} · 开始`, argLine || callIdLine(obj));
        return;
      }

      if (sub === "completed") {
        const argLine = summarizeToolArgs(entry);
        const res = summarizeToolResult(entry);
        const head = [argLine && `参数: ${argLine}`, res && `结果:\n${res}`].filter(Boolean).join("\n");
        writeBlock(`工具 · ${label} · 完成`, head || callIdLine(obj));
      }
    }

    if (type === "result") {
      flushThinking();
      flushAssistant();
      const lines = [];
      if (obj.subtype) lines.push(`状态: ${obj.subtype}`);
      if (obj.duration_ms != null) lines.push(`耗时: ${obj.duration_ms} ms`);
      if (obj.is_error != null) lines.push(`is_error: ${obj.is_error}`);
      if (obj.usage && typeof obj.usage === "object") {
        const u = obj.usage;
        const bits = [];
        if (u.inputTokens != null) bits.push(`input ${u.inputTokens}`);
        if (u.outputTokens != null) bits.push(`output ${u.outputTokens}`);
        if (u.cacheReadTokens != null) bits.push(`cache_read ${u.cacheReadTokens}`);
        if (u.cacheWriteTokens != null) bits.push(`cache_write ${u.cacheWriteTokens}`);
        if (bits.length) lines.push(`用量: ${bits.join(", ")}`);
      }
      if (typeof obj.result === "string" && obj.result.trim()) {
        lines.push("");
        lines.push("聚合正文摘录:");
        lines.push(truncate(obj.result.trim(), 8000));
      }
      writeBlock("结束", lines.join("\n"));
    }
  }

  function callIdLine(obj) {
    return obj.call_id ? `call_id: ${obj.call_id}` : "";
  }

  function end() {
    flushThinking();
    flushAssistant();
  }

  return { pushJson, end };
}

module.exports = {
  createStreamJsonChatWriter,
};

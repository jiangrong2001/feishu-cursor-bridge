/**
 * 调试日志（可选）：桥接关键路径 + Cursor Agent 标准输出/错误流全文。
 * 启用：BRIDGE_DEBUG_LOG=1
 * 目录：BRIDGE_DEBUG_LOG_DIR（可选），默认 <INBOX_DIR>/debug
 */

const fs = require("fs");
const path = require("path");
const { envTruthy } = require("./envFlags");

function inboxDir() {
  return process.env.INBOX_DIR || path.join(__dirname, "..", "inbox");
}

function getDebugLogDir() {
  const custom = process.env.BRIDGE_DEBUG_LOG_DIR;
  if (custom && String(custom).trim()) {
    return path.resolve(String(custom).trim());
  }
  return path.join(inboxDir(), "debug");
}

function isDebugLogEnabled() {
  return envTruthy("BRIDGE_DEBUG_LOG");
}

function nowIso() {
  return new Date().toISOString();
}

function appendFile(filePath, chunk) {
  try {
    fs.appendFileSync(filePath, chunk, "utf8");
  } catch (e) {
    console.error("[bridge-debug] 写入失败:", e.message);
  }
}

function ensureDebugDir() {
  const dir = getDebugLogDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 桥接全局流水（不含用户消息正文，避免在 bridge.log 里重复敏感内容）
 * @param {string} line
 */
function bridgeDebug(line) {
  if (!isDebugLogEnabled()) return;
  try {
    const dir = ensureDebugDir();
    const p = path.join(dir, "bridge.log");
    appendFile(p, `[${nowIso()}] ${line}\n`);
  } catch (e) {
    console.error("[bridge-debug] bridge.log:", e.message);
  }
}

function sanitizeMessageId(id) {
  const s = String(id || "no-msgid").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return s.slice(0, 120) || "no-msgid";
}

/**
 * @param {{
 *   messageId?: string;
 *   chatId?: string;
 *   userText?: string;
 *   senderOpenId?: string;
 * }} ctx
 * @returns {null | {
 *   filePath: string;
 *   logJob: (event: string, detail?: string) => void;
 *   logFullPrompt: (prompt: string) => void;
 *   logSpawn: (bin: string, cwd: string, args: string[]) => void;
 *   logStdoutLine: (line: string) => void;
 *   logStderrChunk: (chunk: string) => void;
 *   logJobSummary: (o: object) => void;
 * }}
 */
function createAgentDebugSession(ctx) {
  if (!isDebugLogEnabled()) return null;
  let filePath;
  try {
    const dir = ensureDebugDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const mid = sanitizeMessageId(ctx.messageId);
    filePath = path.join(dir, `agent-${stamp}-${mid}.log`);
    const header =
      `[${nowIso()}] SESSION_START message_id=${ctx.messageId || ""} chat_id=${ctx.chatId || ""} sender_open_id=${ctx.senderOpenId || ""}\n` +
      `[${nowIso()}] USER_TEXT (完整用户命令)\n${ctx.userText ?? ""}\n\n`;
    fs.writeFileSync(filePath, header, "utf8");
  } catch (e) {
    console.error("[bridge-debug] 创建会话日志失败:", e.message);
    return null;
  }

  return {
    filePath,
    logJob(event, detail = "") {
      appendFile(filePath, `[${nowIso()}] [job] ${event}${detail ? ` ${detail}` : ""}\n`);
    },
    logFullPrompt(prompt) {
      appendFile(
        filePath,
        `\n========== 下发给 Agent 的完整 prompt (${String(prompt).length} 字符) ==========\n${prompt}\n========== END PROMPT ==========\n\n`,
      );
    },
    logSpawn(bin, cwd, args) {
      appendFile(
        filePath,
        `[${nowIso()}] SPAW bin=${JSON.stringify(bin)} cwd=${JSON.stringify(cwd)}\n` +
          `[${nowIso()}] ARGS_JSON ${JSON.stringify(args)}\n\n`,
      );
    },
    logStdoutLine(line) {
      appendFile(filePath, `[${nowIso()}] STDOUT_RAW ${line}\n`);
      const t = line.trim();
      if (!t.startsWith("{")) return;
      try {
        const obj = JSON.parse(t);
        appendFile(
          filePath,
          `[${nowIso()}] STDOUT_JSON_PRETTY type=${obj.type ?? "?"} subtype=${obj.subtype ?? ""}\n${JSON.stringify(obj, null, 2)}\n\n`,
        );
      } catch {
        appendFile(filePath, `[${nowIso()}] STDOUT_JSON_PARSE_FAIL (仍保留上方 RAW)\n`);
      }
    },
    logStderrChunk(chunk) {
      const s = String(chunk);
      appendFile(filePath, `[${nowIso()}] STDERR ${JSON.stringify(s)}\n`);
    },
    logJobSummary(o) {
      appendFile(filePath, `[${nowIso()}] JOB_SUMMARY\n${JSON.stringify(o, null, 2)}\n`);
    },
  };
}

module.exports = {
  bridgeDebug,
  createAgentDebugSession,
  isDebugLogEnabled,
  getDebugLogDir,
};

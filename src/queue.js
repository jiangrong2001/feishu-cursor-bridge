const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const { bridgeDebug } = require("./agentDebugLog");

function inboxDir() {
  return process.env.INBOX_DIR || path.join(__dirname, "..", "inbox");
}

async function ensureInbox() {
  const dir = inboxDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 飞书端可能插入 NBSP、Narrow NBSP 等，JS 默认 \s 匹配不到，会导致 /v 前缀无法剥离、/restart 误判给 Agent */
/** U+180E：MVS，trim/\\s 均不处理；若在行首会导致 ^\\s* 与 /^\\/v 整段匹配失败 */
const FEISHU_SPACE_CHARS =
  /[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b]/g;

/** ZWJ、字间零宽、双向隔离等：插在 /v 与空格之间时会导致 /(?:v)... 前缀匹配失败，整条 /restart 识别落空 */
const FEISHU_INVISIBLE_CMD_BREAKERS =
  /[\u200c\u200d\u200e\u200f\u2060\u2066-\u2069]/g;

/**
 * 统一空白并修正「/v」与「/restart」粘连，供控制命令解析与 inbox 落盘一致。
 * @param {string} raw
 */
function normalizeFeishuUserText(raw) {
  let t = String(raw || "")
    .normalize("NFKC")
    .replace(/\uFF0F/g, "/")
    .replace(FEISHU_INVISIBLE_CMD_BREAKERS, "")
    .replace(FEISHU_SPACE_CHARS, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(
    /^(\/(?:v|verbos|verbose))(\/restart\b)/i,
    (_, a, b) => `${a} ${b}`,
  );
  return t.trim();
}

function parseUserText(messageType, content) {
  if (content == null || content === "") return "";
  let j;
  if (typeof content === "string") {
    try {
      j = JSON.parse(content);
    } catch {
      return normalizeFeishuUserText(String(content));
    }
  } else if (typeof content === "object" && content !== null) {
    j = content;
  } else {
    return normalizeFeishuUserText(String(content));
  }
  let t = "";
  if (messageType === "text" && j.text != null) t = String(j.text);
  else if (j.text != null) t = String(j.text);
  else if (typeof content === "string") return normalizeFeishuUserText(content);
  else return "";
  t = t.replace(/<at[^>]*>[^<]*<\/at>/gi, " ");
  t = normalizeFeishuUserText(t);
  return t;
}

const MAX_IDS = 500;

async function loadSeenIds(dir) {
  const p = path.join(dir, ".processed-event-ids.json");
  try {
    const raw = await fs.readFile(p, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function saveSeenIds(dir, ids) {
  const p = path.join(dir, ".processed-event-ids.json");
  const trimmed = ids.slice(-MAX_IDS);
  await fs.writeFile(p, JSON.stringify(trimmed, null, 0), "utf8");
}

async function appendSeen(dir, eventId) {
  if (!eventId) return;
  const ids = await loadSeenIds(dir);
  if (ids.includes(eventId)) return false;
  ids.push(eventId);
  await saveSeenIds(dir, ids);
  return true;
}

async function alreadySeen(dir, eventId) {
  if (!eventId) return false;
  const ids = await loadSeenIds(dir);
  return ids.includes(eventId);
}

function openInCursor(filePath) {
  if (process.env.CURSOR_OPEN_ON_MESSAGE !== "1") return;
  if (process.platform !== "darwin") return;
  const bin = spawn("open", ["-a", "Cursor", filePath], {
    detached: true,
    stdio: "ignore",
  });
  bin.unref();
  try {
    spawn(
      "osascript",
      [
        "-e",
        'display notification "收到新的飞书命令，已在 Cursor 中打开 LATEST.md" with title "Feishu → Cursor"',
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
  } catch {
    /* ignore */
  }
}

/**
 * @param {object} payload
 */
async function writeIncoming(payload) {
  const dir = await ensureInbox();
  const eventId =
    payload.event_id || payload.message_id || `noid-${Date.now()}`;
  if (await alreadySeen(dir, eventId)) {
    bridgeDebug(
      `writeIncoming skip duplicate event_id=${eventId} message_id=${payload.message_id || ""}`,
    );
    return { duplicate: true };
  }

  const userText = parseUserText(payload.message_type, payload.content_raw);
  const latestJson = {
    event_id: payload.event_id || "",
    received_at: new Date().toISOString(),
    chat_id: payload.chat_id,
    message_id: payload.message_id,
    message_type: payload.message_type,
    sender_open_id: payload.sender_open_id,
    sender_type: payload.sender_type,
    user_text: userText,
    raw_content: payload.content_raw,
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(dir, `cmd-${stamp}`);

  await fs.writeFile(`${base}.json`, JSON.stringify(latestJson, null, 2), "utf8");

  const md = `# 飞书 → Cursor 命令队列

> **说明**：本文件由桥接**自动写入**。本仓库仅支持 **Cursor Agent CLI 全自动**（\`CURSOR_AGENT_AUTO=1\`）：收到消息后会触发本机 \`agent\` 子进程，并由 \`lark-cli\` / 桥接 API 将答复发回飞书。

- 收到时间: ${latestJson.received_at}
- event_id: \`${eventId || "(无)"}\`
- 发送者 open_id: \`${payload.sender_open_id || ""}\`
- chat_id（回复飞书时用）: \`${payload.chat_id || ""}\`
- message_id: \`${payload.message_id || ""}\`
- 消息类型: \`${payload.message_type || ""}\`

## 用户发来的内容

${userText || "_(无法解析为文本，请查看同目录下对应的 cmd-*.json 中的 raw_content)_"}

## 通过 lark-cli 回复飞书（供手动排错时参考）

\`\`\`bash
lark-cli im +messages-send --as bot --chat-id "${payload.chat_id || "CHAT_ID"}" --text "在这里写回复内容"
\`\`\`
`;

  await fs.writeFile(path.join(dir, "LATEST.md"), md, "utf8");
  await fs.writeFile(path.join(dir, "LATEST.json"), JSON.stringify(latestJson, null, 2), "utf8");

  await appendSeen(dir, eventId);

  openInCursor(path.join(dir, "LATEST.md"));

  bridgeDebug(
    `writeIncoming ok file=${base}.json message_id=${payload.message_id || ""} user_text_len=${String(userText).length}`,
  );

  return { duplicate: false, effectiveUserText: userText };
}

module.exports = {
  writeIncoming,
  parseUserText,
  normalizeFeishuUserText,
  inboxDir,
};

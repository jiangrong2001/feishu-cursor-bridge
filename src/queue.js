const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

function inboxDir() {
  return process.env.INBOX_DIR || path.join(__dirname, "..", "inbox");
}

async function ensureInbox() {
  const dir = inboxDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function parseUserText(messageType, contentStr) {
  if (!contentStr) return "";
  try {
    const j = JSON.parse(contentStr);
    let t = "";
    if (messageType === "text" && j.text) t = String(j.text);
    else if (j.text) t = String(j.text);
    else return contentStr;
    t = t.replace(/<at[^>]*>[^<]*<\/at>/gi, " ").replace(/\s+/g, " ").trim();
    return t;
  } catch {
    /* ignore */
  }
  return contentStr;
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

  return { duplicate: false };
}

module.exports = {
  writeIncoming,
  parseUserText,
  inboxDir,
};

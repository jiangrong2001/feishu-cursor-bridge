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
    if (messageType === "text" && j.text) return String(j.text).trim();
    if (j.text) return String(j.text).trim();
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
 * @param {import('@larksuiteoapi/node-sdk').Client | null} client
 */
async function writeIncoming(payload, client) {
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

> **重要**：本文件由桥接服务**自动写入**。\`已收到…\` 那条飞书消息也是桥接发的，**不代表 Cursor 已处理**。\`lark-cli\` **不会**自动执行下面命令——你必须在 **Cursor 里对 Agent 说「处理 inbox/LATEST.md」**，由 Agent 完成任务后在终端执行发消息命令，飞书才会收到**结果**。

- 收到时间: ${latestJson.received_at}
- event_id: \`${eventId || "(无)"}\`
- 发送者 open_id: \`${payload.sender_open_id || ""}\`
- chat_id（回复飞书时用）: \`${payload.chat_id || ""}\`
- message_id: \`${payload.message_id || ""}\`
- 消息类型: \`${payload.message_type || ""}\`

## 用户发来的内容

${userText || "_(无法解析为文本，请查看同目录下对应的 cmd-*.json 中的 raw_content)_"}

## 请你（Cursor Agent）处理说明

1. 根据上文完成用户请求的分析或操作。
2. 需要把结果发回手机飞书时，在终端使用 \`lark-cli\`（机器人身份示例）：

\`\`\`bash
lark-cli im +messages-send --as bot --chat-id "${payload.chat_id || "CHAT_ID"}" --text "在这里写回复内容"
\`\`\`

若需用户身份或群权限，请查阅已安装的 \`lark-im\` / \`lark-shared\` skill，并确认 \`lark-cli auth status\` 与 scope。

3. 处理完成后可删除本文件或保留作记录。
`;

  await fs.writeFile(path.join(dir, "LATEST.md"), md, "utf8");
  await fs.writeFile(path.join(dir, "LATEST.json"), JSON.stringify(latestJson, null, 2), "utf8");

  await appendSeen(dir, eventId);

  openInCursor(path.join(dir, "LATEST.md"));

  if (
    client &&
    process.env.LARK_AUTO_ACK === "1" &&
    payload.chat_id &&
    userText
  ) {
    try {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: payload.chat_id,
          msg_type: "text",
          content: JSON.stringify({
            text: "已记入本机 inbox/LATEST.md。桥接不会自动跑 Cursor：请在本机 Cursor（本仓库）对 AI 说「处理飞书队列」，由 AI 执行 lark-cli 把结果发回飞书。",
          }),
        },
      });
    } catch (e) {
      console.error("[bridge] auto-ack failed:", e.message);
    }
  }

  return { duplicate: false };
}

module.exports = {
  writeIncoming,
  parseUserText,
  inboxDir,
};

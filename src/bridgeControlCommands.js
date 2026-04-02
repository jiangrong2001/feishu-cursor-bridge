/**
 * 飞书侧控制命令：/h、启动/重启后推送说明；与 Agent 任务互斥（整段匹配）。
 */

const fs = require("fs");
const path = require("path");
const { getFeishuTextMaxChars } = require("./feishuMessageLimits");
const { envTruthy } = require("./envFlags");
const { bridgeDebug } = require("./agentDebugLog");

function bridgePackageRoot() {
  return path.join(__dirname, "..");
}

function lastChatFilePath() {
  return path.join(bridgePackageRoot(), ".bridge-last-chat.json");
}

/** 记录最近一次成功写入 inbox 的会话，用于冷启动时推送控制命令说明 */
function saveLastNotifyChatId(chatId) {
  if (!chatId) return;
  try {
    fs.writeFileSync(
      lastChatFilePath(),
      `${JSON.stringify(
        { chat_id: chatId, at: new Date().toISOString() },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (e) {
    console.error("[bridge] 写入 last-chat 失败:", e.message);
  }
}

function readLastNotifyChatId() {
  try {
    const j = JSON.parse(fs.readFileSync(lastChatFilePath(), "utf8"));
    return String(j.chat_id || "").trim();
  } catch {
    return "";
  }
}

function truncateFeishuApiText(text) {
  const max = getFeishuTextMaxChars();
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 24))}\n…(截断)`;
}

async function sendBridgeText(client, chatId, text) {
  if (!client || !chatId || !text) return;
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: truncateFeishuApiText(text) }),
    },
  });
}

function splitTextForFeishu(text, maxChars) {
  const s = String(text);
  if (s.length <= maxChars) return [s];
  const parts = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + maxChars, s.length);
    if (end < s.length) {
      const nl = s.lastIndexOf("\n", end);
      if (nl > i + maxChars * 0.55) end = nl + 1;
    }
    parts.push(s.slice(i, end));
    i = end;
  }
  for (let k = 1; k < parts.length; k++) {
    parts[k] = `（续 ${k + 1}/${parts.length}）\n${parts[k]}`;
  }
  return parts;
}

/** Gitee 仓库 blob 根（默认分支 main）；整链可用 BRIDGE_DOCS_README_ZH_URL / BRIDGE_DOCS_README_EN_URL 覆盖 */
const DEFAULT_GITEE_README_BLOB_BASE =
  "https://gitee.com/jiangrong2001/feishu-cursor-bridge/blob/main";

function docsReadmeZhUrl() {
  const u = process.env.BRIDGE_DOCS_README_ZH_URL?.trim();
  if (u) return u;
  return `${DEFAULT_GITEE_README_BLOB_BASE}/README.zh.md#L130`;
}

function docsReadmeEnUrl() {
  const u = process.env.BRIDGE_DOCS_README_EN_URL?.trim();
  if (u) return u;
  return `${DEFAULT_GITEE_README_BLOB_BASE}/README.md#L132`;
}

/** 与 README 专题一致的简明正文（飞书多条气泡） */
function controlCommandsHelpBodyZh() {
  return [
    "【桥接控制命令一览】",
    "以下命令须**单独一条消息**发送（可前导空格）；**不区分大小写**。普通任务请不要以这些前缀开头。",
    "",
    "· /h 或 /help",
    "  由机器人发送本条控制命令说明（不触发 Agent）。",
    "",
    "· /v、/verbos、/verbose",
    "  前缀后须空格或换行再写任务正文。去掉前缀后的文字交给 Agent；本轮在飞书**按段推送**与 agent-*.chat.txt 同格式的「对话摘录」。",
    "  与环境变量 CURSOR_AGENT_STREAM_TO_FEISHU=1 的进度推送**不叠加**（用 /v 时不再发那套 🔧/📝）。",
    "  可调 CURSOR_AGENT_TRANSCRIPT_MIN_INTERVAL_MS（默认 350ms）控制摘录消息间隔。",
    "",
    "· /restart",
    "  仅 /restart：重启桥接 Node 进程，工作区不变（仍含 .bridge-workspace-override 若存在）。",
    "  /restart <目录>：将目录设为 Agent 工作区（写入 .bridge-workspace-override）后重启。支持绝对路径、相对仓库根、~/…",
    "  需进程托管（npm/pm2 等）才能自动拉起。可用 BRIDGE_RESTART_VIA_FEISHU=0 关闭。",
    "",
    "· 重试（非斜杠命令）",
    "  发送「重试」等可复用上一条**已去控制前缀**的任务正文。",
    "",
    "完整说明（在线，飞书控制命令专题）：",
    `  中文 README.zh.md：${docsReadmeZhUrl()}`,
    `  英文 README.md：${docsReadmeEnUrl()}`,
  ].join("\n");
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function parseHelpCommand(text) {
  const t = String(text || "").trim();
  return /^\s*\/(?:h|help)(?:\s*)$/is.test(t);
}

/**
 * 发送控制命令说明（可多条飞书消息）。
 * @param {import('@larksuiteoapi/node-sdk').Client} client
 * @param {string} chatId
 * @param {string} [prefixLine] 可选首条前缀（如「桥接已启动」）
 */
async function sendControlCommandsHelpToFeishu(client, chatId, prefixLine = "") {
  if (!client || !chatId) return;
  const max = getFeishuTextMaxChars();
  const body = controlCommandsHelpBodyZh();
  const full = prefixLine
    ? `${String(prefixLine).trim()}\n\n${body}`
    : body;
  const parts = splitTextForFeishu(full, max);
  for (let i = 0; i < parts.length; i++) {
    try {
      await sendBridgeText(client, chatId, parts[i]);
      bridgeDebug(
        `control_help part ${i + 1}/${parts.length} chat_id=${chatId}`,
      );
    } catch (e) {
      console.error("[bridge] 控制命令说明发送失败:", e.message);
      bridgeDebug(`control_help send_fail part=${i} ${e.message}`);
      break;
    }
  }
}

function startupControlHelpDisabled() {
  return envTruthy("BRIDGE_DISABLE_STARTUP_CONTROL_HELP");
}

/**
 * 冷启动：向最近一次会话推送「已启动 + 控制命令说明」。
 * @param {import('@larksuiteoapi/node-sdk').Client} client
 */
async function notifyColdStartControlCommandsHelp(client) {
  if (startupControlHelpDisabled() || !client) return;
  const cid = readLastNotifyChatId();
  if (!cid) {
    bridgeDebug("startup control_help skip (no last chat_id file)");
    return;
  }
  await sendControlCommandsHelpToFeishu(
    client,
    cid,
    "桥接服务已启动。以下为可用控制命令（普通任务请勿使用这些前缀）：",
  );
  bridgeDebug(`startup control_help sent chat_id=${cid}`);
}

module.exports = {
  controlCommandsHelpBodyZh,
  notifyColdStartControlCommandsHelp,
  parseHelpCommand,
  saveLastNotifyChatId,
  sendControlCommandsHelpToFeishu,
};

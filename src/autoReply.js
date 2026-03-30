/**
 * 后台队列：飞书事件回调必须快速返回；大模型调用在此异步执行并发回飞书。
 */

const { complete } = require("./llm");

const FEISHU_TEXT_MAX = 18000;

/** @type {Array<{ client: import('@larksuiteoapi/node-sdk').Client; chatId: string; userText: string }>} */
const q = [];
let draining = false;

function truncateFeishu(text) {
  const s = String(text);
  if (s.length <= FEISHU_TEXT_MAX) return s;
  return `${s.slice(0, FEISHU_TEXT_MAX - 20)}\n\n…(已截断)`;
}

async function sendText(client, chatId, text) {
  if (!chatId || !text) return;
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: truncateFeishu(text) }),
    },
  });
}

async function runJob(job) {
  const { client, chatId, userText } = job;
  try {
    await sendText(client, chatId, "正在生成回复…");
    const answer = await complete(userText);
    await sendText(client, chatId, answer);
    console.log("[auto-reply] sent to chat", chatId);
  } catch (e) {
    console.error("[auto-reply] failed:", e.message);
    try {
      await sendText(
        client,
        chatId,
        `自动回复失败：${e.message}`.slice(0, 2000),
      );
    } catch (e2) {
      console.error("[auto-reply] could not send error to Feishu:", e2.message);
    }
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (q.length) {
      const job = q.shift();
      if (job) await runJob(job);
    }
  } finally {
    draining = false;
  }
}

/**
 * @param {{ client: import('@larksuiteoapi/node-sdk').Client; chatId: string; userText: string }} p
 */
function enqueueAutoReply(p) {
  if (process.env.AUTO_REPLY_ENABLED !== "1") return;
  if (!p.client || !p.chatId || !p.userText || !String(p.userText).trim()) return;
  q.push(p);
  setImmediate(() => {
    drain().catch((e) => console.error("[auto-reply] drain:", e.message));
  });
}

function validateConfig() {
  if (process.env.AUTO_REPLY_ENABLED !== "1") return;
  if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
    console.error(
      "[bridge] AUTO_REPLY_ENABLED=1 需要 LARK_APP_ID 与 LARK_APP_SECRET（用于向飞书发消息）",
    );
    process.exit(1);
  }
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("[bridge] AUTO_REPLY_ENABLED=1 需要配置 ANTHROPIC_API_KEY");
      process.exit(1);
    }
  } else if (provider === "openai" || provider === "openai-compatible") {
    if (!process.env.OPENAI_API_KEY) {
      console.error("[bridge] AUTO_REPLY_ENABLED=1 需要配置 OPENAI_API_KEY");
      process.exit(1);
    }
  } else {
    console.error(
      "[bridge] LLM_PROVIDER 须为 openai、openai-compatible 或 anthropic",
    );
    process.exit(1);
  }
  console.log(
    "[bridge] 全自动回复已开启（LLM_PROVIDER=%s，不依赖 Cursor 对话）",
    provider,
  );
}

module.exports = { enqueueAutoReply, validateConfig };

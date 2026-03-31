require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const path = require("path");
const lark = require("@larksuiteoapi/node-sdk");
const { writeIncoming, parseUserText } = require("./queue");
const { enqueueAutoReply, validateConfig } = require("./autoReply");
const {
  enqueueCursorAgent,
  validateCursorAgentConfig,
} = require("./cursorAgentRunner");
const { envTruthy } = require("./envFlags");

function validateAutomation() {
  const ca = envTruthy("CURSOR_AGENT_AUTO");
  const llm = envTruthy("AUTO_REPLY_ENABLED");
  if (ca && llm) {
    console.error(
      "[bridge] CURSOR_AGENT_AUTO 与 AUTO_REPLY_ENABLED 只能开启其一（Cursor Agent CLI vs 直连大模型）",
    );
    process.exit(1);
  }
  validateCursorAgentConfig();
  if (!ca) validateConfig();
  console.log(
    `[bridge] 自动化状态: Cursor Agent CLI=${ca ? "开" : "关"} 直连大模型=${llm ? "开" : "关"}`,
  );
}

const BRIDGE_MODE = (process.env.BRIDGE_MODE || "ws").toLowerCase();
const PORT = Number(process.env.PORT || 8787, 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook/feishu";

const encryptKey = process.env.LARK_ENCRYPT_KEY || "";
const verificationToken = process.env.LARK_VERIFICATION_TOKEN || "";
const appId = process.env.LARK_APP_ID || "";
const appSecret = process.env.LARK_APP_SECRET || "";

function larkDomain() {
  return process.env.LARK_USE_LARK_INTERNATIONAL === "1"
    ? lark.Domain.Lark
    : lark.Domain.Feishu;
}

function parseAllowlist() {
  const raw = process.env.ALLOWED_SENDER_OPEN_IDS || "";
  if (!raw.trim()) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

const allowlist = parseAllowlist();

/** 飞书可能用不同 event_id 重复投递同一条消息；在 await 前去重，避免并发入队 */
const claimedDeliveryKeys = new Set();
const claimedDeliveryOrder = [];
const CLAIM_DELIVERY_CAP = 4000;

function tryClaimDelivery(messageId, eventId) {
  const keys = [];
  if (messageId) keys.push(`m:${messageId}`);
  if (eventId) keys.push(`e:${eventId}`);
  if (keys.length === 0) return true;
  for (const k of keys) {
    if (claimedDeliveryKeys.has(k)) return false;
  }
  for (const k of keys) {
    claimedDeliveryKeys.add(k);
    claimedDeliveryOrder.push(k);
  }
  while (claimedDeliveryOrder.length > CLAIM_DELIVERY_CAP) {
    const old = claimedDeliveryOrder.shift();
    claimedDeliveryKeys.delete(old);
  }
  return true;
}

function buildLarkClient() {
  if (!appId || !appSecret) return null;
  return new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: larkDomain(),
  });
}

function createImMessageHandler(client) {
  return async (data) => {
    const senderType = data.sender?.sender_type || "";
    if (senderType === "app") {
      return {};
    }

    const openId = data.sender?.sender_id?.open_id || "";
    if (allowlist && openId && !allowlist.has(openId)) {
      console.warn("[bridge] ignored sender (not in allowlist):", openId);
      return {};
    }

    const msg = data.message || {};
    const mid = msg.message_id || "";
    const eid = data.event_id || "";
    if (!tryClaimDelivery(mid, eid)) {
      console.log("[bridge] duplicate delivery skipped (sync):", mid || eid);
      return {};
    }

    const userText = parseUserText(msg.message_type, msg.content || "");
    const payload = {
      event_id: data.event_id || "",
      chat_id: msg.chat_id || "",
      message_id: msg.message_id || "",
      message_type: msg.message_type || "",
      content_raw: msg.content || "",
      sender_open_id: openId,
      sender_type: senderType,
    };

    const result = await writeIncoming(payload, client);
    if (result.duplicate) {
      console.log("[bridge] duplicate event_id, skipped:", payload.event_id);
    } else {
      console.log("[bridge] queued message", payload.message_id, "chat", payload.chat_id);
      if (envTruthy("CURSOR_AGENT_AUTO")) {
        enqueueCursorAgent({
          client,
          chatId: payload.chat_id,
          userText,
          messageId: payload.message_id || "",
        });
      } else {
        enqueueAutoReply({
          client,
          chatId: payload.chat_id,
          userText,
        });
      }
    }
    return {};
  };
}

function startHealthOnlyServer() {
  const server = http.createServer((req, res) => {
    const pathOnly = (req.url || "").split("?")[0];
    if (req.method === "GET" && pathOnly === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(
        `[bridge] 端口 ${PORT} 已被占用，已跳过 /health（WebSocket 长连接不受影响）。可执行: lsof -i :${PORT} 或修改 .env 的 PORT`,
      );
      return;
    }
    console.error("[bridge] health 服务异常:", err.message);
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`[bridge] health: http://127.0.0.1:${PORT}/health`);
  });
}

function startHttpWebhook(client) {
  if (!encryptKey || !verificationToken) {
    console.error(
      "[bridge] HTTP 模式需要 LARK_ENCRYPT_KEY 与 LARK_VERIFICATION_TOKEN（飞书事件订阅 Webhook）",
    );
    process.exit(1);
  }

  const eventDispatcher = new lark.EventDispatcher({
    encryptKey,
    verificationToken,
  }).register({
    "im.message.receive_v1": createImMessageHandler(client),
    "im.message.message_read_v1": () => ({}),
  });

  const server = http.createServer((req, res) => {
    const pathOnly = (req.url || "").split("?")[0];

    if (req.method === "GET" && pathOnly === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (pathOnly !== WEBHOOK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const rawUrl = req.url;
    req.url = WEBHOOK_PATH;

    const adapter = lark.adaptDefault(WEBHOOK_PATH, eventDispatcher, {
      autoChallenge: true,
    });

    adapter(req, res)
      .catch((err) => {
        console.error("[bridge] adapter error:", err);
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end("error");
        }
      })
      .finally(() => {
        req.url = rawUrl;
      });
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[bridge] 端口 ${PORT} 已被占用，HTTP Webhook 无法启动。请释放端口或修改 .env 的 PORT`,
      );
      process.exit(1);
    }
    console.error("[bridge] HTTP 服务异常:", err.message);
    process.exit(1);
  });

  server.listen(PORT, () => {
    console.log(
      `[bridge] HTTP Webhook http://127.0.0.1:${PORT}${WEBHOOK_PATH}  (GET /health)`,
    );
    console.log(`[bridge] inbox: ${path.join(__dirname, "..", "inbox")}`);
  });
}

async function startWsMode() {
  if (!appId || !appSecret) {
    console.error(
      "[bridge] 长连接模式需要 LARK_APP_ID 与 LARK_APP_SECRET（与 OpenClaw 飞书插件相同）",
    );
    console.error(
      "[bridge] 飞书后台：事件订阅 → 订阅方式 → 使用长连接接收事件；订阅 im.message.receive_v1",
    );
    process.exit(1);
  }

  const client = buildLarkClient();

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": createImMessageHandler(client),
    "im.message.message_read_v1": () => ({}),
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    domain: larkDomain(),
    loggerLevel: lark.LoggerLevel.info,
  });

  await wsClient.start({ eventDispatcher });

  console.log("[bridge] mode=ws 长连接已启动（本机主动连飞书，无需公网 URL）");
  console.log(`[bridge] inbox: ${path.join(__dirname, "..", "inbox")}`);

  if (process.env.BRIDGE_HEALTH_DISABLED !== "1") {
    startHealthOnlyServer();
  }
}

validateAutomation();

if (BRIDGE_MODE === "http") {
  const client = buildLarkClient();
  startHttpWebhook(client);
} else if (BRIDGE_MODE === "ws") {
  startWsMode().catch((e) => {
    console.error("[bridge] ws start failed:", e);
    process.exit(1);
  });
} else {
  console.error("[bridge] BRIDGE_MODE 须为 ws 或 http，当前:", BRIDGE_MODE);
  process.exit(1);
}

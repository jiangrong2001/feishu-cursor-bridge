require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const path = require("path");
const lark = require("@larksuiteoapi/node-sdk");
const { writeIncoming, parseUserText } = require("./queue");
const {
  enqueueCursorAgent,
  validateCursorAgentConfig,
} = require("./cursorAgentRunner");
const { envTruthy } = require("./envFlags");
const {
  validateSecurityAndLimits,
  healthBindHost,
} = require("./securityConfig");
const { validateFeishuMessageLimits } = require("./feishuMessageLimits");
const { bridgeDebug } = require("./agentDebugLog");

function validateStartup() {
  if (!envTruthy("CURSOR_AGENT_AUTO")) {
    console.error(
      "[bridge] 请在 .env 中设置 CURSOR_AGENT_AUTO=1（本项目仅支持 Cursor Agent CLI 全自动）",
    );
    process.exit(1);
  }
  validateSecurityAndLimits();
  validateFeishuMessageLimits();
  validateCursorAgentConfig();
}

const PORT = Number(process.env.PORT || 8787, 10);
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

/**
 * 飞书可能多次投递；在 await 前去重，避免并发入队。
 * message_id 仅在「已解析出非空正文」时才占用，避免空包先至导致正文包被丢弃。
 */
const claimedDeliveryKeys = new Set();
const claimedDeliveryOrder = [];
const CLAIM_DELIVERY_CAP = 4000;

function tryClaimDelivery(messageId, eventId, lockMessageId) {
  const keys = [];
  if (eventId) keys.push(`e:${eventId}`);
  if (lockMessageId && messageId) keys.push(`m:${messageId}`);
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
      bridgeDebug("im.message handler skip sender_type=app");
      return {};
    }

    const openId = data.sender?.sender_id?.open_id || "";
    if (allowlist && openId && !allowlist.has(openId)) {
      console.warn("[bridge] ignored sender (not in allowlist):", openId);
      bridgeDebug(`im.message handler skip allowlist open_id=${openId}`);
      return {};
    }

    const msg = data.message || {};
    const mid = msg.message_id || "";
    const eid = data.event_id || "";
    const userText = parseUserText(msg.message_type, msg.content || "");
    const lockMessageId = !!String(userText).trim();

    if (!tryClaimDelivery(mid, eid, lockMessageId)) {
      console.log("[bridge] duplicate delivery skipped (sync):", mid || eid);
      bridgeDebug(
        `handler skip duplicate_claim message_id=${mid || ""} event_id=${eid || ""}`,
      );
      return {};
    }

    const payload = {
      event_id: data.event_id || "",
      chat_id: msg.chat_id || "",
      message_id: msg.message_id || "",
      message_type: msg.message_type || "",
      content_raw: msg.content || "",
      sender_open_id: openId,
      sender_type: senderType,
    };

    const result = await writeIncoming(payload);
    if (result.duplicate) {
      console.log("[bridge] duplicate event_id, skipped:", payload.event_id);
    } else {
      console.log("[bridge] queued message", payload.message_id, "chat", payload.chat_id);
      bridgeDebug(
        `handler write_incoming_ok message_id=${payload.message_id || ""} chat_id=${payload.chat_id || ""} open_id=${openId}`,
      );
      enqueueCursorAgent({
        client,
        chatId: payload.chat_id,
        userText,
        messageId: payload.message_id || "",
        senderOpenId: openId,
      });
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
  const bindHost = healthBindHost();
  server.listen(PORT, bindHost, () => {
    const hostForUrl =
      bindHost.includes(":") && !bindHost.startsWith("[")
        ? `[${bindHost}]`
        : bindHost;
    console.log(`[bridge] health: http://${hostForUrl}:${PORT}/health`);
  });
}

async function startWsMode() {
  if (!appId || !appSecret) {
    console.error("[bridge] 需要 LARK_APP_ID 与 LARK_APP_SECRET");
    console.error(
      "[bridge] 飞书后台：事件订阅 → 使用长连接接收事件；订阅 im.message.receive_v1",
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

  bridgeDebug("ws_client started (im.message.receive_v1 registered)");
  console.log("[bridge] mode=ws 长连接已启动（本机主动连飞书，无需公网 URL）");
  console.log(`[bridge] inbox: ${path.join(__dirname, "..", "inbox")}`);

  if (process.env.BRIDGE_HEALTH_DISABLED !== "1") {
    startHealthOnlyServer();
  }
}

validateStartup();
bridgeDebug("startup ok, entering startWsMode");

startWsMode().catch((e) => {
  console.error("[bridge] ws start failed:", e);
  process.exit(1);
});

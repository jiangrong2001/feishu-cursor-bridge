require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const {
  applyWorkspaceOverrideFromDisk,
  maybeHandleBridgeRestartFromFeishu,
  notifyFeishuAfterRestartIfPending,
  parseRestartFeishuLine,
} = require("./bridgeRestart");
applyWorkspaceOverrideFromDisk();

const http = require("http");
const path = require("path");
const lark = require("@larksuiteoapi/node-sdk");
const { writeIncoming, parseUserText } = require("./queue");
const {
  enqueueCursorAgent,
  validateCursorAgentConfig,
  workspaceRoot,
  parseTranscriptVerbosePrefix,
} = require("./cursorAgentRunner");
const { acquireBridgeSingletonLock } = require("./bridgeSingletonLock");
const { envTruthy } = require("./envFlags");
const {
  validateSecurityAndLimits,
  healthBindHost,
} = require("./securityConfig");
const { validateFeishuMessageLimits } = require("./feishuMessageLimits");
const { bridgeDebug } = require("./agentDebugLog");
const {
  parseHelpCommand,
  saveLastNotifyChatId,
  sendControlCommandsHelpToFeishu,
  notifyColdStartControlCommandsHelp,
} = require("./bridgeControlCommands");

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

/**
 * 长连接 v2.0：正文常在 data.event.message，顶层 data.message 可能为空壳或非空但较短；
 * 用 parseUserText 后的长度择优，避免 handler 里 userText 与 inbox 落盘不一致导致 /restart 解析落空。
 */
function pickImMessageFromEvent(data) {
  const nested = data?.event?.message;
  const top = data?.message;
  const textLen = (m) => {
    if (!m || typeof m !== "object") return 0;
    const t = parseUserText(m.message_type || "text", m.content ?? "");
    return String(t || "").trim().length;
  };
  const tn = textLen(nested);
  const tt = textLen(top);
  if (tn > tt && nested) {
    bridgeDebug(
      `im.pick_message use=event.message top_parse_len=${tt} nested_parse_len=${tn}`,
    );
  }
  if (tn > tt) return nested;
  return top || nested || {};
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

    const msg = pickImMessageFromEvent(data);
    const mid = msg.message_id || "";
    const eid =
      data.event?.event_id ||
      data.header?.event_id ||
      data.event_id ||
      "";
    const userTextForLock = parseUserText(msg.message_type, msg.content || "");
    const lockMessageId = !!String(userTextForLock).trim();

    if (!tryClaimDelivery(mid, eid, lockMessageId)) {
      console.log("[bridge] duplicate delivery skipped (sync):", mid || eid);
      bridgeDebug(
        `handler skip duplicate_claim message_id=${mid || ""} event_id=${eid || ""}`,
      );
      return {};
    }

    const payload = {
      event_id: eid,
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
      const userText =
        result.effectiveUserText != null
          ? String(result.effectiveUserText)
          : userTextForLock;
      console.log("[bridge] queued message", payload.message_id, "chat", payload.chat_id);
      bridgeDebug(
        `handler write_incoming_ok message_id=${payload.message_id || ""} chat_id=${payload.chat_id || ""} open_id=${openId}`,
      );
      saveLastNotifyChatId(payload.chat_id);
      if (parseHelpCommand(userText)) {
        try {
          await sendControlCommandsHelpToFeishu(client, payload.chat_id);
        } catch (e) {
          console.error("[bridge] /h 说明发送失败:", e.message);
        }
        bridgeDebug(
          `handler control_help message_id=${payload.message_id || ""} chat_id=${payload.chat_id || ""}`,
        );
        return {};
      }
      // /restart：在 bridgeRestart 内与「剥 /v」同一套 parseRestartFeishuLine 解析，避免 index 与 runner 两处剥前缀不一致而入队 Agent
      let restartHandled = await maybeHandleBridgeRestartFromFeishu(
        client,
        payload.chat_id,
        userText,
      );
      if (!restartHandled && /\/restart\b/i.test(userText)) {
        const vp = parseTranscriptVerbosePrefix(userText);
        restartHandled = await maybeHandleBridgeRestartFromFeishu(
          client,
          payload.chat_id,
          vp.stripped,
          { streamTranscriptToFeishu: vp.streamTranscript },
        );
      }
      if (restartHandled) {
        bridgeDebug(
          `handler bridge_restart message_id=${payload.message_id || ""} chat_id=${payload.chat_id || ""}`,
        );
      } else {
        if (/\/restart\b/i.test(userText)) {
          const prMiss = parseRestartFeishuLine(userText);
          bridgeDebug(
            `handler restart_missed_enqueue_agent message_id=${payload.message_id || ""} parse_ok=${!!prMiss} user_preview=${JSON.stringify(String(userText).slice(0, 120))}`,
          );
          console.warn(
            "[bridge] 本条含 /restart 但桥接未处理，将交给 Agent。请确认仅单实例运行并已拉最新代码；可设 BRIDGE_DEBUG_LOG=1 查 bridge.log",
          );
        }
        enqueueCursorAgent({
          client,
          chatId: payload.chat_id,
          userText,
          messageId: payload.message_id || "",
          senderOpenId: openId,
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

  const didRestartWelcome = await notifyFeishuAfterRestartIfPending(client);
  if (!didRestartWelcome) {
    await notifyColdStartControlCommandsHelp(client);
  }

  if (process.env.BRIDGE_HEALTH_DISABLED !== "1") {
    startHealthOnlyServer();
  }
}

validateStartup();
acquireBridgeSingletonLock();
console.log("[bridge] Cursor Agent 工作区:", workspaceRoot());
console.log("[bridge] 桥接代码目录（请确认与 git 工作区一致）:", path.resolve(__dirname, ".."));
bridgeDebug(
  "startup ok, entering startWsMode (restart_parse=normalize+zwstrip+mvs180e+restart_suffix, im_handler=strip_fallback)",
);

startWsMode().catch((e) => {
  console.error("[bridge] ws start failed:", e);
  process.exit(1);
});

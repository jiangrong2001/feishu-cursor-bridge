require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const path = require("path");
const lark = require("@larksuiteoapi/node-sdk");
const { writeIncoming } = require("./queue");

const PORT = Number(process.env.PORT || 8787, 10);
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/webhook/feishu";

const encryptKey = process.env.LARK_ENCRYPT_KEY || "";
const verificationToken = process.env.LARK_VERIFICATION_TOKEN || "";

if (!encryptKey || !verificationToken) {
  console.error(
    "[bridge] 请在 feishu-cursor-bridge/.env 中配置 LARK_ENCRYPT_KEY 与 LARK_VERIFICATION_TOKEN（飞书应用 → 事件订阅）",
  );
  process.exit(1);
}

/** @type {import('@larksuiteoapi/node-sdk').Client | null} */
let client = null;
if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET) {
  const domain =
    process.env.LARK_USE_LARK_INTERNATIONAL === "1"
      ? lark.Domain.Lark
      : lark.Domain.Feishu;
  client = new lark.Client({
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    appType: lark.AppType.SelfBuild,
    domain,
  });
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

const eventDispatcher = new lark.EventDispatcher({
  encryptKey,
  verificationToken,
}).register({
  "im.message.receive_v1": async (data) => {
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
    }
    return {};
  },
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

server.listen(PORT, () => {
  console.log(
    `[bridge] listening http://127.0.0.1:${PORT}${WEBHOOK_PATH}  (GET /health for probe)`,
  );
  console.log(`[bridge] inbox: ${path.join(__dirname, "..", "inbox")}`);
});

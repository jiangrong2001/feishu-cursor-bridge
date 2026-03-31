/**
 * 安全相关环境变量：解析、校验、启动期集中检查。
 */

const fs = require("fs");
const path = require("path");
const { envTruthy } = require("./envFlags");

const MAX_QUEUE_CAP = 500;
/** 单任务超时上限 24h，防止误配极大值 */
const TIMEOUT_MS_CAP = 24 * 60 * 60 * 1000;

let limitsCache = null;

function die(msg) {
  console.error("[bridge]", msg);
  process.exit(1);
}

function parseTimeoutMs() {
  const raw = process.env.CURSOR_AGENT_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === "") return 0;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    die("CURSOR_AGENT_TIMEOUT_MS 须为 >=0 的整数（0=不限制）");
  }
  if (n > TIMEOUT_MS_CAP) {
    die(`CURSOR_AGENT_TIMEOUT_MS 超过上限 ${TIMEOUT_MS_CAP}（约 24h）`);
  }
  return n;
}

/**
 * 待执行 Agent 任务队列上限。0 或未配置时默认 30；设为 0 表示不限制（不推荐生产）。
 */
function parseMaxQueue() {
  const raw = process.env.CURSOR_AGENT_MAX_QUEUE;
  if (raw === undefined || String(raw).trim() === "") return 30;
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) {
    die("CURSOR_AGENT_MAX_QUEUE 须为 >=0 的整数（0=不限制队列长度，不推荐生产）");
  }
  if (n > MAX_QUEUE_CAP) {
    die(`CURSOR_AGENT_MAX_QUEUE 超过上限 ${MAX_QUEUE_CAP}`);
  }
  return n;
}

function loadLimits() {
  if (!limitsCache) {
    limitsCache = {
      maxQueue: parseMaxQueue(),
      timeoutMs: parseTimeoutMs(),
    };
  }
  return limitsCache;
}

function validateOpenIdFormat() {
  if (!envTruthy("VALIDATE_SENDER_OPEN_ID_FORMAT")) return;
  const raw = process.env.ALLOWED_SENDER_OPEN_IDS || "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const re = /^ou_[A-Za-z0-9_-]+$/;
  for (const id of ids) {
    if (!re.test(id)) {
      die(
        `VALIDATE_SENDER_OPEN_ID_FORMAT=1：ALLOWED_SENDER_OPEN_IDS 中含非法项「${id}」，期望形如 ou_xxx`,
      );
    }
  }
  console.log("[bridge] 已校验 ALLOWED_SENDER_OPEN_IDS 格式（ou_ 前缀）");
}

/**
 * 启动时调用：白名单强制、限制项解析、严格配置校验。
 */
function validateSecurityAndLimits() {
  if (envTruthy("REQUIRE_SENDER_ALLOWLIST")) {
    const raw = process.env.ALLOWED_SENDER_OPEN_IDS || "";
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      die(
        "REQUIRE_SENDER_ALLOWLIST=1 时必须配置非空的 ALLOWED_SENDER_OPEN_IDS",
      );
    }
  } else {
    const hasAllow =
      (process.env.ALLOWED_SENDER_OPEN_IDS || "").split(",").some((s) => s.trim());
    if (!hasAllow && !envTruthy("BRIDGE_SILENCE_INSECURE_ALLOWLIST_WARNING")) {
      console.warn(
        "[bridge] 安全提示：未配置 ALLOWED_SENDER_OPEN_IDS，凡能与机器人会话的用户均可触发本机 Agent。生产环境请配置白名单并设 REQUIRE_SENDER_ALLOWLIST=1。",
      );
    }
  }

  validateOpenIdFormat();

  const { maxQueue, timeoutMs } = loadLimits();
  const queueLabel = maxQueue === 0 ? "不限制" : `${maxQueue} 条`;
  console.log(
    `[bridge] 限制项: CURSOR_AGENT_MAX_QUEUE=${queueLabel}, CURSOR_AGENT_TIMEOUT_MS=${timeoutMs || "0（不限制）"}`,
  );

  if (envTruthy("BRIDGE_STRICT_CONFIG")) {
    const bin = process.env.CURSOR_AGENT_BIN || "agent";
    if (path.isAbsolute(bin)) {
      if (!fs.existsSync(bin)) {
        die(`BRIDGE_STRICT_CONFIG=1：CURSOR_AGENT_BIN 路径不存在: ${bin}`);
      }
    }
    const ws = process.env.CURSOR_AGENT_WORKSPACE;
    if (ws && String(ws).trim()) {
      const resolved = path.resolve(ws);
      if (!fs.existsSync(resolved)) {
        die(
          `BRIDGE_STRICT_CONFIG=1：CURSOR_AGENT_WORKSPACE 目录不存在: ${resolved}`,
        );
      }
    }
    console.log("[bridge] BRIDGE_STRICT_CONFIG=1：已校验 agent 路径与工作区存在性");
  }

  const host = healthBindHost();
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    console.warn(
      `[bridge] 安全提示：BRIDGE_HEALTH_HOST=${host}，/health 将绑定非本机回环，请确认内网策略`,
    );
  }
}

function healthBindHost() {
  const h = (process.env.BRIDGE_HEALTH_HOST || "127.0.0.1").trim();
  return h || "127.0.0.1";
}

function getAgentMaxQueue() {
  return loadLimits().maxQueue;
}

function getAgentTimeoutMs() {
  return loadLimits().timeoutMs;
}

module.exports = {
  validateSecurityAndLimits,
  getAgentMaxQueue,
  getAgentTimeoutMs,
  healthBindHost,
};

/**
 * 飞书 IM 文本消息：开放平台规定文本类 content 所在请求体约 150KB 上限（含 JSON 序列化/转义）。
 * 桥接侧仅控制经 API 发送时的截断长度；lark-cli 由本机 Agent 调用，限制以飞书文档与 CLI 为准。
 * @see https://open.feishu.cn/document/server-docs/im-v1/message/create
 */

const DEFAULT_TEXT_MAX_CHARS = 3500;
/** 预留 JSON 转义与 content 包装，字符上限保守低于 150KB（UTF-8 多字节） */
const TEXT_MAX_CHARS_CAP = 100000;

let memoChars = null;

function die(msg) {
  console.error("[bridge]", msg);
  process.exit(1);
}

function parseFeishuTextMaxChars() {
  const raw = process.env.BRIDGE_FEISHU_TEXT_MAX_CHARS;
  if (raw === undefined || String(raw).trim() === "") {
    return DEFAULT_TEXT_MAX_CHARS;
  }
  const n = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    die("BRIDGE_FEISHU_TEXT_MAX_CHARS 须为 >=1 的整数");
  }
  if (n > TEXT_MAX_CHARS_CAP) {
    die(
      `BRIDGE_FEISHU_TEXT_MAX_CHARS 超过上限 ${TEXT_MAX_CHARS_CAP}（飞书文本消息请求体约 150KB，需预留 JSON 转义与 content 字段包装）`,
    );
  }
  return n;
}

/** 启动期调用：校验并打印当前配置 */
function validateFeishuMessageLimits() {
  memoChars = parseFeishuTextMaxChars();
  console.log(
    `[bridge] 飞书文本截断上限（桥接 API 发送）: ${memoChars} 字符（BRIDGE_FEISHU_TEXT_MAX_CHARS，默认 ${DEFAULT_TEXT_MAX_CHARS}）`,
  );
}

function getFeishuTextMaxChars() {
  if (memoChars === null) {
    memoChars = parseFeishuTextMaxChars();
  }
  return memoChars;
}

module.exports = {
  validateFeishuMessageLimits,
  getFeishuTextMaxChars,
  DEFAULT_TEXT_MAX_CHARS,
  TEXT_MAX_CHARS_CAP,
};

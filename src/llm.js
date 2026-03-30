/**
 * 调用大模型 API（全自动回飞书，不经过 Cursor IDE）。
 * 支持 OpenAI 兼容接口与 Anthropic Messages API。
 */

const DEFAULT_SYSTEM = `你是通过飞书机器人与用户对话的助手。请用简洁、准确的中文回答；若问题需要在本机执行命令或读取文件，说明用户需在安装了桥接服务的电脑上操作，不要编造执行结果。`;

function getSystemPrompt() {
  return (process.env.AUTO_REPLY_SYSTEM_PROMPT || DEFAULT_SYSTEM).trim();
}

function maxTokens() {
  const n = parseInt(process.env.AUTO_REPLY_MAX_TOKENS || "2048", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 8192) : 2048;
}

async function openaiChat(userText) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("缺少 OPENAI_API_KEY");

  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(
    /\/$/,
    "",
  );
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: parseFloat(process.env.AUTO_REPLY_TEMPERATURE || "0.5"),
      max_tokens: maxTokens(),
      messages: [
        { role: "system", content: getSystemPrompt() },
        { role: "user", content: userText },
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data.error?.message || data.message || res.statusText;
    throw new Error(`OpenAI API ${res.status}: ${errMsg}`);
  }

  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("OpenAI 返回内容为空");
  }
  return text.trim();
}

async function anthropicMessages(userText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("缺少 ANTHROPIC_API_KEY");

  const model =
    process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens(),
      system: getSystemPrompt(),
      messages: [{ role: "user", content: userText }],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data.error?.message || data.message || res.statusText;
    throw new Error(`Anthropic API ${res.status}: ${errMsg}`);
  }

  const blocks = data.content;
  if (!Array.isArray(blocks)) {
    throw new Error("Anthropic 返回格式异常");
  }
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic 返回内容为空");
  return text;
}

/**
 * @param {string} userText
 * @returns {Promise<string>}
 */
async function complete(userText) {
  const provider = (process.env.LLM_PROVIDER || "openai").toLowerCase();
  if (provider === "anthropic") {
    return anthropicMessages(userText);
  }
  if (provider === "openai" || provider === "openai-compatible") {
    return openaiChat(userText);
  }
  throw new Error(`不支持的 LLM_PROVIDER: ${provider}（请用 openai 或 anthropic）`);
}

module.exports = { complete, getSystemPrompt };

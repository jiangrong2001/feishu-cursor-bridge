/**
 * 使用 Cursor 官方 Agent CLI（headless）处理飞书指令，并把执行过程摘要推回飞书。
 * 文档：https://cursor.com/docs/cli/headless
 */

const { spawn } = require("child_process");
const { envTruthy } = require("./envFlags");
const readline = require("readline");
const path = require("path");

const FEISHU_CHUNK_MAX = 3500;

/** @type {Array<{ client: import('@larksuiteoapi/node-sdk').Client; chatId: string; userText: string }>} */
const q = [];
let draining = false;

function truncateFeishu(text) {
  const s = String(text);
  if (s.length <= FEISHU_CHUNK_MAX) return s;
  return `${s.slice(0, FEISHU_CHUNK_MAX - 30)}\n…(截断)`;
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

function workspaceRoot() {
  const w = process.env.CURSOR_AGENT_WORKSPACE;
  if (w && String(w).trim()) return path.resolve(w);
  return path.join(__dirname, "..");
}

function agentBin() {
  return process.env.CURSOR_AGENT_BIN || "agent";
}

function minIntervalMs() {
  return Math.max(
    2000,
    parseInt(process.env.CURSOR_AGENT_FEISHU_MIN_INTERVAL_MS || "5000", 10) || 5000,
  );
}

/** 默认关闭：成功时不在飞书刷屏，只依赖 Agent 执行 lark-cli 发一条简洁答复 */
function streamProgressToFeishu() {
  return envTruthy("CURSOR_AGENT_STREAM_TO_FEISHU");
}

function toolBrief(obj) {
  const tc = obj.tool_call;
  if (!tc || typeof tc !== "object") return null;
  if (tc.readToolCall?.args?.path)
    return `读取 ${tc.readToolCall.args.path}`;
  if (tc.writeToolCall?.args?.path)
    return `写入 ${tc.writeToolCall.args.path}`;
  if (tc.runTerminalCmd?.args?.command)
    return `终端: ${String(tc.runTerminalCmd.args.command).slice(0, 200)}`;
  if (tc.shellToolCall?.args?.command)
    return `终端: ${String(tc.shellToolCall.args.command).slice(0, 200)}`;
  const keys = Object.keys(tc);
  if (keys.length) return `工具: ${keys[0]}`;
  return "工具调用";
}

function extractAssistantDelta(obj) {
  const c = obj.message?.content;
  if (!Array.isArray(c)) return "";
  return c
    .map((b) => (b && b.text ? String(b.text) : ""))
    .join("");
}

/**
 * @param {import('@larksuiteoapi/node-sdk').Client} client
 * @param {string} chatId
 * @param {string} userText
 */
function buildPrompt(chatId, userText) {
  const ws = workspaceRoot();
  return [
    "【飞书远程任务】用户输入：",
    userText.trim(),
    "",
    "【环境与约束】",
    `- 工作区（--workspace）：${ws}`,
    "- 你可使用 Agent 全部能力：读文件、改代码、在终端执行命令（本场景已声明为高权限自动化）。",
    "- inbox/ 下有本次任务的 LATEST.md、LATEST.json（含用户本条原文，以 LATEST.json 的 user_text 为准）。",
    "",
    "【回复飞书（唯一对用户可见的正文）】",
    "用本机 lark-cli **只发一条**纯文本消息到本会话，**text 里只写直接回答用户问题的内容**：",
    "- 不要用标题「【最终总结】」、不要写「我是 Auto」「已通过 lark-cli」等元说明；",
    "- 不要重复多段 Markdown 小节；一句能说清就一句；需要列表时再分行；",
    "- 若用户问的是本机信息（如磁盘空间），用终端命令查准后把结果写进 text。",
    "",
    `命令模板（把引号内整段换成你的答复正文，注意转义 shell 引号）：`,
    `lark-cli im +messages-send --as bot --chat-id "${chatId}" --text "在这里只写答案"`,
    "",
    `chat_id: ${chatId}`,
  ].join("\n");
}

function buildSpawnArgs(prompt) {
  const ws = workspaceRoot();
  const sandbox = process.env.CURSOR_AGENT_SANDBOX || "disabled";
  const args = [
    "-p",
    "--force",
    "--sandbox",
    sandbox,
    "--trust",
    "--approve-mcps",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    ws,
    prompt,
  ];
  if (process.env.CURSOR_AGENT_MODEL) {
    args.splice(args.length - 1, 0, "--model", process.env.CURSOR_AGENT_MODEL);
  }
  return args;
}

async function runCursorAgentJob(job) {
  const { client, chatId, userText } = job;
  const bin = agentBin();
  const prompt = buildPrompt(chatId, userText);
  const args = buildSpawnArgs(prompt);
  const cwd = workspaceRoot();
  const minGap = minIntervalMs();
  const verboseFeishu = streamProgressToFeishu();
  let lastSend = 0;
  let accAssistant = "";

  /** 飞书 API 串行，避免并发 create 乱序 */
  let feishuQ = Promise.resolve();
  const safeSend = (text) => {
    feishuQ = feishuQ
      .then(() => sendText(client, chatId, text))
      .catch((e) => console.error("[cursor-agent] send:", e.message));
    return feishuQ;
  };

  const sendThrottled = (msg, urgent) => {
    if (!verboseFeishu) return feishuQ;
    const now = Date.now();
    if (!urgent && now - lastSend < minGap) return feishuQ;
    lastSend = now;
    return safeSend(msg);
  };

  if (verboseFeishu) {
    await safeSend(
      "🤖 已交由本机 Cursor Agent CLI（headless）处理。接下来会推送工具/进度摘要；最终总结由 Agent 执行 lark-cli 发到本会话。",
    );
  } else {
    console.log(
      "[cursor-agent] 安静模式：成功时由 Agent 通过 lark-cli 单条回复；桥接仅在失败时发飞书。可设 CURSOR_AGENT_STREAM_TO_FEISHU=1 恢复过程推送。",
    );
  }

  try {
    await new Promise((resolve, reject) => {
      console.log(`[cursor-agent] spawn ${bin} cwd=${cwd}`);
      const child = spawn(bin, args, {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderrBuf = "";

      child.stderr?.on("data", (ch) => {
        stderrBuf += ch.toString();
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
      });

      const rl = readline.createInterface({ input: child.stdout });

      rl.on("line", (line) => {
        const s = line.trim();
        if (!s.startsWith("{")) return;
        let obj;
        try {
          obj = JSON.parse(s);
        } catch {
          return;
        }

        const t = obj.type;
        const st = obj.subtype;

        if (verboseFeishu && t === "tool_call" && st === "started") {
          const b =
            toolBrief(obj) ||
            `调用 ${Object.keys(obj.tool_call || {}).join(", ") || "未知工具"}`;
          void sendThrottled(`🔧 ${b}`, true);
        }

        if (verboseFeishu && t === "assistant") {
          const d = extractAssistantDelta(obj);
          if (d) accAssistant += d;
          if (accAssistant.length >= 800) {
            const tail = accAssistant.slice(-600);
            void sendThrottled(`📝 …${tail}`, false);
            accAssistant = "";
          }
        }

        if (verboseFeishu && t === "result") {
          const ms = obj.duration_ms;
          void sendThrottled(
            `✅ Agent 本轮结束（约 ${ms != null ? ms + "ms" : "未知耗时"}）。若未看到最终总结，请检查 Agent 是否已执行 lark-cli。`,
            true,
          );
        }
      });

      child.on("error", (err) => {
        reject(err);
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `agent 退出码 ${code}${stderrBuf ? `: ${stderrBuf.slice(-500)}` : ""}`,
            ),
          );
      });
    });
  } catch (e) {
    console.error("[cursor-agent] failed:", e.message);
    await safeSend(
      `Cursor Agent 执行失败：${e.message}\n\n请安装 CLI：curl https://cursor.com/install -fsS | bash\n确保 PATH 有 agent，并 agent login 或设置 CURSOR_API_KEY。`,
    );
  }

  if (verboseFeishu && accAssistant.trim()) {
    await safeSend(`📄 末尾输出摘要：\n${accAssistant.slice(-FEISHU_CHUNK_MAX)}`);
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (q.length) {
      const job = q.shift();
      if (job) await runCursorAgentJob(job);
    }
  } finally {
    draining = false;
    /** 处理期间若有新任务入队，早退的 drain 不会执行到这里；此处补上第二轮 */
    if (q.length > 0) {
      setImmediate(() => {
        drain().catch((e) => console.error("[cursor-agent] drain:", e.message));
      });
    }
  }
}

function enqueueCursorAgent(p) {
  if (!envTruthy("CURSOR_AGENT_AUTO")) return;
  if (!p.client || !p.chatId || !p.userText || !String(p.userText).trim()) {
    console.warn(
      "[cursor-agent] 未启动 Agent：消息里没有可解析的纯文本（请发文字消息，勿仅图片/卡片）",
    );
    return;
  }
  q.push(p);
  console.log("[cursor-agent] 已入队，即将推飞书并开始", agentBin());
  setImmediate(() => {
    drain().catch((e) => console.error("[cursor-agent] drain:", e.message));
  });
}

function validateCursorAgentConfig() {
  if (!envTruthy("CURSOR_AGENT_AUTO")) return;
  if (!process.env.LARK_APP_ID || !process.env.LARK_APP_SECRET) {
    console.error(
      "[bridge] CURSOR_AGENT_AUTO=1 需要 LARK_APP_ID / LARK_APP_SECRET",
    );
    process.exit(1);
  }
  console.log(
    "[bridge] Cursor Agent CLI 自动模式已开启（sandbox=%s，workspace=%s，飞书过程推送=%s）",
    process.env.CURSOR_AGENT_SANDBOX || "disabled",
    workspaceRoot(),
    envTruthy("CURSOR_AGENT_STREAM_TO_FEISHU") ? "开" : "关（默认安静，仅 lark-cli 答复）",
  );
  if (!process.env.CURSOR_API_KEY) {
    console.log(
      "[bridge] 未设置 CURSOR_API_KEY：若本机已执行 agent login，可忽略；否则请 agent login 或设置 CURSOR_API_KEY（见 cursor.com/docs/cli）",
    );
  }
}

module.exports = { enqueueCursorAgent, validateCursorAgentConfig, workspaceRoot };

/**
 * 使用 Cursor 官方 Agent CLI（headless）处理飞书指令，并把执行过程摘要推回飞书。
 * 文档：https://cursor.com/docs/cli/headless
 */

const { spawn } = require("child_process");
const { envTruthy } = require("./envFlags");
const { getAgentMaxQueue, getAgentTimeoutMs } = require("./securityConfig");
const {
  bridgeDebug,
  createAgentDebugSession,
  getDebugLogDir,
  isDebugLogEnabled,
} = require("./agentDebugLog");
const { getFeishuTextMaxChars } = require("./feishuMessageLimits");
const readline = require("readline");
const path = require("path");

/** @type {Array<{ client: import('@larksuiteoapi/node-sdk').Client; chatId: string; userText: string; messageId?: string; senderOpenId?: string; streamTranscriptToFeishu?: boolean }>} */
const q = [];
let draining = false;
let activeAgentJobs = 0;

/** 记录每个会话最近一次有效任务（去前缀后正文 + 是否开启飞书对话摘录流） */
const lastEffectiveUserTextByChat = new Map();

/** 未显式关闭时默认开启：安静模式下若未检测到 lark-cli 发信，则由桥接补发（避免飞书空白） */
function quietBridgeFallback() {
  const raw = process.env.CURSOR_AGENT_QUIET_BRIDGE_FALLBACK;
  if (raw === undefined || raw === "") return true;
  return envTruthy("CURSOR_AGENT_QUIET_BRIDGE_FALLBACK");
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeUserCmd(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function isRetryCommandText(userText) {
  const t = normalizeUserCmd(userText).toLowerCase();
  if (!t) return false;
  // 覆盖常见中文口语；也兼容英文 retry
  return (
    t === "重试" ||
    t === "再试" ||
    t === "再试一次" ||
    t === "再来一次" ||
    t === "多试几次" ||
    t === "retry" ||
    t === "try again"
  );
}

/**
 * 消息以 /v、/verbos（常见拼写）、/verbose 开头时：去掉前缀，并开启「对话摘录」实时推飞书（格式同 agent-*.chat.txt）。
 */
function parseTranscriptVerbosePrefix(raw) {
  const s = String(raw || "");
  const lead = s.trimStart();
  const re = /^\/(?:v|verbos|verbose)(?:\s+|\s*$)/i;
  const m = lead.match(re);
  if (!m) return { stripped: s.trim(), streamTranscript: false };
  const rest = lead.slice(m[0].length).trim();
  return { stripped: rest, streamTranscript: true };
}

/** 将长文本按飞书单条上限切分，尽量在换行处断开 */
function splitTranscriptForFeishu(text, maxChars) {
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

function transcriptStreamMinIntervalMs() {
  const n = parseInt(process.env.CURSOR_AGENT_TRANSCRIPT_MIN_INTERVAL_MS || "350", 10);
  if (!Number.isFinite(n)) return 350;
  return Math.max(0, Math.min(30_000, n));
}

function getAgentRetryMax() {
  // 默认 2 次重试（总共最多 3 轮），避免飞书里一句话触发长时间占用
  const raw = parseInt(process.env.CURSOR_AGENT_RETRY_MAX || "2", 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(0, Math.min(10, raw));
}

function getAgentRetryBaseDelayMs() {
  const raw = parseInt(process.env.CURSOR_AGENT_RETRY_BASE_DELAY_MS || "1200", 10);
  if (!Number.isFinite(raw)) return 1200;
  return Math.max(200, Math.min(60_000, raw));
}

function computeRetryDelayMs(attemptIdx) {
  const base = getAgentRetryBaseDelayMs();
  // 指数退避 + 少量抖动，attemptIdx 从 1 开始（第 1 次重试）
  const exp = Math.min(6, attemptIdx);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(60_000, base * Math.pow(2, exp - 1) + jitter);
}

function terminalCommandFromToolCall(tc) {
  if (!tc || typeof tc !== "object") return "";
  const shell = tc.shellToolCall?.args?.command;
  const run = tc.runTerminalCmd?.args?.command;
  return String(shell || run || "");
}

/** 是否为本会话发飞书的 lark-cli（排除仅含字样的其它工具） */
function isLarkCliFeishuSendCommand(cmd) {
  const c = String(cmd);
  return /(^|\s)lark-cli\s/i.test(c) && /\+messages-send|messages-send/i.test(c);
}

function getTerminalToolResult(tc) {
  if (!tc || typeof tc !== "object") return null;
  return tc.shellToolCall?.result ?? tc.runTerminalCmd?.result ?? null;
}

/**
 * 仅当流式 JSON 表明 lark-cli 发信 **已完成且成功** 时视为「已对飞书送达」。
 * started 阶段出现 lark-cli 不算；result.failure（含 exitCode 0）不算。
 */
function larkCliFeishuSendSucceeded(obj) {
  if (obj.type !== "tool_call" || obj.subtype !== "completed") return false;
  const tc = obj.tool_call;
  if (!tc || typeof tc !== "object") return false;
  const cmd = terminalCommandFromToolCall(tc);
  if (!isLarkCliFeishuSendCommand(cmd)) return false;
  const r = getTerminalToolResult(tc);
  if (!r || typeof r !== "object") return false;
  if (r.failure) return false;
  const s = r.success;
  if (!s || typeof s !== "object") return false;
  if (s.exitCode !== 0 && s.exitCode != null) return false;
  const out = `${s.stdout || ""}${s.interleavedOutput || ""}${s.stderr || ""}`;
  if (/"ok"\s*:\s*false\b/i.test(out)) return false;
  if (/"ok"\s*:\s*true\b/i.test(out)) return true;
  if (/message_id/i.test(out) && !/"ok"\s*:\s*false/i.test(out)) return true;
  return false;
}

function truncateFeishu(text) {
  const max = getFeishuTextMaxChars();
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 30))}\n…(截断)`;
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

function normalizeWs(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

/**
 * 安静模式桥接补发用：模型未调 lark-cli 时，accAssistant 里常见「复述需求、索要路径」等草稿，
 * 若原样发到飞书，用户会感觉「把我的话又发回来了」。
 */
function isLikelyEchoOfUserBody(body, userText) {
  const u = normalizeWs(userText).toLowerCase();
  const b = normalizeWs(body).toLowerCase();
  if (u.length < 10 || b.length < 10) return false;
  if (b === u) return true;
  if (b.startsWith(u)) return true;
  if (b.includes(u)) {
    const stripped = b.replace(u, " ").replace(/\s+/g, " ").trim();
    if (stripped.length <= Math.max(24, u.length * 0.4)) return true;
  }
  return false;
}

/** 飞书侧短句：不暴露环境变量名，便于非技术用户重试 */
const MSG_FALLBACK_ECHO =
  "本轮在本机已跑完，但没有合适的文字可转发到飞书。请再发一条「重试」，或把需求写得更具体一点。";
const MSG_FALLBACK_NO_BODY =
  "本机 Agent 已结束，但未收到发往飞书的答复。请再发一次，或检查本机 lark-cli 与网络。";
const MSG_DELIVERY_UNCERTAIN =
  "本机已处理完，但飞书可能未收到上一条消息。请再发一条「重试」。";

/**
 * @param {import('@larksuiteoapi/node-sdk').Client} client
 * @param {string} chatId
 * @param {string} userText
 */
function buildPrompt(chatId, userText) {
  const ws = workspaceRoot();
  const feishuTextMax = getFeishuTextMaxChars();
  return [
    "【飞书远程任务】用户输入：",
    userText.trim(),
    "",
    "【环境与约束】",
    `- 工作区（--workspace）：${ws}`,
    `- 飞书单条文本消息受开放平台限制（请求体约 150KB）；本桥接 API 补发截断为 ${feishuTextMax} 字符（.env：BRIDGE_FEISHU_TEXT_MAX_CHARS）。你用 lark-cli 发送时亦勿超过飞书限制，过长应拆多条或发文件。`,
    "- 你可使用 Agent 全部能力：读文件、改代码、在终端执行命令（本场景已声明为高权限自动化）。",
    "- 若需克隆 Git 仓库：默认使用**完整克隆**（`git clone <url>`，勿用 `--depth` 浅克隆），以便拉取完整历史与内容；若工作区已是浅克隆且需要完整历史，可 `git fetch --unshallow` 或删目录后重新完整克隆。",
    "- inbox/ 下有本次任务的 LATEST.md、LATEST.json（含用户本条原文，以 LATEST.json 的 user_text 为准）。",
    "",
    "【图片与文件（默认附件，禁止用纯文本糊弄）】",
    "- 用户若要**发图片/截图/文件**到飞书：默认必须走 **lark-cli 附件上传**（例如 `+messages-send` 的 `--image`、或当前版本支持的文件/图片参数），把**本机实际文件**发到本会话。",
    "- **禁止**仅回复一条纯文字说「稍后发你」「请查链接」或粘贴 URL/路径代替实际上传；也**不要**再问用户「要以附件还是文字发」——能推断路径或能生成文件就直接上传。",
    "- 需要现成图时：在本机生成/保存到可读路径（如截图命令、导出文件），再对该路径调用 lark-cli 附件发送；工作区内已有文件则直接用其路径。",
    "- 若同时需要简短说明：在附件消息允许的前提下附带极短 `--text`，仍以附件为主。",
    "",
    "【回复飞书（唯一对用户可见的正文）】",
    "若**未**涉及上节「图片与文件」：用 lark-cli **只发一条**纯文本到本会话，**text 里只写直接回答**（见下）。若**需要发图/文件**：以附件消息为主（可带极短 text），不要改成「只发一条纯文字」敷衍。",
    "纯文本答复时 **text** 的写法：",
    "- 不要用标题「【最终总结】」、不要写「我是 Auto」「已通过 lark-cli」等元说明；",
    "- 不要重复多段 Markdown 小节；一句能说清就一句；需要列表时再分行；",
    "- **禁止**在发回飞书的 text 里大段复述用户原话或把「用户让你做的事」当答案发回；能执行则直接执行并汇报结果。",
    "- 不要为已写在用户消息里的信息再次索要（除非确实无法从工作区/命令推断）；缺一项关键信息时只问最短一句。",
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
  const {
    client,
    chatId,
    userText,
    messageId,
    senderOpenId,
    streamTranscriptToFeishu = false,
  } = job;
  activeAgentJobs++;
  if (activeAgentJobs > 1) {
    console.error(
      "[cursor-agent] 警告：检测到并发 Agent 任务（不应出现），active=%s",
      activeAgentJobs,
    );
  }

  let debug = null;
  try {
  console.log(
    `[cursor-agent] job start message_id=${messageId || "—"} len=${String(userText).length}`,
  );

  let lastTranscriptSend = 0;
  const feishuTextCap = getFeishuTextMaxChars();
  /** 飞书 API 串行；须早于 createAgentDebugSession，供 onChatBlock 入队 */
  let feishuQ = Promise.resolve();
  if (streamTranscriptToFeishu) {
    feishuQ = feishuQ.then(async () => {
      try {
        await sendText(
          client,
          chatId,
          "📜 对话摘录实时推送中（格式与 agent-*.chat.txt 相同，按段到达）…",
        );
      } catch (e) {
        console.error("[cursor-agent] 摘录开场提示发送失败:", e.message);
      }
      lastTranscriptSend = Date.now();
    });
  }

  debug = createAgentDebugSession({
    messageId,
    chatId,
    userText,
    senderOpenId,
    onChatBlock: streamTranscriptToFeishu
      ? (piece) => {
          const parts = splitTranscriptForFeishu(piece, feishuTextCap);
          for (const part of parts) {
            feishuQ = feishuQ.then(async () => {
              const gap = transcriptStreamMinIntervalMs();
              if (gap > 0) {
                const wait = Math.max(0, gap - (Date.now() - lastTranscriptSend));
                if (wait > 0) await sleepMs(wait);
              }
              try {
                await sendText(client, chatId, part);
              } catch (e) {
                console.error("[cursor-agent] 对话摘录推飞书失败:", e.message);
              }
              lastTranscriptSend = Date.now();
            });
          }
        }
      : undefined,
  });
  if (debug) {
    if (debug.filePath) {
      console.log("[cursor-agent] 调试日志:", debug.filePath);
    }
    if (debug.chatFilePath) {
      console.log("[cursor-agent] 对话摘录文件:", debug.chatFilePath);
    }
    if (streamTranscriptToFeishu) {
      console.log("[cursor-agent] 飞书实时对话摘录: 已开启（/v、/verbos、/verbose）");
    }
    debug.logJob(
      "job_start",
      `verboseFeishu=${streamProgressToFeishu()} streamTranscript=${streamTranscriptToFeishu}`,
    );
  }

  const bin = agentBin();
  const prompt = buildPrompt(chatId, userText);
  const args = buildSpawnArgs(prompt);
  const cwd = workspaceRoot();
  debug?.logFullPrompt(prompt);
  const minGap = minIntervalMs();
  const verboseFeishu = streamProgressToFeishu();
  const effectiveVerboseFeishu = verboseFeishu && !streamTranscriptToFeishu;
  let lastSend = 0;
  let accAssistant = "";
  /** lark-cli im +messages-send 在流里 **completed 且 success**（非 failure） */
  let larkCliFeishuOk = false;
  let agentExitedOk = false;
  /** 经桥接 API 成功送达飞书（lark-cli 发信不计入；用于兜底空白） */
  let bridgeFeishuDelivered = false;

  const safeSend = (text) => {
    feishuQ = feishuQ.then(async () => {
      try {
        await sendText(client, chatId, text);
        bridgeFeishuDelivered = true;
      } catch (e) {
        console.error("[cursor-agent] send:", e.message);
      }
    });
    return feishuQ;
  };

  const sendThrottled = (msg, urgent) => {
    if (!effectiveVerboseFeishu) return feishuQ;
    const now = Date.now();
    if (!urgent && now - lastSend < minGap) return feishuQ;
    lastSend = now;
    return safeSend(msg);
  };

  if (effectiveVerboseFeishu) {
    await safeSend(
      "🤖 本机处理中，下方为进度摘要；结论一般由 lark-cli 发到本会话。",
    );
  } else {
    console.log(
      "[cursor-agent] 安静模式：优先 lark-cli；未检测到发信时桥接可补发（CURSOR_AGENT_QUIET_BRIDGE_FALLBACK=0 可关）。",
    );
  }

  const spawnOnce = async () => {
    const timeoutMs = getAgentTimeoutMs();
    await new Promise((resolve, reject) => {
      console.log(`[cursor-agent] spawn ${bin} cwd=${cwd}`);
      debug?.logSpawn(bin, cwd, args);
      const child = spawn(bin, args, {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderrBuf = "";
      let killTimer = null;
      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          console.error(`[cursor-agent] 超时 ${timeoutMs}ms，终止 agent`);
          debug?.logJob("timeout_sigterm", `${timeoutMs}ms`);
          try {
            child.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }, 8000);
        }, timeoutMs);
      }

      child.stderr?.on("data", (ch) => {
        const piece = ch.toString();
        stderrBuf += piece;
        if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
        debug?.logStderrChunk(piece);
      });

      const rl = readline.createInterface({ input: child.stdout });

      rl.on("line", (line) => {
        debug?.logStdoutLine(line);
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

        if (t === "tool_call" && larkCliFeishuSendSucceeded(obj)) {
          larkCliFeishuOk = true;
        }

        if (effectiveVerboseFeishu && t === "tool_call" && st === "started") {
          const b =
            toolBrief(obj) ||
            `调用 ${Object.keys(obj.tool_call || {}).join(", ") || "未知工具"}`;
          void sendThrottled(`🔧 ${b}`, true);
        }

        if (t === "assistant") {
          const d = extractAssistantDelta(obj);
          if (d) accAssistant += d;
          if (effectiveVerboseFeishu && accAssistant.length >= 800) {
            const tail = accAssistant.slice(-600);
            void sendThrottled(`📝 …${tail}`, false);
            accAssistant = "";
          }
        }

        if (effectiveVerboseFeishu && t === "result") {
          const ms = obj.duration_ms;
          void sendThrottled(
            `✅ 本轮结束${ms != null ? `（约 ${ms}ms）` : ""}。`,
            true,
          );
        }
      });

      child.on("error", (err) => {
        if (killTimer) clearTimeout(killTimer);
        debug?.logJob("spawn_error", err.message);
        reject(err);
      });

      child.on("close", (code) => {
        if (killTimer) clearTimeout(killTimer);
        debug?.logJob("agent_child_close", `exit_code=${code}`);
        try {
          rl.close();
        } catch {
          /* ignore */
        }
        if (code === 0) {
          agentExitedOk = true;
          resolve();
        } else {
          reject(
            new Error(
              `agent 退出码 ${code}${stderrBuf ? `: ${stderrBuf.slice(-500)}` : ""}`,
            ),
          );
        }
      });
    });
  };

  let lastAgentError = null;
  const maxRetry = getAgentRetryMax();
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      if (attempt > 0) {
        const d = computeRetryDelayMs(attempt);
        console.warn(
          `[cursor-agent] 将重试第 ${attempt}/${maxRetry} 次，等待 ${d}ms（上次错误：${lastAgentError?.message || "unknown"}）`,
        );
        debug?.logJob(
          "agent_retry_wait",
          `attempt=${attempt} wait_ms=${d} last=${lastAgentError?.message || ""}`,
        );
        await sleepMs(d);
      }
      await spawnOnce();
      lastAgentError = null;
      break;
    } catch (e) {
      lastAgentError = e;
      agentExitedOk = false;
      debug?.logJob("agent_error", e.message);
      if (attempt >= maxRetry) {
        console.error("[cursor-agent] failed:", e.message);
        await safeSend(
          `Agent 执行失败：${e.message}\n请在本机终端执行 agent login，并确认已安装 CLI（见 cursor.com/docs/cli）。`,
        );
      }
    }
  }

  const feishuReplyDelivered = () =>
    bridgeFeishuDelivered || larkCliFeishuOk;

  if (
    agentExitedOk &&
    !verboseFeishu &&
    quietBridgeFallback() &&
    !feishuReplyDelivered()
  ) {
    const body = accAssistant.trim();
    // 不再根据正文「像 lark 输出」跳过补发：易误判为已发信导致飞书空白
    if (body.length > 20) {
      if (isLikelyEchoOfUserBody(body, userText)) {
        console.warn(
          "[cursor-agent] 桥接补发已抑制：模型正文疑似复述用户输入（避免把需求误发回飞书）",
        );
        await safeSend(MSG_FALLBACK_ECHO);
      } else {
        console.warn(
          "[cursor-agent] 未确认 lark-cli 已成功发到飞书，由桥接 API 补发答复",
        );
        await safeSend(body.slice(-getFeishuTextMaxChars()));
      }
    } else {
      await safeSend(MSG_FALLBACK_NO_BODY);
    }
  }

  if (effectiveVerboseFeishu && accAssistant.trim() && !larkCliFeishuOk) {
    const tail = accAssistant.slice(-getFeishuTextMaxChars());
    if (isLikelyEchoOfUserBody(accAssistant, userText)) {
      console.warn(
        "[cursor-agent] 过程推送末尾摘要已抑制：全文疑似复述用户输入",
      );
      await safeSend(
        "未展示模型末尾摘要（与问题重复）。若上面没有答复，请发「重试」。",
      );
    } else {
      await safeSend(`📄 末尾摘要：\n${tail}`);
    }
  }

  await feishuQ;
  if (agentExitedOk && !feishuReplyDelivered()) {
    console.warn(
      "[cursor-agent] 未确认飞书已收到回复（lark-cli 成功或桥接 API 均未命中），发送兜底提示",
    );
    await safeSend(MSG_DELIVERY_UNCERTAIN);
    await feishuQ;
  }

  debug?.logJobSummary({
    agentExitedOk,
    larkCliFeishuOk,
    bridgeFeishuDelivered,
    feishuReplyDelivered: feishuReplyDelivered(),
    accAssistantChars: accAssistant.length,
    quietFallbackPath:
      agentExitedOk &&
      !verboseFeishu &&
      quietBridgeFallback() &&
      !feishuReplyDelivered(),
    verboseFeishu,
    streamTranscriptToFeishu,
  });
  } finally {
    debug?.finishChatTranscript?.();
    activeAgentJobs--;
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

async function notifyQueueFull(client, chatId, max) {
  if (!client || !chatId) return;
  const text = `当前处理队列已满（最多 ${max} 条待处理），请稍后再发。`;
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({
          text: text.slice(0, getFeishuTextMaxChars()),
        }),
      },
    });
  } catch (e) {
    console.error("[cursor-agent] 队列满通知飞书失败:", e.message);
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

  const rawText = String(p.userText);
  const isRetry = isRetryCommandText(rawText);
  if (isRetry) {
    const prev = lastEffectiveUserTextByChat.get(p.chatId);
    if (prev && typeof prev === "object" && String(prev.text || "").trim()) {
      console.log("[cursor-agent] 收到重试指令，复用上一条有效任务文本");
      p.userText = String(prev.text);
      p.streamTranscriptToFeishu = !!prev.streamTranscript;
    } else if (prev && String(prev).trim()) {
      console.log("[cursor-agent] 收到重试指令，复用上一条有效任务文本");
      p.userText = String(prev);
      p.streamTranscriptToFeishu = false;
    } else {
      console.log("[cursor-agent] 收到重试指令，但未找到可复用的上一条任务");
    }
  } else {
    const { stripped, streamTranscript } = parseTranscriptVerbosePrefix(rawText);
    p.userText = stripped;
    p.streamTranscriptToFeishu = streamTranscript;
    lastEffectiveUserTextByChat.set(p.chatId, {
      text: stripped,
      streamTranscript,
    });
  }

  const maxQ = getAgentMaxQueue();
  if (maxQ > 0 && q.length >= maxQ) {
    console.warn(`[cursor-agent] 队列已满 (${maxQ})，拒绝入队`);
    void notifyQueueFull(p.client, p.chatId, maxQ);
    return;
  }
  q.push(p);
  console.log("[cursor-agent] 已入队，即将推飞书并开始", agentBin());
  if (isDebugLogEnabled()) {
    bridgeDebug(
      `enqueue message_id=${p.messageId || ""} depth=${q.length} chat_id=${p.chatId || ""}`,
    );
  }
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
  if (isDebugLogEnabled()) {
    console.log(
      "[bridge] BRIDGE_DEBUG_LOG=1：桥接流水见",
      path.join(getDebugLogDir(), "bridge.log"),
      "；每轮 Agent 见同目录下 agent-*.log",
    );
  }
}

module.exports = { enqueueCursorAgent, validateCursorAgentConfig, workspaceRoot };

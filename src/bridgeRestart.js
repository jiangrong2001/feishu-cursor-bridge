/**
 * 飞书 /restart：重启桥接 Node 进程；可选参数为新的 CURSOR_AGENT_WORKSPACE（持久化到 .bridge-workspace-override）。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { getFeishuTextMaxChars } = require("./feishuMessageLimits");
const { bridgeDebug } = require("./agentDebugLog");
const { releaseBridgeSingletonLock } = require("./bridgeSingletonLock");

/** 与 queue.normalizeFeishuUserText 规则一致；不 require queue，避免与 runner 等形成加载次序问题 */
const FEISHU_SPACE_CHARS =
  /[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b]/g;

const FEISHU_INVISIBLE_CMD_BREAKERS =
  /[\u200c\u200d\u200e\u200f\u2060\u2066-\u2069]/g;

function feishuNormalizeForRestartCmd(raw) {
  let t = String(raw || "")
    .normalize("NFKC")
    .replace(/\uFF0F/g, "/")
    .replace(FEISHU_INVISIBLE_CMD_BREAKERS, "")
    .replace(FEISHU_SPACE_CHARS, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(
    /^(\/(?:v|verbos|verbose))(\/restart\b)/i,
    (_, a, b) => `${a} ${b}`,
  );
  return t.trim();
}

function bridgePackageRoot() {
  return path.join(__dirname, "..");
}

function workspaceOverrideFilePath() {
  return path.join(bridgePackageRoot(), ".bridge-workspace-override");
}

function restartPendingNotifyFilePath() {
  return path.join(bridgePackageRoot(), ".bridge-restart-pending.json");
}

function expandUserHomePath(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

/**
 * 在 dotenv 之后调用：若存在覆盖文件且指向有效目录，则写入 process.env.CURSOR_AGENT_WORKSPACE。
 */
function applyWorkspaceOverrideFromDisk() {
  const fp = workspaceOverrideFilePath();
  if (!fs.existsSync(fp)) return;
  let line;
  try {
    line = fs.readFileSync(fp, "utf8").split(/\r?\n/)[0];
  } catch {
    return;
  }
  const dir = String(line || "").trim();
  if (!dir) return;
  const abs = path.resolve(expandUserHomePath(dir));
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      console.warn(
        "[bridge] 忽略无效的工作区覆盖文件（路径不存在或非目录）:",
        abs,
      );
      return;
    }
  } catch (e) {
    console.warn("[bridge] 校验工作区覆盖路径失败:", e.message);
    return;
  }
  process.env.CURSOR_AGENT_WORKSPACE = abs;
  console.log("[bridge] 已从 .bridge-workspace-override 应用工作区:", abs);
}

/** 默认允许飞书 /restart；设为 0/false/off/no 则关闭 */
function restartViaFeishuEnabled() {
  const v = String(process.env.BRIDGE_RESTART_VIA_FEISHU ?? "")
    .trim()
    .toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

/**
 * 飞书整段文本：规范化后循环去掉 /v、/verbos、/verbose，再识别 /restart（与 index 里「先剥 v 再 parse」双处逻辑合一，避免不一致导致误判给 Agent）。
 * @returns {null | { rest: string, streamTranscript: boolean }}
 */
function parseRestartFeishuLine(text) {
  let t = feishuNormalizeForRestartCmd(String(text || "")).trim();
  let streamTranscript = false;
  const reV = /^\/(?:v|verbos|verbose)(?:\s+|\s*$)/i;
  for (let i = 0; i < 4; i++) {
    const lead = t.trimStart();
    const vm = lead.match(reV);
    if (!vm) break;
    streamTranscript = true;
    t = feishuNormalizeForRestartCmd(lead.slice(vm[0].length)).trim();
  }
  let m = t.match(/^\s*\/restart\b(.*)$/is);
  if (!m) {
    const rel = t.search(/\/restart\b/i);
    if (rel < 0) return null;
    const head = t.slice(0, rel);
    let h = head.trim();
    for (let j = 0; j < 4 && h.length; j++) {
      const vm = h.match(reV);
      if (!vm) break;
      streamTranscript = true;
      h = h.slice(vm[0].length).trimStart();
    }
    if (h !== "") return null;
    const tail = t.slice(rel).trimStart();
    m = tail.match(/^\/restart\b(.*)$/is);
    if (!m) return null;
  }
  return {
    rest: String(m[1] || "").trim(),
    streamTranscript,
  };
}

/**
 * @param {string} text
 * @returns {null | { rest: string }}
 */
function parseRestartCommand(text) {
  const pr = parseRestartFeishuLine(text);
  if (!pr) return null;
  return { rest: pr.rest };
}

function resolveWorkspaceCandidate(rest) {
  if (!rest) return null;
  const expanded = expandUserHomePath(rest);
  return path.resolve(expanded);
}

function saveWorkspaceOverride(absDir) {
  fs.writeFileSync(workspaceOverrideFilePath(), `${absDir}\n`, "utf8");
}

function truncateFeishuApiText(text) {
  const max = getFeishuTextMaxChars();
  const s = String(text);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 24))}\n…(截断)`;
}

/** 与 cursorAgentRunner 中 /v 摘录间隔一致，便于组合「/v /restart」时节奏统一 */
function transcriptStreamMinIntervalMs() {
  const n = parseInt(
    process.env.CURSOR_AGENT_TRANSCRIPT_MIN_INTERVAL_MS || "350",
    10,
  );
  if (!Number.isFinite(n)) return 350;
  return Math.max(0, Math.min(30_000, n));
}

async function sleepTranscriptGap(stream) {
  if (!stream) return;
  const ms = transcriptStreamMinIntervalMs();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

async function sendBridgeText(client, chatId, text) {
  if (!client || !chatId || !text) return;
  await client.im.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text: truncateFeishuApiText(text) }),
    },
  });
}

/**
 * 子进程启动后会读取此文件并向 chat_id 发送「重启成功」飞书消息。
 * @param {string} reason
 * @param {string} chatId
 */
function writeRestartPendingNotify(chatId, reason) {
  if (!chatId) return;
  try {
    const payload = {
      chat_id: chatId,
      at: new Date().toISOString(),
      reason: String(reason || ""),
    };
    fs.writeFileSync(
      restartPendingNotifyFilePath(),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
    bridgeDebug(
      `restart pending_notify written chat_id=${chatId} reason=${reason}`,
    );
  } catch (e) {
    console.error("[bridge] 写入 restart 待通知文件失败:", e.message);
    bridgeDebug(`restart pending_notify write_fail ${e.message}`);
  }
}

function scheduleBridgeProcessRestart(reason, chatId) {
  console.log("[bridge] 即将重启进程:", reason);
  writeRestartPendingNotify(chatId, reason);
  const bridgeRoot = bridgePackageRoot();
  setTimeout(() => {
    releaseBridgeSingletonLock();
    try {
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: bridgeRoot,
        detached: true,
        stdio: "inherit",
        env: { ...process.env },
      });
      child.unref();
      bridgeDebug("restart child spawned, parent will exit");
    } catch (e) {
      console.error("[bridge] 拉起新进程失败:", e.message);
      bridgeDebug(`restart spawn_fail ${e.message}`);
      try {
        fs.unlinkSync(restartPendingNotifyFilePath());
      } catch {
        /* ignore */
      }
      return;
    }
    setTimeout(() => process.exit(0), 500);
  }, 250);
}

/**
 * 新进程 WebSocket 就绪后：若存在待通知文件，向飞书发「重启成功 + 工作区」，再发控制命令说明。
 * @param {import('@larksuiteoapi/node-sdk').Client | null} client
 * @returns {Promise<boolean>} 是否消费了 restart 待通知（为 true 时冷启动不再重复推控制命令专题）
 */
async function notifyFeishuAfterRestartIfPending(client) {
  const fp = restartPendingNotifyFilePath();
  if (!fs.existsSync(fp)) return false;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (e) {
    bridgeDebug(`restart notify parse_fail ${e.message}`);
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
    return false;
  }
  const chatId = payload && payload.chat_id;
  if (!client || !chatId) {
    bridgeDebug("restart notify skip (no client or chat_id)");
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
    return false;
  }
  const { workspaceRoot } = require("./cursorAgentRunner");
  const ws = workspaceRoot();
  const body =
    `桥接服务已重启成功。\n当前 Cursor Agent 工作目录：\n${ws}`;
  try {
    await sendBridgeText(client, chatId, body);
    bridgeDebug(`restart notify sent ok chat_id=${chatId} workspace=${ws}`);
  } catch (e) {
    console.error("[bridge] 重启成功飞书通知失败:", e.message);
    bridgeDebug(`restart notify send_fail ${e.message}`);
  }
  try {
    const { sendControlCommandsHelpToFeishu } = require("./bridgeControlCommands");
    await sendControlCommandsHelpToFeishu(client, chatId);
    bridgeDebug("restart notify control_help sent");
  } catch (e) {
    console.error("[bridge] 重启后控制命令说明发送失败:", e.message);
    bridgeDebug(`restart notify control_help_fail ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
  }
  return true;
}

/**
 * @param {string} userText 已 trim；可由调用方先去掉 /v 等摘录前缀后再传入
 * @param {{ streamTranscriptToFeishu?: boolean }} [options] 为 true 时按段推送桥接执行步骤（与 /v 摘录节奏一致，仍不启动 Cursor Agent）
 * @returns {Promise<boolean>} 是否已处理（为 true 时不应再入队 Agent）
 */
async function maybeHandleBridgeRestartFromFeishu(
  client,
  chatId,
  userText,
  options = {},
) {
  const pr = parseRestartFeishuLine(userText);
  if (!pr) {
    const s = String(userText || "").trim();
    if (
      s.length > 0 &&
      s.length < 600 &&
      !/[\r\n]/.test(s) &&
      /\/restart\b/i.test(s)
    ) {
      console.warn(
        "[bridge] 含 /restart 但未解析为桥接命令（将交给 Agent）。本进程代码目录:",
        path.resolve(__dirname, ".."),
      );
    }
    return false;
  }

  const stream =
    options.streamTranscriptToFeishu !== undefined
      ? !!options.streamTranscriptToFeishu
      : pr.streamTranscript;

  const tell = async (text) => {
    if (!client || !chatId || !text) return;
    try {
      await sendBridgeText(client, chatId, text);
    } catch (e) {
      console.error("[bridge] 飞书通知失败:", e.message);
    }
    await sleepTranscriptGap(stream);
  };

  bridgeDebug(
    `restart command received chat_id=${chatId || ""} has_path=${!!pr.rest} stream=${stream}`,
  );

  if (stream) {
    await tell(
      [
        "📜 **/restart** 过程摘录（飞书桥接 **Node** 执行，**非** Cursor headless Agent）",
        "▸ 已识别为桥接控制命令：可改工作区并重启本桥接进程。",
      ].join("\n"),
    );
  }

  if (!restartViaFeishuEnabled()) {
    bridgeDebug("restart rejected (BRIDGE_RESTART_VIA_FEISHU off)");
    await tell(
      "已关闭飞书远程重启。若要开启，请从 .env 中去掉 BRIDGE_RESTART_VIA_FEISHU=0（或 false/off/no）。",
    );
    return true;
  }

  const { rest } = pr;
  if (rest) {
    const candidate = resolveWorkspaceCandidate(rest);
    if (stream) {
      await tell(`▸ 参数目录（原文）：${rest}`);
      await tell(`▸ 解析绝对路径：\n${candidate}`);
    }
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      bridgeDebug(`restart abort path_missing rest=${rest.slice(0, 80)}`);
      if (stream) {
        await tell(
          `▸ 校验路径：失败（不存在或不可访问），**未重启**。`,
        );
      } else {
        await tell(
          `无法将工作区设为「${rest}」：路径不存在或不可访问。未重启。`,
        );
      }
      return true;
    }
    if (!stat.isDirectory()) {
      bridgeDebug(`restart abort not_a_directory rest=${rest.slice(0, 80)}`);
      if (stream) {
        await tell(`▸ 校验路径：「${rest}」不是目录，**未重启**。`);
      } else {
        await tell(`「${rest}」不是目录。未重启。`);
      }
      return true;
    }
    if (stream) {
      await tell("▸ 校验：路径存在且为目录 ✓");
      await tell(
        `▸ 写入 .bridge-workspace-override（一行）：\n${candidate}`,
      );
    }
    saveWorkspaceOverride(candidate);
    process.env.CURSOR_AGENT_WORKSPACE = candidate;
    bridgeDebug(`restart workspace_saved path=${candidate}`);
    if (stream) {
      await tell("▸ 已同步本进程环境变量 CURSOR_AGENT_WORKSPACE");
      await tell(
        "▸ 即将 fork 新 Node 子进程并退出当前进程（需 pm2 / 终端循环 / launchd 等托管自动拉起）",
      );
    } else {
      await tell(`已保存工作区为:\n${candidate}\n约 1 秒内重启桥接…`);
    }
    scheduleBridgeProcessRestart(`工作区已更新为 ${candidate}`, chatId);
    return true;
  }

  bridgeDebug("restart no_path scheduling");
  if (stream) {
    await tell(
      "▸ 未带路径：工作区沿用当前配置（含 .bridge-workspace-override 若已存在）",
    );
    await tell(
      "▸ 即将 fork 新 Node 子进程并退出当前进程（需进程托管自动拉起）",
    );
  } else {
    await tell(
      "收到 /restart，约 1 秒内重启桥接（工作区沿用当前配置，含 .bridge-workspace-override 若存在）…",
    );
  }
  scheduleBridgeProcessRestart("飞书 /restart（未改工作区）", chatId);
  return true;
}

module.exports = {
  applyWorkspaceOverrideFromDisk,
  maybeHandleBridgeRestartFromFeishu,
  notifyFeishuAfterRestartIfPending,
  parseRestartCommand,
  parseRestartFeishuLine,
  restartViaFeishuEnabled,
  workspaceOverrideFilePath,
};

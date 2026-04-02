/**
 * 飞书 /restart：重启桥接 Node 进程；可选参数为新的 CURSOR_AGENT_WORKSPACE（持久化到 .bridge-workspace-override）。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { getFeishuTextMaxChars } = require("./feishuMessageLimits");
const { bridgeDebug } = require("./agentDebugLog");

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
 * @param {string} text
 * @returns {null | { rest: string }}
 */
function parseRestartCommand(text) {
  const t = String(text || "").trim();
  const m = t.match(/^\s*\/restart\b(.*)$/is);
  if (!m) return null;
  return { rest: String(m[1] || "").trim() };
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
 * @returns {Promise<boolean>} 是否已处理（为 true 时不应再入队 Agent）
 */
async function maybeHandleBridgeRestartFromFeishu(client, chatId, userText) {
  const parsed = parseRestartCommand(userText);
  if (!parsed) return false;

  bridgeDebug(
    `restart command received chat_id=${chatId || ""} has_path=${!!parsed.rest}`,
  );

  if (!restartViaFeishuEnabled()) {
    bridgeDebug("restart rejected (BRIDGE_RESTART_VIA_FEISHU off)");
    try {
      await sendBridgeText(
        client,
        chatId,
        "已关闭飞书远程重启。若要开启，请从 .env 中去掉 BRIDGE_RESTART_VIA_FEISHU=0（或 false/off/no）。",
      );
    } catch (e) {
      console.error("[bridge] 发送重启禁用说明失败:", e.message);
    }
    return true;
  }

  const { rest } = parsed;
  if (rest) {
    const candidate = resolveWorkspaceCandidate(rest);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      bridgeDebug(`restart abort path_missing rest=${rest.slice(0, 80)}`);
      try {
        await sendBridgeText(
          client,
          chatId,
          `无法将工作区设为「${rest}」：路径不存在或不可访问。未重启。`,
        );
      } catch (e) {
        console.error("[bridge] 发送工作区错误说明失败:", e.message);
      }
      return true;
    }
    if (!stat.isDirectory()) {
      bridgeDebug(`restart abort not_a_directory rest=${rest.slice(0, 80)}`);
      try {
        await sendBridgeText(
          client,
          chatId,
          `「${rest}」不是目录。未重启。`,
        );
      } catch (e) {
        console.error("[bridge] 发送工作区错误说明失败:", e.message);
      }
      return true;
    }
    saveWorkspaceOverride(candidate);
    process.env.CURSOR_AGENT_WORKSPACE = candidate;
    bridgeDebug(`restart workspace_saved path=${candidate}`);
    try {
      await sendBridgeText(
        client,
        chatId,
        `已保存工作区为:\n${candidate}\n约 1 秒内重启桥接…`,
      );
    } catch (e) {
      console.error("[bridge] 重启前通知飞书失败:", e.message);
    }
    scheduleBridgeProcessRestart(`工作区已更新为 ${candidate}`, chatId);
    return true;
  }

  bridgeDebug("restart no_path scheduling");
  try {
    await sendBridgeText(
      client,
      chatId,
      "收到 /restart，约 1 秒内重启桥接（工作区沿用当前配置，含 .bridge-workspace-override 若存在）…",
    );
  } catch (e) {
    console.error("[bridge] 重启前通知飞书失败:", e.message);
  }
  scheduleBridgeProcessRestart("飞书 /restart（未改工作区）", chatId);
  return true;
}

module.exports = {
  applyWorkspaceOverrideFromDisk,
  maybeHandleBridgeRestartFromFeishu,
  notifyFeishuAfterRestartIfPending,
  parseRestartCommand,
  restartViaFeishuEnabled,
  workspaceOverrideFilePath,
};

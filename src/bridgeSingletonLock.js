/**
 * 防止同一台机器上对同一飞书应用跑多个桥接 Node：多实例会同时连 WSS，消息随机落到某一进程，
 * /restart 只更新其中一台的工作区，另一台仍用旧 CURSOR_AGENT_WORKSPACE（表现为「已通知 QTrading，Agent 却在 QTrading_debug」）。
 */

const fs = require("fs");
const path = require("path");

function lockFilePath() {
  return path.join(__dirname, "..", ".bridge-process.lock");
}

function singletonLockEnabled() {
  const v = String(process.env.BRIDGE_SINGLETON_LOCK ?? "1")
    .trim()
    .toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

/**
 * 启动时调用：若已有存活进程持有锁则退出。
 */
function acquireBridgeSingletonLock() {
  if (!singletonLockEnabled()) {
    console.log(
      "[bridge] BRIDGE_SINGLETON_LOCK 已关闭：允许多实例（飞书可能对多连接重复投递；/restart 仅影响持有锁的进程）",
    );
    return;
  }
  const fp = lockFilePath();
  const writeMine = () => {
    fs.writeFileSync(fp, `${process.pid}\n`, { flag: "wx" });
  };
  try {
    writeMine();
  } catch (e) {
    if (e.code !== "EEXIST") {
      console.warn("[bridge] 单例锁创建失败:", e.message);
      return;
    }
    let oldPid = NaN;
    try {
      oldPid = parseInt(fs.readFileSync(fp, "utf8").trim(), 10);
    } catch {
      /* ignore */
    }
    if (Number.isFinite(oldPid) && oldPid > 0) {
      try {
        process.kill(oldPid, 0);
        console.error(
          `[bridge] 检测到已有桥接进程 (PID ${oldPid})，请勿重复启动第二实例。` +
            `多实例会导致飞书消息落到不同进程、工作区与 /restart 不一致。` +
            `请先结束旧进程，或仅在开发环境设置 BRIDGE_SINGLETON_LOCK=0。`,
        );
        process.exit(1);
      } catch {
        /* stale lock */
      }
    }
    try {
      fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
    try {
      writeMine();
    } catch (e2) {
      console.warn("[bridge] 单例锁重试失败:", e2.message);
    }
  }

  const cleanup = () => {
    try {
      if (!fs.existsSync(fp)) return;
      const cur = fs.readFileSync(fp, "utf8").trim();
      if (cur === String(process.pid)) fs.unlinkSync(fp);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

/**
 * fork 子进程接替前释放锁，避免子进程启动时误判「旧进程仍占用」。
 */
function releaseBridgeSingletonLock() {
  if (!singletonLockEnabled()) return;
  try {
    fs.unlinkSync(lockFilePath());
  } catch {
    /* ignore */
  }
}

module.exports = {
  acquireBridgeSingletonLock,
  releaseBridgeSingletonLock,
};

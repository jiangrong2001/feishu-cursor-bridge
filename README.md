# Feishu ↔ Cursor Bridge

**中文版：[README.zh.md](./README.zh.md)**

**For other Cursor agents:** After cloning, the project skill lives at **`.cursor/skills/feishu-cursor-bridge/`**. Read this **README.md** (or **README.zh.md**) end-to-end for full setup; **SKILL.md** is a short checklist. If no skill is loaded, this README alone is enough to install and run.

Run a small **Node** service on your machine: receive Feishu messages over a **WebSocket long connection**—**no public URL** required. For each message, the bridge **spawns the official Cursor Agent CLI** (headless) in your workspace and sends replies back via **lark-cli** or, when needed, the **bridge’s Feishu API**.

**Scope:** Same capabilities as running `agent` locally (read/edit files, run shell commands, etc.). It is **not** a model hosted inside Feishu’s cloud.

**References:** [Feishu long-connection events](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) · [Cursor Agent CLI](https://cursor.com/docs/cli/headless) · [CLI parameters](https://cursor.com/docs/cli/reference/parameters)

---

## How it works (single path)

```
Phone / desktop Feishu ──► Feishu cloud ──► WSS long connection ──► Local bridge (Node)
                                                                      │
                                                                      ├─ Writes inbox/ (logs for debugging)
                                                                      └─ spawn `agent -p` (workspace = your project)
                                                                          └─ Reply: if lark-cli is confirmed delivered, stop; else bridge API fallback (no duplicate)
```

After a successful start, the console should show logs such as `mode=ws 长连接已启动` and `Cursor Agent CLI 自动模式已开启`.

---

## Pre-flight checklist

| Step | Item |
|------|------|
| 1 | **Custom enterprise app** created and published in Feishu; bot enabled |
| 2 | Event subscription uses **long connection**, with **Receive message** `im.message.receive_v1` |
| 3 | App has **send message** (and related) IM permissions for your scenario |
| 4 | **Node.js** installed locally (`npm install` works) |
| 5 | **Cursor Agent CLI** installed (`agent -h` works) and **`agent login`** done |
| 6 | **lark-cli** configured for the **same** app (can run `lark-cli im +messages-send --as bot ...`) |

---

## 1. Feishu Open Platform

1. Open [Feishu Open Platform](https://open.feishu.cn/app) → create a **custom enterprise app**.  
2. Enable the **bot** capability; **publish** a version so the app is available in your tenant.  
3. **Permissions:** enable items such as “receive user messages to the bot in single chat” and “receive @bot messages in groups” (names may vary in the console), plus permissions for the bot to **send** messages.  
4. **Events & callbacks → Event subscription:**  
   - Add **Receive message** `im.message.receive_v1`.  
   - **Subscription mode:** **Receive events through long connection** (do **not** use the public Webhook URL mode unless you fork a different stack).  
5. Copy **App ID** and **App Secret** from **Credentials & basic info** into `.env`.

Long-connection mode **does not** need Encrypt Key / Verification Token.

---

## 2. Local setup: Cursor CLI and lark-cli

```bash
# Cursor Agent CLI (official installer; see cursor.com for updates)
curl https://cursor.com/install -fsS | bash
agent -h
agent login
```

Install and sign in to **lark-cli** in your usual way (same app as the bot). Verify the bot can send messages, for example:

```bash
lark-cli auth status
# Test send (chat_id appears in inbox/LATEST.json after the first bridged message)
lark-cli im +messages-send --as bot --chat-id "oc_xxx" --text "connectivity test"
```

---

## 3. Configure and run

```bash
git clone <this-repo-url>
cd feishu-cursor-bridge
cp .env.example .env
```

**Minimal `.env` example** (replace placeholders):

```env
LARK_APP_ID=cli_xxxxxxxx
LARK_APP_SECRET=your_secret

CURSOR_AGENT_AUTO=1
CURSOR_AGENT_SANDBOX=disabled
```

Notes:

- **`CURSOR_AGENT_WORKSPACE`:** If unset, defaults to this repo root; set an **absolute path** to the project you want the agent to edit.  
- **`CURSOR_AGENT_STREAM_TO_FEISHU=1`:** Streams tool/progress snippets to Feishu; default is off so chats usually show **one concise reply**.  
- **`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK`:** On by default; the bridge posts via **API only when Feishu delivery is not confirmed** (see **“How replies reach Feishu”** below). If `lark-cli` succeeds, the bridge **does not** duplicate. Set to `0` for **lark-cli only** (may occasionally leave Feishu silent).  
- **`CURSOR_AGENT_TIMEOUT_MS`:** Max milliseconds per task, then the process is killed; `0` = no limit (e.g. use `600000` for 10 minutes). **Validated at startup** (integer, max ~24h).  
- **`CURSOR_AGENT_MAX_QUEUE`:** Max queued agent jobs; default `30`, max `500`, `0` = unlimited (not for production). **Validated at startup**; when full, new messages are rejected with a short Feishu notice.  
- **`ALLOWED_SENDER_OPEN_IDS`:** Comma-separated `ou_xxx` to only accept messages from trusted users. See **§7** for `REQUIRE_SENDER_ALLOWLIST`, format validation, and other hardening.  
- **`BRIDGE_FEISHU_TEXT_MAX_CHARS`:** Max characters for **bridge API** text sends (longer content is truncated); default `3500`, validated range `1`–`100000`. Feishu’s docs cap **text message request bodies around 150KB**; leave headroom for JSON escaping.  
- **lark-cli / files:** `lark-cli` is invoked by the local Agent, not wrapped by this repo—limits follow **Feishu Open Platform + your CLI version** (e.g. body size, images via upload/`image_key`, files via media APIs). Only **bridge fallback** truncation is configurable here via the variable above.

**How replies reach Feishu (user-visible behavior)**

- **Counted as “delivered”**  
  - **lark-cli:** Only when the agent stream shows **`tool_call` + `completed`** for a **`lark-cli … +messages-send`** terminal call, with **`result.success`**, **no `result.failure`**, `exitCode` 0, and stdout/interleaved output containing **`"ok":true`** or **`message_id`**. A **`started`** event alone does **not** count.  
  - **Bridge API:** A successful **`im.message.create`** from the bridge (fallback, errors, queue-full notice, etc.).
- **Quiet mode (default, no `CURSOR_AGENT_STREAM_TO_FEISHU`)**  
  - If delivery is **not** confirmed and **`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK=1`**, the bridge **API-fallback** sends model text (truncated by `BRIDGE_FEISHU_TEXT_MAX_CHARS`; echo-like drafts may be replaced with a short hint).  
  - If **lark-cli is confirmed delivered**, the bridge **does not** API-fallback (avoids **duplicate** bubbles).  
  - If still not confirmed, a short **nudge** message may be sent.  
- **Streaming mode (`CURSOR_AGENT_STREAM_TO_FEISHU=1`)**  
  - If lark-cli is confirmed delivered, the final **long assistant tail** is **not** pushed to Feishu (reduces duplication).  
- **Images and files**  
  - Built into the agent system prompt (not a separate env var): when the user asks to send an **image/screenshot/file**, default to **lark-cli attachments** (e.g. `+messages-send --image`, per your CLI). Do **not** replace with plain text or links only, and do **not** ask the user which channel to use.

Then:

```bash
npm install
npm start
```

If the port is busy, change `PORT` in `.env` or free the port. If **only** `/health` fails, the **WebSocket path can still receive Feishu events**.

---

## 4. Verify it works

1. **DM the bot** or **@ the bot in a group**, send plain text, e.g. `Hi—describe your workspace root in one sentence.`  
2. The terminal should show `[bridge] queued message`, `[cursor-agent] job start`, `spawn agent`.  
3. Feishu should show **one** bot reply within a reasonable time (from Agent + lark-cli, or bridge fallback).

If Feishu shows canned lines like “已收到，正在本机 Cursor 中处理，请稍候”: **this repo does not send that**. Turn off such **auto-replies** in the Feishu admin UI so they are not confused with real answers.

---

## 5. What it looks like in Feishu

**Desktop Feishu**, DM with a bot (name is yours; screenshots use `cursor_bot`). You can ask who it is, or ask for local `pwd` / `git` / system info to **prove** the agent runs on your machine—not a generic cloud chatbot.

![Feishu desktop: workspace path, git, CPU/RAM, OS version](./docs/images/feishu-cursor-bot-chat.png)

**Heavier example (code + run + image):** You can ask the agent to build a small app (e.g. Snake), run it, capture a screen, and send the image via **lark-cli / Feishu-side skills**. The screenshot also shows recalls and follow-up corrections.

![Feishu: Snake game, screenshot, image via skill, recalls](./docs/images/feishu-snake-game-example.png)

The tables below are **illustrative** wording; the agent’s phrasing varies. In default “quiet” mode, users often see **one bubble** per answer.

**Example 1 — environment**

| Who | Message |
|-----|---------|
| You | What is the workspace root directory? |
| Bot | `/Users/you/project/feishu-cursor-bridge` (illustrative) |

**Example 2 — local command**

| Who | Message |
|-----|---------|
| You | How much free disk space on the main volume? One sentence. |
| Bot | About 156 GB free on the main volume. (illustrative) |

**Example 3 — edit the repo**

| Who | Message |
|-----|---------|
| You | Add a small line at the top of README: “Internal tool—do not distribute.” |
| Bot | Updated the top of `README.zh.md`. (illustrative) |

**Example 4 — inbox log**

| Who | Message |
|-----|---------|
| You | Read `user_text` in inbox `LATEST.json` and summarize what you should do. |
| Bot | You want me to … (illustrative) |

In groups, **@ the bot** so messages are delivered to your app.

---

## 6. Optional: health check and Lark (international)

```bash
curl -s http://127.0.0.1:YOUR_PORT/health
# expected: ok
```

Set `BRIDGE_HEALTH_DISABLED=1` in `.env` if you do not want the HTTP probe.

**`/health` bind address:** defaults to **`127.0.0.1`** (localhost only). Override if needed:

```env
BRIDGE_HEALTH_HOST=127.0.0.1
```

For **Lark (international)**:

```env
LARK_USE_LARK_INTERNATIONAL=1
```

---

## 6.5. Debug logging (optional)

Set **`BRIDGE_DEBUG_LOG=1`** in `.env` to write bridge flow events and **full** Cursor Agent `stream-json` output to disk (default **`inbox/debug/`**, usually gitignored—**do not commit**).

| File | Contents |
|------|----------|
| **`bridge.log`** | Startup, dedupe, `writeIncoming`, enqueue, handler branches (no full user text). |
| **`agent-<timestamp>-<message_id>.log`** | Per job: metadata, **full user text**, **full prompt**, spawn bin/cwd/**args JSON**, **every stdout line** plus **pretty-printed JSON** for each object (assistant / tool_call “thinking” trail), **stderr** chunks, timeout/exit, `JOB_SUMMARY`. |

Optional **`BRIDGE_DEBUG_LOG_DIR`**: absolute path to a custom directory. Logs are sensitive—use only for troubleshooting, then disable and delete.

---

## 7. Security hardening and limits (configurable / validated)

On startup, **`src/securityConfig.js`** parses and validates the variables below; **invalid values exit the process**. For production, prefer at least: **allowlist + queue cap + per-job timeout + `/health` on loopback**.

### 7.1 Sender allowlist (strongly recommended)

| Variable | Default | Behavior |
|----------|---------|----------|
| **`ALLOWED_SENDER_OPEN_IDS`** | empty | Comma-separated Feishu user `open_id` (`ou_...`). If unset, **anyone who can chat with the bot** can trigger the local agent; a **security warning** is printed unless silenced below. |
| **`REQUIRE_SENDER_ALLOWLIST`** | off | If `1`/`true`/`on`: **`ALLOWED_SENDER_OPEN_IDS` must be non-empty** or startup **fails**. |
| **`VALIDATE_SENDER_OPEN_ID_FORMAT`** | off | If `1`: each allowlist entry must match the usual `ou_...` pattern or startup **fails**. |
| **`BRIDGE_SILENCE_INSECURE_ALLOWLIST_WARNING`** | off | If `1`: do not print the “no allowlist” warning (dev convenience only; **do not use in production**). |

### 7.2 Agent queue and timeout

| Variable | Default | Validation |
|----------|---------|------------|
| **`CURSOR_AGENT_MAX_QUEUE`** | `30` | Integer `0`–`500`. Invalid or over cap → startup fails. **`0` = unlimited** (easy to overload; **avoid in production**). When full, new work is **not enqueued** and the user gets a short Feishu message. |
| **`CURSOR_AGENT_TIMEOUT_MS`** | `0` | Integer `0`–~**86400000** (24h). **`0` = no limit** per job; non-zero kills the agent with **SIGTERM** at deadline. Invalid or over cap → startup fails. |

### 7.3 Health endpoint and strict config

| Variable | Default | Behavior |
|----------|---------|----------|
| **`BRIDGE_HEALTH_HOST`** | `127.0.0.1` | Address for `/health`. Default is loopback only; binding to e.g. `0.0.0.0` prints a **security warning** at startup. |
| **`BRIDGE_STRICT_CONFIG`** | off | If `1`: if **`CURSOR_AGENT_BIN` is an absolute path**, the file must exist; if **`CURSOR_AGENT_WORKSPACE`** is set, the directory must exist. Otherwise startup **fails**. |

### 7.4 Related settings (see above)

- **`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK`:** In quiet mode, API fallback runs **only if lark-cli success is not confirmed**; set `0` if model text must never go via API (may rarely leave Feishu silent).  
- **`CURSOR_AGENT_SANDBOX=disabled`:** Shell access—pair with **minimal workspace**, **low-privilege OS user**, and **allowlist**.  
- Do not commit **`.env`**; rotate **App Secret**; consider `chmod 600` on `.env`.

### 7.5 Example hardened `.env` snippet

```env
REQUIRE_SENDER_ALLOWLIST=1
ALLOWED_SENDER_OPEN_IDS=ou_xxxx,ou_yyyy
VALIDATE_SENDER_OPEN_ID_FORMAT=1

CURSOR_AGENT_MAX_QUEUE=20
CURSOR_AGENT_TIMEOUT_MS=600000

BRIDGE_HEALTH_HOST=127.0.0.1
BRIDGE_STRICT_CONFIG=1

CURSOR_AGENT_QUIET_BRIDGE_FALLBACK=0
```

---

## 8. Troubleshooting

| Symptom | What to do |
|---------|------------|
| Startup error asking for `CURSOR_AGENT_AUTO=1` | Set `CURSOR_AGENT_AUTO=1` in `.env` and restart. |
| Only Feishu auto-reply, no agent answer | Disable irrelevant auto-replies; check `[cursor-agent] failed` in the terminal; confirm `agent login` and `lark-cli` sends. |
| Long silence after `spawn agent` | Set `CURSOR_AGENT_STREAM_TO_FEISHU=1` to see progress, or `CURSOR_AGENT_TIMEOUT_MS`; avoid `CURSOR_AGENT_MAX_QUEUE=0` unless you understand unbounded queuing. |
| Startup: must configure `ALLOWED_SENDER_OPEN_IDS` | You set `REQUIRE_SENDER_ALLOWLIST=1` without an allowlist; fill it or turn the flag off. |
| Startup: `CURSOR_AGENT_MAX_QUEUE` / `TIMEOUT` invalid | Value out of range or not an integer; see §7. |
| Feishu says queue is full | Pending jobs reached `CURSOR_AGENT_MAX_QUEUE`; wait or raise the cap (max 500). |
| Many `duplicate delivery skipped` lines | Usually normal deduping; if you lose real messages, use a build that only locks `message_id` when body text is non-empty. |
| Another service shares the same Feishu app | Feishu may deliver events to one long connection only—avoid multiple consumers fighting for the same app. |
| `lark-cli` appears in logs but Feishu has no message | Open `inbox/debug/agent-*.log` → `JOB_SUMMARY`: if `larkCliFeishuOk` is `false`, the bridge should API-fallback; if still empty, check app permissions, `lark-cli`, network; inspect `tool_call` **completed** for `result.failure`. |
| Trace why the agent replied that way | Set `BRIDGE_DEBUG_LOG=1`, restart; see §6.5 and `JOB_SUMMARY`. |

Manual send test (`chat_id` from `inbox/LATEST.json`):

```bash
lark-cli im +messages-send --as bot --chat-id "oc_your_chat_id" --text "manual test"
```

---

## 9. Repository layout

| Path | Role |
|------|------|
| `docs/images/` | Documentation images (Feishu screenshots) |
| `inbox/LATEST.md` / `LATEST.json` | Latest Feishu command log |
| `inbox/cmd-*.json` | Per-message raw payloads |
| `inbox/debug/` | When `BRIDGE_DEBUG_LOG=1`: `bridge.log` and per-job `agent-*.log` |
| `.cursor/skills/feishu-cursor-bridge/SKILL.md` | Cursor agent checklist (full doc remains this README) |
| `.cursor/skills/feishu-cursor-bridge/reference.md` | Environment variable quick reference |
| `.cursor/rules/feishu-bridge.mdc` | Hints for editing this bridge in Cursor IDE (not required for Feishu auto-run) |
| `.cursor/rules/opencli.mdc` | **Optional:** notes for third-party [OpenCLI](https://github.com/jackwener/opencli) (e.g. Xiaohongshu); **not** part of the bridge, no code coupling |
| `scripts/git-push-all.sh` | Push Gitee then GitHub (skips GitHub on failure; retry later) |

---

## Maintainers: push to Gitee and GitHub

- **Gitee (default `origin`):** `git@gitee.com:jiangrong2001/feishu-cursor-bridge.git`  
- **GitHub:** `git@github.com:jiangrong2001/feishu-cursor-bridge.git` (remote name `github`)

**One-time** setup on your machine:

```bash
git remote add github git@github.com:jiangrong2001/feishu-cursor-bridge.git
```

If GitHub uses a **dedicated key** (e.g. `~/.ssh/id_rsa_github`), add this to **`~/.ssh/config`** so `git@github.com` picks the right key:

```text
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_rsa_github
```

Then run `ssh -T git@github.com` to verify authentication.

**Routine:** push Gitee first, then GitHub. If GitHub fails (network/SSH), the script **still exits successfully** so you can push again later and catch up:

```bash
npm run push:all
# or
bash scripts/git-push-all.sh
```

If `github` is not configured, only `origin` is pushed and the script prints how to add GitHub.

---

## License

This project is released under the **MIT License**. See [LICENSE](./LICENSE) in the repository root.

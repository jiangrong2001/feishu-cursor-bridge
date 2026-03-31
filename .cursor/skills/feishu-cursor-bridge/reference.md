# feishu-cursor-bridge — 环境变量参考

与根目录 `.env.example` 保持一致；完整说明见 **README.zh.md** / **README.md**。

## 必填（运行桥接）

| 变量 | 说明 |
|------|------|
| `LARK_APP_ID` | 飞书应用 App ID（`cli_` 开头） |
| `LARK_APP_SECRET` | 飞书应用密钥 |
| `CURSOR_AGENT_AUTO` | 必须为 `1` / `true` / `on`（本项目仅此模式） |
| `CURSOR_AGENT_SANDBOX` | 通常为 `disabled`（允许终端等，与 Cursor CLI 文档一致） |

## 常用可选

| 变量 | 说明 |
|------|------|
| `PORT` | HTTP `/health` 端口，默认 `8787` |
| `CURSOR_AGENT_WORKSPACE` | Agent 工作区绝对路径；不填则为仓库根 |
| `CURSOR_AGENT_BIN` | 默认可执行文件名 `agent` |
| `CURSOR_AGENT_MODEL` | 传给 `agent` 的 `--model` |
| `CURSOR_AGENT_STREAM_TO_FEISHU` | `1` 时向飞书推送工具/进度摘要 |
| `CURSOR_AGENT_QUIET_BRIDGE_FALLBACK` | 默认开；**仅当未确认 lark-cli 已成功发到飞书**时桥接 API 补发（避免空白与重复）；`0` 则只信 lark-cli |
| `CURSOR_AGENT_TIMEOUT_MS` | 单任务超时毫秒；`0` 不限制；启动校验整数 0～约 24h |
| `CURSOR_AGENT_MAX_QUEUE` | 队列上限；默认 `30`；`0`～`500`；`0`=不限制（生产勿用）；满则拒绝入队并发飞书提示 |
| `CURSOR_AGENT_FEISHU_MIN_INTERVAL_MS` | 仅 `STREAM_TO_FEISHU=1` 时飞书推送最小间隔 |
| `ALLOWED_SENDER_OPEN_IDS` | 逗号分隔 `ou_xxx`；未配则任何人可触发 Agent（有启动警告） |
| `REQUIRE_SENDER_ALLOWLIST` | `1` 时须非空 `ALLOWED_SENDER_OPEN_IDS`，否则拒绝启动 |
| `VALIDATE_SENDER_OPEN_ID_FORMAT` | `1` 时校验每项 `ou_` 格式，否则拒绝启动 |
| `BRIDGE_SILENCE_INSECURE_ALLOWLIST_WARNING` | `1` 时不打印未配白名单警告（仅开发） |
| `BRIDGE_HEALTH_HOST` | `/health` 绑定；默认 `127.0.0.1`；非回环时启动警告 |
| `BRIDGE_STRICT_CONFIG` | `1` 时校验绝对路径 `CURSOR_AGENT_BIN` 与 `CURSOR_AGENT_WORKSPACE` 存在 |
| `CURSOR_OPEN_ON_MESSAGE` | macOS `1` 时尝试 `open -a Cursor` 打开 `LATEST.md` |
| `BRIDGE_HEALTH_DISABLED` | `1` 时不监听 `/health` |
| `LARK_USE_LARK_INTERNATIONAL` | `1` 使用 Lark 国际版域 |
| `BRIDGE_FEISHU_TEXT_MAX_CHARS` | 桥接经 API 发送的文本最大字符数（超出截断）；默认 `3500`；上限 `100000`；启动校验 |
| `BRIDGE_DEBUG_LOG` | `1` 时写 `inbox/debug/bridge.log` 与每轮 `agent-*.log`（完整 prompt + Agent `stream-json`） |
| `BRIDGE_DEBUG_LOG_DIR` | 自定义调试日志目录（可选，绝对路径推荐） |
| `INBOX_DIR` | 自定义 inbox 目录 |
| `CURSOR_API_KEY` | 可选；不填则用 `agent login` 本机凭据 |

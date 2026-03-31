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
| `CURSOR_AGENT_QUIET_BRIDGE_FALLBACK` | 默认开；`0` 关闭「未识别 lark-cli 时桥接 API 补发」 |
| `CURSOR_AGENT_TIMEOUT_MS` | 单任务超时毫秒；`0` 不限制 |
| `CURSOR_AGENT_FEISHU_MIN_INTERVAL_MS` | 仅 `STREAM_TO_FEISHU=1` 时飞书推送最小间隔 |
| `ALLOWED_SENDER_OPEN_IDS` | 逗号分隔 `ou_xxx`，白名单发送者 |
| `CURSOR_OPEN_ON_MESSAGE` | macOS `1` 时尝试 `open -a Cursor` 打开 `LATEST.md` |
| `BRIDGE_HEALTH_DISABLED` | `1` 时不监听 `/health` |
| `LARK_USE_LARK_INTERNATIONAL` | `1` 使用 Lark 国际版域 |
| `INBOX_DIR` | 自定义 inbox 目录 |
| `CURSOR_API_KEY` | 可选；不填则用 `agent login` 本机凭据 |

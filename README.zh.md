# Feishu → Cursor 桥接（线路 3）

## 架构说明

```
手机飞书 ──发消息──► 飞书机器人 ──HTTPS 事件推送──► 本机桥接服务 (Node)
                                                      │
                                                      ├─ 写入 inbox/LATEST.md + LATEST.json
                                                      └─ 可选：osascript 通知 + 打开 Cursor

你在 Cursor 里让 Agent 读 LATEST.md、执行任务，并用 lark-cli 把结果发回飞书会话
```

**限制（诚实说明）**

- Cursor 没有公开的「远程自动跑 Agent」API；本方案是 **把命令落到本地文件**，由你在电脑上打开 Cursor 后处理（可配合 `CURSOR_OPEN_ON_MESSAGE=1` 自动弹出 `LATEST.md`）。
- 桥接服务必须 **长期运行**，且飞书能访问到你的 **公网 HTTPS**（内网需 ngrok / Cloudflare Tunnel 等）。

## 1. 飞书开放平台配置

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建**企业自建应用**。
2. **权限**：至少开通与场景相关的 IM 权限，例如：
   - 接收用户发给机器人的单聊消息；和/或
   - 接收群聊中 @机器人 的消息（按文档勾选对应 scope）。
3. **机器人**：启用机器人能力；发布版本并在企业内安装/可用。
4. **事件订阅**：
   - 请求地址：`https://<你的公网域名>/webhook/feishu`（路径须与 `.env` 里 `WEBHOOK_PATH` 一致，默认 `/webhook/feishu`）。
   - 订阅事件：**接收消息** `im.message.receive_v1`（文档名可能为 v2.0，以控制台为准）。
   - 复制 **Encrypt Key**、**Verification Token** 到本目录 `.env`。

## 2. 本机安装与启动

```bash
cd feishu-cursor-bridge
cp .env.example .env
# 编辑 .env 填入 LARK_ENCRYPT_KEY、LARK_VERIFICATION_TOKEN

npm install
npm start
```

健康检查：`curl http://127.0.0.1:8787/health` 应返回 `ok`。

## 3. 公网入口（示例：ngrok）

```bash
ngrok http 8787
```

把生成的 `https://xxxx.ngrok-free.app` 配到飞书事件订阅 URL：

`https://xxxx.ngrok-free.app/webhook/feishu`

保存后点击飞书后台「验证」，应能通过。

## 4. 与 Cursor 配合

1. 用 **手机飞书** 给机器人发**单聊**，或在群里 **@机器人**（视你开通的权限而定）。
2. 用 **Cursor 打开本仓库根目录** 作为工作区，以加载 `.cursor/rules/feishu-bridge.mdc`；Agent 会关注 `inbox/LATEST.md`。
3. 在 `.env` 设置 `CURSOR_OPEN_ON_MESSAGE=1`（仅 macOS）可在新消息时尝试用 `open -a Cursor` 打开 `LATEST.md` 并弹出系统通知。
4. 在 Cursor 对话中说明「处理飞书队列」或打开 `LATEST.md`，让 Agent 执行内容并用 `lark-cli` 回复（`chat_id` 在 `LATEST.json` 中）。

### 可选：自动「已收到」回复

在 `.env` 增加应用凭证并开启：

```
LARK_APP_ID=cli_xxx
LARK_APP_SECRET=xxx
LARK_AUTO_ACK=1
```

需机器人具备在对应会话发消息权限。

### 可选：仅允许指定用户

```
ALLOWED_SENDER_OPEN_IDS=ou_xxx,ou_yyy
```

## 5. 国际版 Lark

若 API 使用国际域名，在 `.env` 增加：

```
LARK_USE_LARK_INTERNATIONAL=1
```

（仅影响可选的 `Client` 自动回复；Webhook 解密逻辑一致。）

## 6. 安全建议

- 勿将 `.env` 提交到 Git。
- 生产环境应对公网入口限流或加 WAF；`ALLOWED_SENDER_OPEN_IDS` 可减小被陌生人刷队列的风险。
- 机器人勿拉入大群或给不可信用户使用，避免越权。

## 故障排查

- **验证 URL 失败**：检查 ngrok 是否指向本机端口、`WEBHOOK_PATH` 是否与飞书填写完全一致、Encrypt Key / Token 是否复制正确。
- **收不到消息**：检查应用是否已发布权限、机器人是否在会话中、事件是否已订阅、群场景是否需 @机器人。
- **Cursor 未弹出**：确认 macOS 上已安装 Cursor 且应用名为 `Cursor`；或改用手动打开 `inbox/LATEST.md`。

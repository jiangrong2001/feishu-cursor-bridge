# Feishu ↔ Cursor 桥接

**English:** [README.md](./README.md)

**给其它 Cursor 智能体：** 克隆本仓库后，Cursor 会根据项目 Skill 发现 **`.cursor/skills/feishu-cursor-bridge/`**；执行安装/排错时请先阅读本 **README.zh.md**（或 **README.md**）全文，**SKILL.md** 仅提供浓缩检查清单。若只打开仓库而未加载 Skill，直接阅读本 README 即可完成安装与使用。

本机运行一个 Node 服务：通过飞书 **WebSocket 长连接**接收消息，**不写公网 URL**；收到后在本机 **spawn Cursor 官方 Agent CLI**（headless）处理任务，并由 **lark-cli** 或桥接 API 把回答发回飞书。  
能力边界：与你在终端里跑的 `agent` 一致（读改工作区、跑命令等），**不是**飞书云里托管的模型。

**官方参考**：[飞书长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) · [Cursor Agent CLI](https://cursor.com/docs/cli/headless) · [CLI 参数](https://cursor.com/docs/cli/reference/parameters)

---

## 工作原理（单一路径）

```
手机/桌面飞书 ──► 飞书云 ──► WSS 长连接 ──► 本机桥接 (Node)
                                                │
                                                ├─ 写入 inbox/（日志，便于排查）
                                                └─ spawn `agent -p`（工作区=你的项目）
                                                    └─ 答复：lark-cli 成功送达则不再发；否则桥接 API 补发，避免空白
```

启动成功后，控制台应出现：`mode=ws 长连接已启动`，以及 `Cursor Agent CLI 自动模式已开启` 等日志。

---

## 使用前清单（按顺序核对）

| 步骤 | 内容 |
|------|------|
| 1 | 飞书**企业自建应用**已创建、已发布，机器人已启用 |
| 2 | 事件订阅为 **使用长连接接收事件**，且已订阅 **接收消息** `im.message.receive_v1` |
| 3 | 应用具备 **发消息** 等 IM 权限（与「机器人发消息」场景一致） |
| 4 | 本机已安装 **Node.js**，能执行 `npm install` |
| 5 | 本机已安装 **Cursor Agent CLI**（`agent -h` 可用），并已 **`agent login`** |
| 6 | 本机已配置 **lark-cli**，且与上述飞书应用一致（能 `lark-cli im +messages-send --as bot ...`） |

---

## 一、飞书开放平台

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建**企业自建应用**。  
2. **应用能力**里启用**机器人**；在**版本管理与发布**中发布到企业。  
3. **权限管理**：按需勾选「读取用户发给机器人的单聊消息」「获取用户在群组中 @ 机器人的消息」等与 IM 接收、机器人发消息相关的权限（以控制台实际名称为准）。  
4. **事件与回调** → **事件订阅**：  
   - 添加事件：**接收消息** `im.message.receive_v1`。  
   - **订阅方式** 选：**使用长连接接收事件**（不要填公网 Webhook URL）。  
5. 在**凭证与基础信息**复制 **App ID**、**App Secret**，稍后放入 `.env`。

长连接模式**不需要** Encrypt Key / Verification Token。

---

## 二、本机：Cursor CLI 与 lark-cli

```bash
# Cursor Agent CLI（官方安装脚本，以 cursor.com 文档为准）
curl https://cursor.com/install -fsS | bash
agent -h
agent login
```

按你现有方式安装并登录 **lark-cli**（与机器人同一应用），确保能代表机器人发消息，例如：

```bash
lark-cli auth status
# 向指定会话发一条测试（chat_id 可从首次桥接后的 inbox/LATEST.json 查看）
lark-cli im +messages-send --as bot --chat-id "oc_xxx" --text "连通性测试"
```

---

## 三、配置与启动

```bash
git clone <本仓库地址>
cd feishu-cursor-bridge
cp .env.example .env
```

**`.env` 最小可用示例**（把占位符换成你的值）：

```env
LARK_APP_ID=cli_xxxxxxxx
LARK_APP_SECRET=你的密钥

CURSOR_AGENT_AUTO=1
CURSOR_AGENT_SANDBOX=disabled
```

说明：

- **`CURSOR_AGENT_WORKSPACE`**：不填则默认为本仓库根目录；建议改成你真正要让 Agent 改代码的目录（绝对路径）。  
- **`CURSOR_AGENT_STREAM_TO_FEISHU=1`**：打开后会把工具调用等过程摘要推到飞书；默认关闭，飞书里通常只看到**一条简洁答复**。  
- **`CURSOR_AGENT_TRANSCRIPT_MIN_INTERVAL_MS`**：仅在使用 **`/v` 类前缀**（见 **§三点五**）时有用；两条「对话摘录」飞书消息之间的最短间隔（毫秒），默认 **`350`**；设为 **`0`** 则尽量连续发送。  
- **`BRIDGE_DISABLE_STARTUP_CONTROL_HELP=1`**：关闭**冷启动**时向「最近一次会话」自动推送控制命令说明（**重启**后仍会推送，见 §三点五）。  
- **`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK`**：默认开启；**仅当未确认飞书已收到本轮答复**时（见下节「答复如何回到飞书」），由桥接用 **API 补发**模型正文，减少空白；已确认 `lark-cli` 成功则**不**补发，避免重复。若你确定只要 lark-cli、不要桥接代发，可设为 `0`。  
- **`CURSOR_AGENT_TIMEOUT_MS`**：单条任务最长毫秒数，超时杀进程；`0` 表示不限制。长任务可设 `600000`（10 分钟）。  
- **`ALLOWED_SENDER_OPEN_IDS`**：逗号分隔的 `ou_xxx`，仅处理这些发送者，降低被陌生人刷队列的风险。  
- **`BRIDGE_FEISHU_TEXT_MAX_CHARS`**：桥接通过**飞书开放平台 API**发送纯文本时的**最大字符数**（超出会截断并附「…(截断)」）；默认 `3500`，启动校验范围 `1`～`100000`。飞书文档规定**文本类消息请求体约 150KB**，实际可发字符数受 JSON 转义等影响，请勿盲目顶格配置。  
- **lark-cli / 文件**：`lark-cli` 由本机 Agent 子进程调用，**发送与接收规格以飞书开放平台与 lark-cli 版本为准**（如文本请求体上限、发图需先上传拿 `image_key`、文件需走素材接口等）。本仓库**无法**通过 `.env` 改变 lark-cli 内部实现，仅能通过上项调整**桥接 API 补发**的截断长度；Agent 的 prompt 中会提示飞书单条与截断配置，便于模型自行拆条或使用文件能力。

**答复如何回到飞书（用户可见行为，与代码一致）**

- **怎样算「飞书已收到本轮答复」**  
  - **lark-cli**：仅在 Agent 流式 JSON 里出现 **`tool_call` 且 `subtype=completed`**，且为 **`lark-cli … +messages-send`** 的终端调用，**`result.success` 存在**、**无 `result.failure`**、`exitCode` 为 0，且输出中含 **`"ok":true`** 或 **`message_id`** 等成功特征时，桥接才认为 lark-cli 已送达。**仅在 started 阶段出现 lark-cli 不算送达。**  
  - **桥接 API**：桥接进程调用飞书 **`im.message.create` 成功**即视为已送达（含补发、兜底、错误提示等）。
- **安静模式（默认不开 `CURSOR_AGENT_STREAM_TO_FEISHU`）**  
  - 若**未**满足上一条「已送达」：`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK=1`（默认）时，会用 **API 补发**助手正文（过长按 `BRIDGE_FEISHU_TEXT_MAX_CHARS` 截断；若正文疑似复述用户原话则改发短提示，减少「把需求发回给你」）。  
  - 若 **lark-cli 已成功送达**，则**不再** API 补发同一答案，避免**重复气泡**。  
  - 若仍无法确认送达，会发一条简短**兜底提示**（如建议「重试」）。  
- **过程模式（`CURSOR_AGENT_STREAM_TO_FEISHU=1`）**  
  - 若已确认 lark-cli 成功，**不再**向飞书推送末尾大段模型摘要，避免与 lark-cli 内容重复。  
- **飞书斜杠控制命令**（`/h`、`/v`、`/restart` 等）的完整约定、启动/重启后自动推送说明，见 **§三点五、飞书控制命令（专题）**。  
- **图片与文件**  
  - 桥接内置给 Agent 的说明（非独立环境变量）：用户要**发图/截图/文件**时，**默认用 lark-cli 附件**（如 `+messages-send` 的 `--image` 等，以你本机 lark-cli 为准），**不要**只用纯文字或链接代替上传，**不要**再追问用户发送方式。

然后：

```bash
npm install
npm start
```

若提示端口占用：可改 `.env` 里 `PORT`，或结束占用进程；**仅 /health 失败时，长连接仍可正常收消息**。

---

## 三点五、飞书控制命令（专题）

以下命令均由**桥接进程**识别，**不会**进入 Cursor Agent；须**单独一条文本消息**发送（可前导空格），**不区分大小写**。普通开发任务**不要**以这些前缀开头（除非本意就是启用对应能力）。

### 速查表

| 命令 | 作用 |
|------|------|
| **`/h`** 或 **`/help`** | 机器人立即回复**本条专题的精简版**说明（可多段气泡）。 |
| **`/v`** / **`/verbos`** / **`/verbose`** | 前缀后须**空格或换行**再写任务正文；去掉前缀后交给 Agent，并在飞书**实时推送**与 `agent-*.chat.txt` **同格式**的对话摘录块。 |
| **`/restart`** | 重启桥接 Node；可选后跟**本地目录路径**作为新的 Agent 工作区（见下）。 |
| **「重试」等**（非斜杠） | 复用上一条**已去掉控制前缀**的任务正文（含是否曾用 `/v`）。 |

### `/h`、`/help`

- 仅当**整段消息**为 `/h`、`/help`（及首尾空白）时触发。  
- 与飞书里机器人推送的说明文案一致，便于随时查阅。

### `/v`、`/verbos`、`/verbose`（对话摘录）

- 示例：`/v 总结 README`、`/verbose\n帮我改一行代码`。  
- **仅前缀无正文**时不会入队有效任务。  
- 与 **`CURSOR_AGENT_STREAM_TO_FEISHU=1`** 的 🔧/📝 式进度**不叠加**；可调 **`CURSOR_AGENT_TRANSCRIPT_MIN_INTERVAL_MS`**（默认 350ms）。  
- 单条过长按 **`BRIDGE_FEISHU_TEXT_MAX_CHARS`** 拆条，带「（续 n/m）」。  
- `inbox` 里仍保留飞书**原文**（可含前缀）。

### `/restart`（重启桥接 + 可选工作区）

- **整段**匹配 `/restart`；后跟剩余文本则视为**目录路径**（绝对路径、相对**仓库根**、`~/…`）。  
- 会 **spawn** 新 Node 进程并退出当前进程；需 **pm2 / launchd / 终端循环** 等托管才能自动拉起。  
- 带路径时写入 **`.bridge-workspace-override`**（**gitignore**），启动时在 `.env` 之后应用，**覆盖** `.env` 里的 `CURSOR_AGENT_WORKSPACE`。  
- **重启成功**后，会向**发起重启的会话**依次发送：**重启成功 + 当前工作区**，再发**与 `/h` 相同**的控制命令说明。  
- **`BRIDGE_RESTART_VIA_FEISHU=0`** 可关闭远程重启。  
- **`BRIDGE_DEBUG_LOG=1`** 时 **`inbox/debug/bridge.log`** 记录 `/restart` 相关步骤。

### 启动 / 重启后主动推送说明

- **冷启动**（非 `/restart` 拉起）：WebSocket 就绪后，若存在 **`.bridge-last-chat.json`**（由最近一次成功写入 `inbox` 的会话自动生成，**gitignore**），会向该会话推送：**桥接已启动** + 控制命令说明（与 `/h` 同套文案）。**从未有人发过消息**时不会推送。  
- **`BRIDGE_DISABLE_STARTUP_CONTROL_HELP=1`**：仅关闭上述**冷启动**推送；**`/restart` 后的说明仍会发**。  

---

## 四、自测是否成功

1. 与机器人**单聊**，或在与机器人的**群聊里 @ 机器人**，发一句纯文字，例如：`你好，请用一句话介绍你的工作区路径`。  
2. 本机终端应出现：`[bridge] queued message`、`[cursor-agent] job start`、`spawn agent`。  
3. 飞书会话里应在合理时间内出现回复：默认多为**一条**机器人文字（Agent + lark-cli 或桥接补发）；若本条用户消息以 **`/v` / `/verbos` / `/verbose`** 开头，则会先有一条开场提示，随后**多条**「对话摘录」式消息（见 **§三点五**）。随时可发 **`/h`** 索取控制命令说明。  

若飞书里出现「已收到，正在本机 Cursor 中处理，请稍候」等固定话术：**不是本仓库发送的**，请到飞书后台关闭同类**自动回复**，以免与真实答案混淆。

---

## 五、对话示例（飞书里长什么样）

以下为**桌面飞书**与机器人单聊的真实界面示意（机器人名可自定，图中为 `cursor_bot`）。用户可询问身份、要求用本机 `pwd` / `git` / 系统信息**自证** Agent 跑在指定工作区，而非普通云端闲聊。

![飞书桌面端与机器人对话：本机工作目录、git、CPU/内存与系统版本等](./docs/images/feishu-cursor-bot-chat.png)

**复杂任务示例（本机开发 + 运行 + 发图片）**：用户可要求在本机工作区编写小应用（如贪吃蛇）、运行并截图，再通过 **lark-cli / 飞书侧 skill** 将图片发到会话；图中也包含撤回消息、纠正发送方式等交互。

![飞书对话：开发贪吃蛇、运行截图、通过 skill 发图与撤回纠错](./docs/images/feishu-snake-game-example.png)

下表为**文字示意**（实际措辞由当轮 Agent 决定）；默认「安静模式」下，用户侧通常**一条气泡**就是答案。

**示例 1：环境信息**

| 角色 | 内容 |
|------|------|
| 你 | 当前工作区根目录是哪个文件夹？ |
| 机器人 | `/Users/you/project/feishu-cursor-bridge`（示意） |

**示例 2：本机命令**

| 角色 | 内容 |
|------|------|
| 你 | 查一下本机主磁盘还剩多少可用空间，用一句话回答。 |
| 机器人 | 主卷剩余约 156GB 可用。（示意） |

**示例 3：改仓库里的文件**

| 角色 | 内容 |
|------|------|
| 你 | 在 README 顶部加一行小字：「内部工具，勿对外公开」。 |
| 机器人 | 已改好 `README.zh.md` 顶部一行。（示意） |

**示例 4：结合 inbox 日志**

| 角色 | 内容 |
|------|------|
| 你 | 看一下 inbox 里 LATEST.json 的 user_text，用一句话概括我想让你做什么。 |
| 机器人 | 你想让我根据最新一条飞书指令做 xxx。（示意） |

群聊里请尽量 **@机器人**，避免消息未投递到应用。

---

## 六、可选：健康检查与国际版

```bash
curl -s http://127.0.0.1:你的PORT/health
# 期望输出：ok
```

不需要 HTTP 探测时可在 `.env` 设置 `BRIDGE_HEALTH_DISABLED=1`。

**`/health` 绑定地址**：默认 **`127.0.0.1`**（仅本机访问，避免局域网暴露）。若需改绑：

```env
BRIDGE_HEALTH_HOST=127.0.0.1
```

使用 **Lark 国际版** 时增加：

```env
LARK_USE_LARK_INTERNATIONAL=1
```

---

## 六点五、调试日志（可选）

在 `.env` 中设置 **`BRIDGE_DEBUG_LOG=1`** 后，桥接会把**流程关键节点**和 **Cursor Agent 的完整处理过程**写到本机文件（默认在 **`inbox/debug/`**，与 `inbox/*` 一样通常被 `.gitignore` 忽略，**勿提交**）。

| 文件 | 内容 |
|------|------|
| **`bridge.log`** | 启动、收包、去重、`writeIncoming`、入队、`im.message` 处理分支等（**不写**用户消息正文，避免与 per-job 日志重复）。 |
| **`agent-<时间戳>-<message_id>.log`** | 每轮一条：会话元数据、**完整用户原文**（去前缀后的任务正文）、**下发给 Agent 的完整 prompt**、`spawn` 的 bin/cwd/**完整 argv（JSON）**、**stdout 每一行原文**（`stream-json`）；对 JSON 行额外写入 **格式化后的对象**（便于阅读 `assistant` / `tool_call` 等「思考与工具过程」）、**stderr 片段**、超时与错误；末尾 **`JOB_SUMMARY`** 含 `larkCliFeishuOk`（lark-cli 是否按成功特征判定已送达）、`bridgeFeishuDelivered`、`feishuReplyDelivered`（二者任一即视为本轮已对外发信）、`streamTranscriptToFeishu`（是否 `/v` 类前缀触发的摘录流）等。 |
| **`agent-<时间戳>-<message_id>.chat.txt`** | 与上条同轮生成：把 `stream-json` 整理成**易读对话块**（与飞书 **`/v`** 推送块**同格式**），便于复盘；未开调试时若仅用 `/v`，此文件**不会**落盘，但飞书侧仍会收到同结构摘录。 |

可选 **`BRIDGE_DEBUG_LOG_DIR`**：指定绝对路径目录（会自动创建）。日志含用户指令与工作区上下文，**生产环境仅在排障时短时开启**，用后关闭并清理目录。

---

## 七、安全加固与限制项（可配置 / 可校验）

桥接在启动时会通过 **`src/securityConfig.js`** 解析并校验下列变量（非法值会直接 **退出进程**）。生产环境建议至少：**白名单 + 队列上限 + 单任务超时 + `/health` 仅本机**。

### 7.1 发送者白名单（强烈推荐）

| 变量 | 默认 | 行为 |
|------|------|------|
| **`ALLOWED_SENDER_OPEN_IDS`** | 空 | 逗号分隔的飞书用户 `open_id`（`ou_...`）。**未配置时**，凡能与机器人会话的用户均可触发本机 Agent；启动会打印**安全提示**（可用下方变量关闭提示）。 |
| **`REQUIRE_SENDER_ALLOWLIST`** | 关 | 设为 `1`/`true`/`on` 时：**必须**配置非空的 `ALLOWED_SENDER_OPEN_IDS`，否则**拒绝启动**。 |
| **`VALIDATE_SENDER_OPEN_ID_FORMAT`** | 关 | 设为 `1` 时：校验白名单中每一项符合 `ou_` 开头的常见格式，非法则**拒绝启动**。 |
| **`BRIDGE_SILENCE_INSECURE_ALLOWLIST_WARNING`** | 关 | 设为 `1` 时：未配白名单时**不**打印警告（仅本地调试便利，**生产勿开**）。 |

### 7.2 Agent 队列与超时

| 变量 | 默认 | 校验 |
|------|------|------|
| **`CURSOR_AGENT_MAX_QUEUE`** | `30` | 整数 `0`～`500`。超过上限或非法值 → 启动失败。`**0` = 不限制队列长度**（易被刷爆，**生产勿用**）。队列满时新消息**不入队**，并向当前会话发一条飞书提示。 |
| **`CURSOR_AGENT_TIMEOUT_MS`** | `0` | 整数 `0`～约 **86400000**（24h）。`**0` = 不限制**单任务时长；非 0 到点 **SIGTERM** agent（与现有逻辑一致）。非法或超上限 → 启动失败。 |

### 7.3 HTTP 健康检查与严格配置

| 变量 | 默认 | 行为 |
|------|------|------|
| **`BRIDGE_HEALTH_HOST`** | `127.0.0.1` | `/health` 监听地址。默认仅本机；若设为 `0.0.0.0` 等，启动时会**打印安全警告**。 |
| **`BRIDGE_STRICT_CONFIG`** | 关 | 设为 `1` 时：**`CURSOR_AGENT_BIN` 若为绝对路径**则文件必须存在；**`CURSOR_AGENT_WORKSPACE`** 若已设则目录必须存在。否则**拒绝启动**。 |

### 7.4 其它与 Agent 能力相关（沿用前文）

- **`CURSOR_AGENT_QUIET_BRIDGE_FALLBACK`**：安静模式下，**仅当未确认 lark-cli 已成功发到飞书**时由桥接 API 补发；敏感环境可设 `0`，避免模型输出进飞书（可能偶发空白）。  
- **`CURSOR_AGENT_SANDBOX=disabled`**：Agent 可执行终端命令，请配合**最小工作区**、**低权系统用户**、**白名单**使用。  
- 勿提交 **`.env`**；定期在飞书后台轮换 **App Secret**；`.env` 文件权限建议 `chmod 600`。

### 7.5 加固示例 `.env` 片段

```env
# 生产推荐
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

## 八、故障排查（按现象）

| 现象 | 处理方向 |
|------|----------|
| 启动报错要求设置 `CURSOR_AGENT_AUTO=1` | 在 `.env` 中加入或改为 `CURSOR_AGENT_AUTO=1` 后重启。 |
| 只有飞书自动回复、没有 Agent 答案 | 关飞书后台无关自动回复；看终端是否有 `[cursor-agent] failed`；确认 `agent login`；确认 `lark-cli` 能发消息。 |
| `spawn agent` 后很久无回复 | 设 `CURSOR_AGENT_STREAM_TO_FEISHU=1` 看过程；或**单条任务**用消息前缀 **`/v`** 在飞书看对话摘录；或设 `CURSOR_AGENT_TIMEOUT_MS`；并确认未误将 `CURSOR_AGENT_MAX_QUEUE` 设为 `0` 导致异常排队。 |
| 启动报「必须配置 ALLOWED_SENDER_OPEN_IDS」 | 已设 `REQUIRE_SENDER_ALLOWLIST=1` 但未填白名单；补全或关闭该项。 |
| 启动报 `CURSOR_AGENT_MAX_QUEUE` / `TIMEOUT` 非法 | 超出允许范围或非整数；见 §七表格。 |
| 飞书提示「队列已满」 | 待处理任务已达 `CURSOR_AGENT_MAX_QUEUE`；等待执行完毕或调大上限（勿超过 500）。 |
| `duplicate delivery skipped` 过多 | 多为正常去重；若误判丢失，升级至已修复「仅在有正文时锁 message_id」的版本。 |
| 与另一套服务共用同一飞书应用 | 飞书可能对同一应用只投递一条长连接，避免多实例抢事件。 |
| 要复盘 Agent 为何那样回复 | 设 `BRIDGE_DEBUG_LOG=1` 重启，查看 `inbox/debug/agent-*.log`（含完整流式 JSON 与 prompt）。 |
| lark-cli 在日志里跑了但飞书没消息 | 看该轮 `JOB_SUMMARY`：`larkCliFeishuOk` 为 `false` 时桥接应已尝试 API 补发；若仍为空白，查飞书应用权限、本机 `lark-cli` 与网络；对比 `tool_call` **completed** 是否含 `result.failure`。 |

手动验证机器人能否发消息（`chat_id` 来自 `inbox/LATEST.json`）：

```bash
lark-cli im +messages-send --as bot --chat-id "oc_你的chat_id" --text "手动测试"
```

---

## 九、项目内文件说明

| 路径 | 作用 |
|------|------|
| `docs/images/` | 文档用配图（如飞书界面截图） |
| `docs/promo/` | 可选：小红书等推广稿与 `opencli xiaohongshu publish` 示例命令（与桥接运行无关） |
| `inbox/LATEST.md` / `LATEST.json` | 最新一条飞书指令的日志，便于对照 |
| `inbox/cmd-*.json` | 历史每条消息的原始字段 |
| `inbox/debug/` | 仅当 `BRIDGE_DEBUG_LOG=1`：`bridge.log` 与每轮 `agent-*.log` |
| `.cursor/skills/feishu-cursor-bridge/SKILL.md` | 供 Cursor 智能体发现的安装检查清单（正文仍以 README 为准） |
| `.cursor/skills/feishu-cursor-bridge/reference.md` | 环境变量速查表 |
| `.cursor/rules/feishu-bridge.mdc` | 在本仓库用 Cursor IDE 开发桥接时的说明（与「飞书全自动」运行无关） |
| `.cursor/rules/opencli.mdc` | **可选**：第三方 [OpenCLI](https://github.com/jackwener/opencli) 用法备忘（小红书等）；**非**桥接功能、**无**代码耦合，不影响飞书长连接 |
| `scripts/git-push-all.sh` | 依次推送 Gitee + GitHub（GitHub 失败时跳过，下次再推） |

---

## 维护者：Gitee 与 GitHub 双远程推送

- **Gitee（默认 `origin`）**：`git@gitee.com:jiangrong2001/feishu-cursor-bridge.git`  
- **GitHub**：`git@github.com:jiangrong2001/feishu-cursor-bridge.git`（remote 名建议为 `github`）

**首次**在本机添加 GitHub 远程（只需一次）：

```bash
git remote add github git@github.com:jiangrong2001/feishu-cursor-bridge.git
```

若 GitHub 使用**独立私钥**（例如本机约定为 `~/.ssh/id_rsa_github`），请在 **`~/.ssh/config`** 中为 `github.com` 指定 `IdentityFile`，否则会出现 `Permission denied (publickey)`：

```text
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_rsa_github
```

改完后可执行 `ssh -T git@github.com` 确认能认证成功。

**日常**先推 Gitee、再推 GitHub；若 GitHub 因网络或 SSH 暂时失败，脚本**不会以非零退出**，本地提交保留，**下次**再执行会一并推上 GitHub：

```bash
npm run push:all
# 或
bash scripts/git-push-all.sh
# 指定分支：bash scripts/git-push-all.sh main
```

若未配置 `github` remote，脚本只推 `origin` 并提示如何添加。

---

## 开源协议

本项目以 **MIT License** 发布，详见仓库根目录 [LICENSE](./LICENSE)。

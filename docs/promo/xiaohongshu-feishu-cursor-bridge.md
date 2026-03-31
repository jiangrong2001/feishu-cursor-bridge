# 小红书推广稿：feishu-cursor-bridge

仓库内归档，修改 **`xiaohongshu-body.txt`** 后可用 OpenCLI 一键发帖（见文末）。

## 标题备选（≤20 字）

| 文案 |
|------|
| 手机飞书遥控本机 Cursor |
| 飞书长连接联动 Cursor Agent |

## 正文源文件

- **`xiaohongshu-body.txt`**：纯文本正文，供 `opencli xiaohongshu publish "$(cat …)"` 使用。

## 话题标签（`--topics`，逗号分隔、不带 #）

`飞书,Cursor,程序员,效率工具,开源,AI编程,远程办公`

## 配图

仓库 **`docs/images/`**：

- `feishu-cursor-bot-chat.png` — 飞书与机器人对话示意（建议首图）
- `feishu-snake-game-example.png` — 复杂任务示例（可选第二张）

## 使用 OpenCLI 发布

前置：[OpenCLI](https://github.com/jackwener/opencli) 已全局安装、Chrome **Browser Bridge** 扩展、小红书已登录。详见 `.cursor/rules/opencli.mdc`。

在**本仓库根目录**执行：

**先发草稿（推荐）**

```bash
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

opencli xiaohongshu publish "$(cat docs/promo/xiaohongshu-body.txt)" \
  --title "手机飞书遥控本机 Cursor" \
  --images "$(pwd)/docs/images/feishu-cursor-bot-chat.png,$(pwd)/docs/images/feishu-snake-game-example.png" \
  --topics "飞书,Cursor,程序员,效率工具,开源,AI编程" \
  --draft true
```

**直接发布**（确认文案与合规后，去掉 `--draft true`）

```bash
opencli xiaohongshu publish "$(cat docs/promo/xiaohongshu-body.txt)" \
  --title "手机飞书遥控本机 Cursor" \
  --images "$(pwd)/docs/images/feishu-cursor-bot-chat.png,$(pwd)/docs/images/feishu-snake-game-example.png" \
  --topics "飞书,Cursor,程序员,效率工具,开源,AI编程"
```

查看帮助：`opencli xiaohongshu publish -h`

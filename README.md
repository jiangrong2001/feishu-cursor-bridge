# Feishu ↔ Cursor Bridge

**Full documentation (Chinese): [README.zh.md](./README.zh.md)**

This project connects Feishu (Lark) to your local machine via **WebSocket long connection** (no public URL), then runs the official **Cursor Agent CLI** to handle messages and replies using **lark-cli** (or a bridge API fallback).

### Screenshot (Feishu desktop)

Example chat with a bot: ask who it is, or request local `pwd` / `git` / system info to verify the agent runs on your workspace.

![Feishu desktop chat with Cursor Agent bot](./docs/images/feishu-cursor-bot-chat.png)

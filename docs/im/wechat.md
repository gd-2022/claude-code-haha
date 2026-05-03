# 微信接入

> 微信 Adapter 的接入教程。微信不需要手动填写 Bot Token，在桌面端扫码确认后即可绑定。

## 适用场景

微信方案适合个人私聊远程使用。当前实现先支持文本聊天、项目选择、状态查看、停止生成和权限审批；附件收发后续再补齐。

## 1. 在桌面端扫码绑定

打开桌面端 `设置 -> IM 接入 -> 微信`：

1. 点击「扫码绑定」
2. 使用微信扫描页面里的二维码
3. 在微信中确认
4. 页面显示绑定成功后，桌面端会重启 IM adapter sidecar

扫码成功后，桌面端会把微信返回的账号凭据写入 `~/.claude/adapters.json` 的 `wechat` 配置，并把扫码用户加入 `pairedUsers`。

## 2. 发送消息

绑定后，直接在微信里发送自然语言消息即可。

如果没有配置默认项目，Adapter 会先返回最近项目列表，回复编号后再开始会话。

## 支持的命令

- `/projects` — 切换项目，重新显示最近项目列表
- `/status` — 查看当前会话的项目、模型和运行状态
- `/clear` — 清空当前会话上下文，保留项目绑定
- `/new` — 清空当前 chat 绑定的 session，并重新选择项目
- `/help` — 显示当前可用命令
- `/stop` — 向当前 session 发送 `stop_generation`
- `/allow <requestId>` — 允许一次权限请求
- `/deny <requestId>` — 拒绝一次权限请求

## 解绑

在桌面端 `设置 -> IM 接入` 的「已配对用户」列表里点击微信用户右侧的「解绑」。

解绑会清空微信账号凭据和已配对用户，并重启 adapter sidecar。解绑后需要重新扫码才能继续使用。

## 本地开发启动

```bash
cd adapters
bun install
bun run wechat
```

可选环境变量：

```bash
export WECHAT_ACCOUNT_ID="..."
export WECHAT_BOT_TOKEN="..."
export WECHAT_BASE_URL="https://ilinkai.weixin.qq.com"
export ADAPTER_SERVER_URL="ws://127.0.0.1:3456"
```

正常桌面端使用不需要手动设置这些环境变量，扫码绑定会写入本地配置。

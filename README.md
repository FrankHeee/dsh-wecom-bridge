# dsh-wecom-bridge

企业微信智能机器人 → [DeepSeek Harness](https://www.deepseek.com/en/harness/) / dsh-superagent 的桥。

两个插件：

| 插件 | 作用 |
| --- | --- |
| `dsh-wecom-watch` | **企业微信 Source**：长连接接收消息，转成 Ticket，执行后回到原会话交付 |
| `dsh-wecom-title-refiner` | **会话标题提炼**：定期把标题更新成概括主题的短语，并清理模型思维链标签 |

## 为什么需要它

dsh-superagent 原生只支持 GitHub 和飞书。企业微信的智能机器人没有公开的 HTTP 事件接口，
但提供了 **WebSocket 长连接**模式：开发者主动连 `wss://openws.work.weixin.qq.com`，
用 BotID 和 Secret 订阅，消息以明文推送过来。

长连接模式的好处：

- **不需要公网 IP**，内网机器也能接
- **不需要回调地址**，不用配 Nginx
- **不需要加解密**，不用处理 AES 和签名
- 延迟低，可主动推送流式消息

## 前置条件

1. 企业微信管理后台里有一个**智能机器人**，API 模式选「**长连接**」
2. 拿到 **BotID** 和 **Secret**（长连接专用密钥，不是回调模式的 Token / EncodingAESKey）
3. 一个 dsh-superagent 已经在跑

## 安装

```sh
git clone https://github.com/<your-account>/dsh-wecom-bridge.git
cd dsh-wecom-bridge
pnpm install && pnpm build

dsh superagent --from-default-profile web --dump-config > /dev/null   # 仅首次
dsh plugin --profile superagent add "link:$PWD"
```

然后把机器人的凭据写进 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-wecom-bridge
  config:
    botId: aibLrAutxxxxxxxx
    secret: xxxxxxxxxxxxxxxxxxxxx
```

> 更好的做法是在面板里配置：Superagent → 设置 → Source → 企业微信。

## 使用

在企业微信里给机器人发消息（或在群里 @它）。消息会变成一个 Ticket，
执行完成后结果回到原会话。

面板上可以看：

- **Source** → 企业微信：连接状态、收到的消息、被过滤的消息
- **执行** → 工单：每个请求的执行过程
- **评估** → 判断它为什么接或不接

## 会话标题提炼

标题提炼插件定期读取会话标题，把它换成概括主题的短语（如「企业微信桥接」而不是
「headless 回复两个字：测试」）。

两条硬规则：

1. **人手动改过的标题永不覆盖**（标题来源为 `user` 时跳过）
2. 标题里不会出现模型的思维链标签（`<<think>…</think>`）

触发条件：每 N 条人消息（默认 8）或距上次提炼 M 分钟（默认 30 分钟），取先到者。

## 配置

### `dsh-wecom-watch`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `botId` | `''` | 智能机器人的 BotID |
| `secret` | `''` | 长连接专用 Secret |
| `directMessages` | `true` | 是否接收私聊 |
| `chats` | `[]` | 接收的群，元素是 `{ chatId, name }` |
| `otherChats` | `'none'` | 未列出的群：`none` 不接收，`mentions` 只接收 @机器人 |
| `reconnectDelayMs` | `5000` | 断线重连间隔 |

企微没有群名查询接口，`chatId` 需要手填。机器人单聊里发一条消息即可拿到
`chatid`（见日志）。

### `dsh-wecom-title-refiner`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用 |
| `everyMessages` | `8` | 每多少条人消息提炼一次 |
| `minIntervalMs` | `1800000` | 两次提炼的最小间隔（30 分钟） |
| `provider` / `model` | `''` | 留空则用会话自己的模型 |
| `maxChars` | `32` | 标题最大字符数 |

## 开发

```sh
pnpm check     # 类型检查 + 测试 + 构建
```

## 许可

MIT

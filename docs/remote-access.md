# 远程访问技术说明

<p align="center">
  <b>简体中文</b> · <a href="remote-access.en.md">English</a> · <a href="remote-access.ja.md">日本語</a>
</p>

本文说明 PersonAI Mobile 如何连接电脑、如何加密、如何选择局域网或公网地址。产品使用说明见
[README](../README.md)；公网入口配置见[自建公网隧道](self-hosted-tunnel.md)。

## 范围

当前实现覆盖：

- Framework 的共享 remote 协议、RPC 契约与远程服务端；
- Tron 的 `tron-remote-pack` 与远程入口；
- PersonAI Mobile 的 Noise 隧道、配对、RPC 客户端与多地址选路。

其他产品接入同一套 framework 协议，但目前只有 Tron 提供了完整的 mobile pack。

## 连接路径

```text
PersonAI Mobile
  ├── 局域网：ws://<lan-ip>:<remote-port>/remote/secure
  └── 公网：  wss://<public-host>/remote/secure
                    │
                    ▼
              TLS 终止（自建 FRP / Cloudflare Tunnel / Tailscale / 反代）
                    │
                    ▼
              Tron remote listener（HTTP + WebSocket）
```

两种路径使用同一个协议和同一套 Noise 加密。公网 TLS 只是外层传输；应用层仍然是端到端加密的，TLS 终止方看不到 RPC 内容。

## 配对

配对二维码：

```text
tron://pair?url=<preferred>&lan=<lan-url>&public=<public-url>
  &name=<machine>&product=tron&productName=Tron
  &node=<node-id>&key=<node-public-key>&kid=<fingerprint>&ticket=<ticket>
```

- `url` 是兼容旧客户端的首选地址；新客户端优先使用 `lan` / `public`。
- `ticket` 是一次性配对票据，默认 300 秒有效；服务端在首次认证后消费。
- `key` 是电脑的 X25519 静态公钥；`kid` 是它的指纹，客户端会重新计算并比对。
- 手机首次配对时生成自己的 X25519 设备密钥，私钥写入系统安全存储（SecureStore）。
- 配对成功后设备进入电脑端设备表；后续连接不需要 ticket，用设备密钥完成 Noise 握手，并通过设备 ID 或公钥识别。

## 传输与加密

- Noise：`Noise_IK_25519_ChaChaPoly_SHA256`。
- 一个 WebSocket 二进制帧承载一条 Noise 传输消息；明文是一个 JSON envelope。
- 握手 prologue：`tron-remote\0<nodeId>\0<productCode>\0<lan|public>`。
- 传输 nonce 是 12 字节 AEAD nonce：前 4 字节为 0，后 8 字节为 64 位小端计数器。手写 Noise 客户端必须与 `snow` 保持一致，否则 `auth`（nonce 0）会成功，而第一个 ping/RPC（nonce 1）会解密失败。
- 应用层加密独立于公网 TLS；即使 TLS 在反向代理处终止，代理也无法读取会话内容。

## RPC

通用会话方法：

```text
session.list
session.history
session.create
session.sendMessage
session.stopRun
session.watchEvents
session.unwatchEvents
```

Tron 产品方法（命名空间 `tron.*`）：

```text
tron.workspaces.list
tron.assistants.list
tron.assistants.mainSession
tron.assistants.createSession
tron.projects.list
tron.directories.list
tron.session.groups
tron.skins.list
tron.skins.active
```

约定：

- `rpc` / `cancel` / `ping` / `pong` / `rpc_result` / `rpc_error` / `rpc_end` / `rpc_event` 是 envelope 类型。
- `rpc_event.data` 直接是 AG-UI 事件，不重命名、不再包一层自定义事件。
- `session.watchEvents` 先订阅、再 replay、最后接实时事件；客户端按 `seq` 去重。
- 流式调用在 `rpc_result` 后以 `rpc_end` 结束；客户端只忽略未知事件，不因为新事件类型断开。
- 聊天页重新进入一个仍在运行的会话时，不依赖发起这次 run 的那个客户端：先用 `tron.chat.protocolEvents` 判断最后一次 run 没有终态事件，再用 `session.watchEvents`（`tailOnly`，跳过体积巨大的整段 replay）接上实时事件；产品没有事件总线时退化为按 2.5s 重读 replay。AG-UI 卡片（工具轨、A2UI surface）由 replay 与 `tron.chat.a2uiState` 重建。
- `tron.chat.answerUserInput` 与 `tron.chat.a2uiAction` 是一次性调用：节点收集完恢复后的整段执行才返回。所以手机在提交的瞬间就订阅 `session.watchEvents` 接管这次恢复（恢复可能沿用原 runCode，也可能换新），进度来自事件流；该调用超时或断开只当作"客户端停止等待"，不视为回答未被接受。

## 局域网 / 公网选路

节点保存：

```ts
interface SavedNode {
  lanBaseUrl?: string;
  publicBaseUrl?: string;
  baseUrl: string;       // 当前活动地址
  transport: "lan" | "public";
}
```

选择顺序：

1. 启动、回到前台、网络变化时，先探测 LAN（`tunnel ping`，约 1.2 秒超时）。
2. LAN 不通再试 public。
3. 两者都不通标记离线；成功则把活动的 `baseUrl` / `transport` 写回节点。
4. 网络变化通过 `expo-network` 监听，600ms 防抖；App 回到前台由 NodeSession 重连。
5. 同一个节点跨地址切换时会话 key 只包含节点身份，因此切换地址不会清空当前聊天内容。

## 服务端入口与公网策略

Tron remote listener 提供：

```text
/health
/remote/identity
/remote/secure
```

公网请求必须满足：

- `Host` 与配置的 `publicBaseUrl` 一致；
- 请求来自可信代理（默认 loopback）；
- `X-Forwarded-Proto` 包含 `https`（或 `Forwarded` 中声明 https）。

不满足时返回 400。LAN 请求不受公网策略限制，因此同一节点可以同时接受家里的 LAN 连接和外面的公网连接。

## 安全边界

- 配对票据一次性、短有效期；设备密钥只在手机安全存储里。
- 电脑端可以查看已配对设备并远程吊销。
- 会话与消息只存在内存，不写入手机磁盘。
- 公网入口由用户自建，不经过 Person-AI 的中转服务；公网链路没有引入新的可信第三方。
- 当前没有 P2P / NAT 打洞，也不提供 relay；公网可达性由用户自己的隧道负责。

## 代码位置

Mobile：

- `src/crypto/noise.ts`：Noise IK 与传输 cipher；
- `src/api/tunnel.ts`：WebSocket 隧道、RPC、候选地址与探测；
- `src/api/rpc.ts`：RPC 封装；
- `src/utils/pairing.ts`：二维码解析；
- `src/store/connections.tsx`：节点与活动地址；
- `src/store/nodeSession.tsx`：认证、重连、会话生命周期。

Framework / Tron：

- `eliteforge-agent-framework/crates/remote/`：协议、RPC 契约、服务端；
- `Tron/tron-backend/crates/tron-remote-pack/`：Tron pack；
- `Tron/tron-backend/src/application/remote_service.rs`：Tron 接入。

## 已知限制

- 其他产品尚未提供完整 mobile pack。
- 没有 relay / P2P；公网访问要求用户自建隧道。
- 消息暂按纯文本渲染，附件的移动端展示还未完成。
- 公网 WSS 的实际链路取决于用户所选隧道，官方不提供公共中转。

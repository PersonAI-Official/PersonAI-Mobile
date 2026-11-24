# Remote access internals

<p align="center">
  <a href="remote-access.md">简体中文</a> · <b>English</b> · <a href="remote-access.ja.md">日本語</a>
</p>

This document explains how PersonAI Mobile connects to a computer, how traffic is encrypted, and how it chooses between LAN and public endpoints. For product usage, see [README](../README.en.md); for public entry points, see [Self-hosted public tunnel](self-hosted-tunnel.en.md).

## Scope

The current implementation covers:

- the framework's shared remote protocol, RPC contract, and remote server;
- Tron's `tron-remote-pack` and remote entry point;
- PersonAI Mobile's Noise tunnel, pairing, RPC client, and endpoint selection.

Other products use the same framework protocol, but only Tron currently has a complete mobile pack.

## Connection paths

```text
PersonAI Mobile
  ├── LAN:    ws://<lan-ip>:<remote-port>/remote/secure
  └── Public: wss://<public-host>/remote/secure
                    │
                    ▼
              TLS termination (self-hosted FRP / Cloudflare Tunnel / Tailscale / reverse proxy)
                    │
                    ▼
              Tron remote listener (HTTP + WebSocket)
```

Both paths use the same protocol and Noise encryption. Public TLS is only the outer transport; the application layer is still end-to-end encrypted, so the TLS terminator cannot read RPC content.

## Pairing

A pairing QR encodes:

```text
tron://pair?url=<preferred>&lan=<lan-url>&public=<public-url>
  &name=<machine>&product=tron&productName=Tron
  &node=<node-id>&key=<node-public-key>&kid=<fingerprint>&ticket=<ticket>
```

- `url` is the preferred address for older clients; new clients prefer `lan` / `public`.
- `ticket` is a one-time pairing ticket, valid for 300 seconds by default; the server consumes it on first authentication.
- `key` is the computer's static X25519 public key; `kid` is its fingerprint, recomputed and checked by the client.
- On first pairing the phone generates its own X25519 device key and stores the private half in secure storage (SecureStore).
- After pairing, the device is added to the computer's device table. Later connections use the device key for Noise and are identified by device ID or public key; no ticket is needed.

## Transport and encryption

- Noise: `Noise_IK_25519_ChaChaPoly_SHA256`.
- One WebSocket binary frame carries one Noise transport message; the plaintext is a JSON envelope.
- Handshake prologue: `tron-remote\0<nodeId>\0<productCode>\0<lan|public>`.
- The transport nonce is a 12-byte AEAD nonce: the first 4 bytes are zero, the last 8 are a 64-bit little-endian counter. A hand-written Noise client must match `snow`; otherwise `auth` (nonce 0) succeeds but the first ping/RPC (nonce 1) fails to decrypt.
- Application encryption is independent of public TLS. Even if TLS terminates at a reverse proxy, the proxy cannot read session content.

## RPC

Generic session methods:

```text
session.list
session.history
session.create
session.sendMessage
session.stopRun
session.watchEvents
session.unwatchEvents
```

Tron product methods (namespace `tron.*`):

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

Rules:

- `rpc` / `cancel` / `ping` / `pong` / `rpc_result` / `rpc_error` / `rpc_end` / `rpc_event` are envelope types.
- `rpc_event.data` is an AG-UI event verbatim; it is never renamed or wrapped in a second event vocabulary.
- `session.watchEvents` subscribes first, replays history, then follows live events; clients deduplicate by `seq`.
- Streaming calls end with `rpc_end` after `rpc_result`; unknown events are ignored rather than treated as a fatal protocol change.
- Re-entering a session that is still running does not depend on the client that started the run: the chat screen reads `tron.chat.protocolEvents` to find the run with no terminal event, then follows it through `session.watchEvents` (`tailOnly`, skipping the multi-megabyte full replay), and falls back to a 2.5s replay re-read when the product has no event bus. AG-UI cards (tool rail, A2UI surfaces) are rebuilt from that replay plus `tron.chat.a2uiState`.
- `tron.chat.answerUserInput` and `tron.chat.a2uiAction` are one-shot: the node collects the entire resumed run before it answers. The phone therefore subscribes to `session.watchEvents` at submit time and follows that continuation (which may reuse the paused `runCode` or mint a new one); a timeout on the one-shot call means this client stopped waiting, not that the answer was rejected.

## LAN / public endpoint selection

A saved node stores:

```ts
interface SavedNode {
  lanBaseUrl?: string;
  publicBaseUrl?: string;
  baseUrl: string;       // currently active endpoint
  transport: "lan" | "public";
}
```

Selection order:

1. On startup, foreground, or network change, probe LAN first (`tunnel ping`, about 1.2s timeout).
2. If LAN fails, try public.
3. If both fail, mark offline. On success, persist the active `baseUrl` / `transport`.
4. Network changes are observed through `expo-network`, debounced by 600ms; foreground reconnection is handled by `NodeSession`.
5. When the endpoint changes, the session key contains only the node identity, so changing addresses does not clear the current conversation.

## Server endpoints and public policy

The Tron remote listener exposes:

```text
/health
/remote/identity
/remote/secure
```

A public request must satisfy:

- `Host` matches `publicBaseUrl`;
- the request comes from a trusted proxy (loopback by default);
- `X-Forwarded-Proto` contains `https` (or `Forwarded` declares https).

Otherwise the server returns 400. LAN requests are not subject to the public policy, so one node can accept both the home LAN connection and an external public connection.

## Security boundaries

- Pairing tickets are one-time and short-lived; device keys live only in phone secure storage.
- The computer can list paired devices and revoke them remotely.
- Sessions and messages live only in memory and are not written to phone disk.
- The public entry point is user-hosted; traffic does not pass through a Person-AI relay service, so no new trusted third party is introduced.
- There is no P2P / NAT hole punching and no relay; public reachability is provided by the user's own tunnel.

## Code map

Mobile:

- `src/crypto/noise.ts`: Noise IK and transport ciphers;
- `src/api/tunnel.ts`: WebSocket tunnel, RPC, candidate endpoints, probing;
- `src/api/rpc.ts`: RPC wrappers;
- `src/utils/pairing.ts`: QR parsing;
- `src/store/connections.tsx`: nodes and active endpoint;
- `src/store/nodeSession.tsx`: authentication, reconnection, session lifecycle.

Framework / Tron:

- `eliteforge-agent-framework/crates/remote/`: protocol, RPC contract, server;
- `Tron/tron-backend/crates/tron-remote-pack/`: Tron pack;
- `Tron/tron-backend/src/application/remote_service.rs`: Tron wiring.

## Known limitations

- Other products do not yet ship a complete mobile pack.
- There is no relay or P2P; public access requires a self-hosted tunnel.
- Messages are plain text; mobile attachment rendering is not finished.
- The actual public WSS path depends on the tunnel you choose; no public relay is provided.

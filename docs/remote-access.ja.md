# リモートアクセス技術資料

<p align="center">
  <a href="remote-access.md">简体中文</a> · <a href="remote-access.en.md">English</a> · <b>日本語</b>
</p>

PersonAI Mobile が PC へ接続する方法、暗号化、LAN とインターネットの経路選択について説明します。製品としての使い方は [README](../README.ja.md)、インターネット入口の設定は[自前のインターネットトンネル](self-hosted-tunnel.ja.md)を参照してください。

## 対象範囲

現在の実装：

- framework の共有 remote プロトコル、RPC 契約、リモートサーバー；
- Tron の `tron-remote-pack` とリモート入口；
- PersonAI Mobile の Noise トンネル、ペアリング、RPC クライアント、経路選択。

他のプロダクトも同じ framework プロトコルを使えますが、完全な mobile pack を提供しているのは現時点では Tron のみです。

## 接続経路

```text
PersonAI Mobile
  ├── LAN:    ws://<lan-ip>:<remote-port>/remote/secure
  └── インターネット:   wss://<public-host>/remote/secure
                    │
                    ▼
              TLS 終端（自前 FRP / Cloudflare Tunnel / Tailscale / リバースプロキシ）
                    │
                    ▼
              Tron remote listener（HTTP + WebSocket）
```

どちらも同じプロトコルと Noise 暗号化を使います。インターネット側 TLS は外側の転送だけで、アプリケーション層はエンドツーエンド暗号化されています。TLS 終端側は RPC 内容を読めません。

## ペアリング

QR コード：

```text
tron://pair?url=<preferred>&lan=<lan-url>&public=<public-url>
  &name=<machine>&product=tron&productName=Tron
  &node=<node-id>&key=<node-public-key>&kid=<fingerprint>&ticket=<ticket>
```

- `url` は旧クライアント向けの優先アドレスです。新しいクライアントは `lan` / `public` を優先します。
- `ticket` は 1 回限りのペアリングチケットで、既定 300 秒有効です。初回認証でサーバーが消費します。
- `key` は PC の静的 X25519 公開鍵、`kid` はその指紋です。クライアントが再計算して照合します。
- 初回ペアリング時にスマートフォン側で X25519 デバイス鍵を生成し、秘密鍵をセキュアストレージ（SecureStore）に保存します。
- ペアリング後、デバイスは PC のデバイステーブルに登録されます。以降はチケット不要で、デバイス鍵による Noise ハンドシェイクとデバイス ID／公開鍵で識別します。

## 転送と暗号化

- Noise：`Noise_IK_25519_ChaChaPoly_SHA256`。
- WebSocket のバイナリフレーム 1 つが Noise 転送メッセージ 1 つに対応し、平文は JSON envelope です。
- ハンドシェイク prologue：`tron-remote\0<nodeId>\0<productCode>\0<lan|public>`。
- 転送 nonce は 12 バイトの AEAD nonce です。先頭 4 バイトが 0、後ろ 8 バイトが 64 ビット little-endian カウンタです。手書きの Noise クライアントは `snow` と一致させる必要があります。一致しない場合、`auth`（nonce 0）は成功しても最初の ping/RPC（nonce 1）が復号に失敗します。
- アプリケーション暗号化はインターネット側 TLS とは独立しています。TLS がリバースプロキシで終端しても、プロキシは会話内容を読めません。

## RPC

汎用セッション API：

```text
session.list
session.history
session.create
session.sendMessage
session.stopRun
session.watchEvents
session.unwatchEvents
```

Tron 製品 API（`tron.*` 名前空間）：

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

規約：

- `rpc` / `cancel` / `ping` / `pong` / `rpc_result` / `rpc_error` / `rpc_end` / `rpc_event` が envelope 種別です。
- `rpc_event.data` は AG-UI イベントそのものです。名前を変えたり、別のイベント語彙で包んだりしません。
- `session.watchEvents` は購読、履歴 replay、ライブイベントの順で流れます。クライアントは `seq` で重複排除します。
- ストリーミング呼び出しは `rpc_result` の後に `rpc_end` で終了します。未知のイベントは無視し、致命的なプロトコル変更とは扱いません。
- まだ実行中のセッションを再び開いても、画面は run を開始したクライアントに依存しません。`tron.chat.protocolEvents` で終端イベントのない run を特定し、`session.watchEvents`（`tailOnly`、巨大な全量 replay をスキップ）でライブイベントに追随します。イベントバスを持たない商品は 2.5s ごとに replay を読み直します。AG-UI カード（ツールトレイル、A2UI surface）は replay と `tron.chat.a2uiState` から復元します。
- `tron.chat.answerUserInput` と `tron.chat.a2uiAction` は one-shot です。ノードは再開後の実行全体を集め終えてから応答します。そのためスマホは送信の瞬間に `session.watchEvents` を購読してその再開を追跡します（runCode を流用する場合も、新しく採番する場合もあります）。one-shot のタイムアウトは「このクライアントが待つのをやめた」意味で、回答が不採用になった意味ではありません。

## LAN / インターネットの経路選択

保存ノード：

```ts
interface SavedNode {
  lanBaseUrl?: string;
  publicBaseUrl?: string;
  baseUrl: string;       // 現在のアクティブ経路
  transport: "lan" | "public";
}
```

選択順：

1. 起動時、フォアグラウンド復帰時、ネットワーク変化時に LAN を先に probe（`tunnel ping`、約 1.2 秒タイムアウト）。
2. LAN が失敗したら public を試す。
3. 両方失敗ならオフライン。成功したらアクティブな `baseUrl` / `transport` を保存。
4. ネットワーク変化は `expo-network` で監視し、600ms デバウンス。フォアグラウンド復帰は `NodeSession` が再接続。
5. 経路が変わっても、セッションキーはノード identity のみを含むため、現在の会話内容は消えません。

## サーバー入口とインターネット公開ポリシー

Tron remote listener：

```text
/health
/remote/identity
/remote/secure
```

インターネットからのリクエストの条件：

- `Host` が `publicBaseUrl` と一致する；
- 信頼できるプロキシから来ている（既定は loopback）；
- `X-Forwarded-Proto` に `https` が含まれる（または `Forwarded` が https を宣言）。

満たさない場合は 400 を返します。LAN リクエストはインターネット公開ポリシーの対象外なので、同じノードが自宅 LAN と外部インターネットの両方を受け付けられます。

## セキュリティ境界

- ペアリングチケットは 1 回限り・短時間有効。デバイス鍵はスマートフォンのセキュアストレージのみ。
- PC 側でペアリング済みデバイスを一覧表示し、リモート失効できます。
- セッションとメッセージはメモリのみで、スマートフォンのディスクには書きません。
- インターネット入口はユーザーが用意し、Person-AI の中継サービスを経由しません。新たな信頼済み第三者を増やしません。
- P2P / NAT ホールパンチングや relay はありません。インターネット到達性はユーザーのトンネルに依存します。

## コードの場所

Mobile：

- `src/crypto/noise.ts`：Noise IK と転送 cipher；
- `src/api/tunnel.ts`：WebSocket トンネル、RPC、候補経路、probe；
- `src/api/rpc.ts`：RPC ラッパー；
- `src/utils/pairing.ts`：QR 解析；
- `src/store/connections.tsx`：ノードとアクティブ経路；
- `src/store/nodeSession.tsx`：認証、再接続、セッション生命周期。

Framework / Tron：

- `eliteforge-agent-framework/crates/remote/`：プロトコル、RPC 契約、サーバー；
- `Tron/tron-backend/crates/tron-remote-pack/`：Tron pack；
- `Tron/tron-backend/src/application/remote_service.rs`：Tron 接続。

## 既知の制限

- 他のプロダクトは完全な mobile pack をまだ提供していません。
- relay / P2P はありません。インターネット経由のアクセスには自前トンネルが必要です。
- メッセージはプレーンテキスト表示で、添付ファイルのモバイル表示は未完成です。
- 実際のインターネット側 WSS 経路は選択したトンネルに依存します。公式の公共中継はありません。

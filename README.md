# shogi tv

[lishogi](https://lishogi.org/tv) で配信中の注目対局を観戦しながら、**ブラウザの中で動く WASM 将棋エンジン (YaneuraOu)** がリアルタイムに評価値・候補手・読み筋を計算してくれる Web アプリです。サーバを介さずにすべてブラウザ単独で完結します。

🌐 公開先: <https://tkihira.github.io/shogitv/>

## できること

- **lishogi TV のリアルタイム観戦**: 配信中の注目対局を SSE (`/api/tv/feed`) で受け取り、盤面・最終手・持駒を即時反映。注目対局が切り替わったら自動的に追従します。
- **正確な残り時間表示**: 各手の消費時間を `/game/export/{id}?clocks=1` (KIF) から取得し、ローカルで 1Hz の tick + 5 秒ごとのサーバ同期。秒読み突入も検出。
- **終局検知**: 投了 / 切れ負け / 詰み / 引き分け / 反則 を KIF の終局行から判定し、勝敗を盤の下にバナー表示。
- **WASM 将棋エンジンによる評価値**: 1 手ごとに `position sfen ... go movetime 1500` をエンジンへ投げ、評価値・読み筋を主候補手 + MultiPV 第二・第三候補まで取得。
- **読み筋の日本語表記**: USI 表記 (`7g7f`) を `▲７六歩` のような棋譜表記に変換。`同`、成、打、ぶつかり時の `上 / 寄 / 引` 区別、▲△ も対応。
- **評価値の 4 段階分類**: cp 値の絶対値で **互角 (≤300) / 有利 (≤800) / 優勢 (≤1500) / 勝勢 (>1500 または mate)** を判定。
- **モバイル対応**: 縦持ち・横持ちで個別レイアウト。盤面のすぐ右に縦の評価バーを置き、視線移動を最小化。

## 技術スタック

### フロントエンド

| ライブラリ | 役割 |
|---|---|
| [Vite](https://vite.dev/) + [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | バンドラ / 開発サーバ |
| [React 19](https://react.dev/) + TypeScript | UI |
| [shogiground](https://github.com/WandererXII/shogiground) | 盤面描画 (lishogi 公式) |
| [shogiops](https://github.com/WandererXII/shogiops) | SFEN/USI parse、`makeJapaneseMoveOrDrop` で日本語棋譜化 |
| [@mizarjp/yaneuraou.k-p](https://www.npmjs.com/package/@mizarjp/yaneuraou.k-p) | YaneuraOu (NNUE K-P) の WASM ビルド |
| [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | COOP/COEP ヘッダを Service Worker で擬似注入 (GH Pages 用) |
| [@vitejs/plugin-basic-ssl](https://github.com/vitejs/vite-plugin-basic-ssl) | 開発サーバ用の自己署名 HTTPS (iPhone Safari 検証用) |

### データソース (lishogi 公開 API)

すべて `Access-Control-Allow-Origin: *` のドキュメント API のみを使用しています。

| エンドポイント | 用途 | 形式 |
|---|---|---|
| `/api/tv/feed` | SSE で sfen + 最終手 + featured (注目対局切替) | text/event-stream |
| `/api/tv/channels` | 初回ロード時に注目対局 ID を取得 | JSON |
| `/api/game/{id}` | 両対局者の名前・レーティング・clock 設定 | JSON |
| `/game/export/{id}?clocks=1` | KIF 形式で各手の消費時間を取得 (時計同期 + 終局判定) | text/plain (KIF) |
| `/game/export/{id}` | USI 移動列を取得 (リプレイ用、初期局面復元) | JSON |

### 将棋エンジン

- **エンジン本体**: YaneuraOu NNUE K-P (Suisho 系評価関数同梱、`@mizarjp/yaneuraou.k-p` パッケージ、約 1.4MB の wasm)
- **実行環境**: 普通の Web Worker 内で `importScripts` してロード (`public/engine/worker-host.js`)
- **マルチスレッド**: `crossOriginIsolated === true` の時のみ pthread スレッドを `min(4, CPU - 1)` で起動。それ以外は Threads=1 でフォールバック
- **USI プロトコル**: `usi` / `isready` / `position sfen ... 1` / `go movetime 1500` / `stop` を main ↔ worker 間 postMessage で会話
- **MultiPV=3** で主候補手・次善手・第三候補を同時計算

### COOP/COEP / SharedArrayBuffer

YaneuraOu.wasm は SharedArrayBuffer (= マルチスレッド) を要求するため、ページが [crossOriginIsolated](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated) でなければ動きません。

- **dev**: `vite.config.ts` の `server.headers` で `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` を付与
- **prod (GitHub Pages)**: GH Pages はカスタムヘッダ非対応のため、`coi-serviceworker.js` を読み込み Service Worker 側でヘッダを擬似注入。SW 登録 → ページ自動 reload で隔離コンテキスト確立
- **iOS Safari の SW 半壊状態リカバリ**: SAB が undefined のまま残るバグ対策として、`index.html` の inline スクリプトで「SW 登録済 + SAB 無し」を検出したら全 SW を unregister + reload（最大 3 回まで）

### ロバスト性

- **SSE ゾンビ接続検知**: `/api/tv/feed` の SSE が無音でハングする現象を検出するため、`useClocks` の 5 秒ポーリングが「export では新しい手が見えるのに SSE は 12 秒以上沈黙」と判定したら **強制再接続 + リプレイで局面復旧**
- **対局切替時のスクロール位置保持**: TV 切替で DOM が一時収縮することによりブラウザがスクロール位置をクランプして「先頭に戻る」現象を、`useLayoutEffect` cleanup でスクロール Y を保存 + 0/50/150/350/700ms の rAF で復元
- **iOS Safari の駒ずれ修正**: shogiground が二重に `.sg-wrap` クラスを付与する挙動 + サブピクセル計算のずれで、右側の駒ほど左にずれる現象を、CSS の `round(down, …, 9px)` で盤の cell 幅を整数 px にスナップして解消

### ライブラリ構成図

```
┌────────────────────────────────────────────────────┐
│ Browser                                            │
│                                                    │
│  ┌─────────────────────────────────────────────┐   │
│  │ React (Vite, TS)                            │   │
│  │  ├ useTvFeed   ←  SSE /api/tv/feed          │   │
│  │  ├ useClocks   ←  /game/export/{id}?clocks=1│   │
│  │  ├ useEngine   →  Worker (USI postMessage)  │   │
│  │  └ Components: Board, Clocks, EvalBar,      │   │
│  │                EvalScore, GameHeader …      │   │
│  └─────────────────────────────────────────────┘   │
│                          ↓                         │
│  ┌──────────────────────────┐  ┌─────────────────┐ │
│  │ Engine Worker            │  │ coi-serviceworker│ │
│  │  worker-host.js          │  │ COOP/COEP 注入  │ │
│  │   └ YaneuraOu.wasm       │  │                 │ │
│  │     (MultiPV=3, threads) │  │                 │ │
│  └──────────────────────────┘  └─────────────────┘ │
└────────────────────────────────────────────────────┘
       ↓ HTTP / SSE
┌────────────────────────────────────────────────────┐
│ lishogi.org                                        │
│   /api/tv/feed              ← SSE (sfen, featured) │
│   /api/tv/channels          ← 注目対局 ID          │
│   /api/game/{id}            ← player + clock 設定  │
│   /game/export/{id}?clocks=1 ← KIF (消費時間)      │
│   /game/export/{id}          ← JSON (moves)        │
└────────────────────────────────────────────────────┘
```

## ローカル開発

```sh
# 依存導入
npm install

# 開発サーバ (HTTPS、自己署名証明書、LAN にも公開)
npm run dev
# → https://localhost:5173/  (PC)
# → https://192.168.x.x:5173/  (LAN 内の他端末から)

# 型検査 + 本番ビルド
npm run build

# ビルド済みの dist/ をローカルで配信
npm run preview

# GitHub Pages に dist/ を発行 (gh-pages ブランチへ push)
npm run deploy
```

iPhone 等の他端末から開く場合は `npm run dev` 起動時に出る Network URL (`https://<IP>:<PORT>/`) を打ち、自己署名証明書の警告を一度承認してください。

### ディレクトリ構成

```
shogitv/
├ public/
│  ├ coi-serviceworker.js      ← COOP/COEP SW
│  ├ favicon.svg
│  └ engine/                   ← scripts/copy-engine.mjs が自動コピー
│     ├ worker-host.js          (手書き、エンジン用 Web Worker)
│     ├ yaneuraou.k-p.js        (npm パッケージから)
│     ├ yaneuraou.k-p.wasm
│     └ yaneuraou.k-p.worker.js
├ scripts/
│  ├ copy-engine.mjs           ← npm 起動時に engine/ を public/ に同期
│  └ deploy-gh-pages.mjs       ← `npm run deploy` の本体
├ src/
│  ├ App.tsx
│  ├ main.tsx
│  ├ index.css                 ← 全 CSS
│  ├ components/
│  │  ├ Board.tsx              (shogiground ラッパ)
│  │  ├ Clocks.tsx             (ClockRow, ClockMeta, GameResultBanner)
│  │  ├ EvalBar.tsx            (盤の隣の縦バー)
│  │  ├ EvalScore.tsx          (評価値 + 3 PV リスト)
│  │  └ GameHeader.tsx
│  ├ engine/
│  │  ├ engineClient.ts        (Worker との USI 会話)
│  │  ├ pvNotation.ts          (USI 列 → 日本語棋譜変換)
│  │  └ usi.ts                 (info 行パーサ)
│  ├ feed/
│  │  ├ tvFeed.ts              (SSE クライアント)
│  │  ├ tvChannels.ts          (/api/tv/channels)
│  │  ├ gameInfo.ts            (/api/game/{id})
│  │  ├ gameExport.ts          (KIF パース)
│  │  └ replayMoves.ts         (USI list → SFEN)
│  └ hooks/
│     ├ useTvFeed.ts
│     ├ useClocks.ts
│     └ useEngine.ts
├ index.html                   ← OGP, coi-serviceworker, SAB recovery
├ vite.config.ts
└ LICENSE                      ← GNU GPL-3.0
```

## ライセンス

**GPL-3.0-or-later**。

YaneuraOu (`@mizarjp/yaneuraou.k-p`) が GPL-3.0、`shogiground` / `shogiops` が GPL-3.0-or-later のため、結合著作物である本アプリも GPL の下で配布されます。

詳細は同梱の [`LICENSE`](./LICENSE) を参照してください。

## 謝辞

- [lishogi](https://lishogi.org/) — TV 対局の配信および公開 API
- [YaneuraOu](https://github.com/yaneurao/YaneuraOu) — 将棋エンジン本体
- [@mizarjp/yaneuraou.wasm](https://github.com/mizar/YaneuraOu.wasm) — Emscripten による WASM 化
- [shogiground](https://github.com/WandererXII/shogiground) / [shogiops](https://github.com/WandererXII/shogiops) — lishogi の盤・ロジックライブラリ
- 評価関数 (Suisho 系): [たややん＠水匠(将棋AI)](https://twitter.com/tayayan_ts) (本パッケージ同梱版)
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) — Guido Zuidhof 氏ら

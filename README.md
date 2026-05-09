# Shogi TV

[lishogi](https://lishogi.org/tv) で配信中の注目対局を観戦しながら、**ブラウザの中で動く WASM 将棋エンジン (YaneuraOu)** がリアルタイムに評価値・候補手・読み筋を計算してくれる Web アプリです。サーバを介さずにすべてブラウザ単独で完結します。

🌐 公開先: <https://shogitv.vercel.app/>

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
```

### 本番デプロイ (Vercel)

リポジトリを Vercel に連携すれば `git push` でビルド & デプロイされます。Vercel は `vercel.json` の `headers` 設定を読んで COOP/COEP を付与するので、Service Worker 等の追加対応は不要です。

CLI で手動デプロイする場合:

```sh
npx vercel --prod
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

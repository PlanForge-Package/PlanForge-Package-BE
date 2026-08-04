<div align="center">

# PlanForge BE

**ホテル管理プラットフォームの業務ロジックサーバー**

予約・フロントデスク・ハウスキーピング・会計・POS・客室キーを扱います。OPERA への書き込みは
Core に委譲し、結果をミラーリングします。

[한국어](README.md) · [English](README.en.md) · [中文](README.zh.md) · **日本語**

![TypeScript](https://img.shields.io/badge/TypeScript-83.2%25-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5.1%25-2D3748?style=flat-square&logo=prisma&logoColor=white)
![SQL](https://img.shields.io/badge/SQL-3.7%25-336791?style=flat-square&logo=postgresql&logoColor=white)
![Markdown](https://img.shields.io/badge/Markdown-3.1%25-083FA1?style=flat-square)
![YAML](https://img.shields.io/badge/YAML-2.0%25-CB171E?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-0.5%25-2496ED?style=flat-square&logo=docker&logoColor=white)

</div>

---

## プロジェクト背景

Oracle OPERA を使うホテルで、**PMS を置き換えずにその上へ運用ツールを載せる**ことが目的です。
予約・在庫・料金の記録の源泉は OPERA であり、BE はその写しを持ちつつ実務に必要なものを足します。

境界は明確です。

| OPERA が所有 | PlanForge が所有 |
| --- | --- |
| 予約・在庫・料金・確認番号 | ハウスキーピングの作業割当 |
| ゲストプロファイルの氏名・連絡先 | 嗜好・内部メモ |
| ブロック在庫とピックアップ | POS アウトレットキー・客室キー履歴 |
| 営業日 | スタッフアカウント・権限 |

**すべての書き込みは OPERA に先に反映し、返ってきた値でローカルを埋めます。** 送った値を書くと
OPERA が調整した結果を取りこぼします。ローカルのレコードは一覧・検索を速くするためのキャッシュ
です。

### プラットフォーム構成

| リポジトリ | 役割 |
| --- | --- |
| [PlanForge-Package-FE](https://github.com/PlanForge-Package/PlanForge-Package-FE) | 運営・フロントデスク Web UI |
| **PlanForge-Package-BE** | **業務ロジック・自前データベース** |
| [PlanForge-Package-Core](https://github.com/PlanForge-Package/PlanForge-Package-Core) | Oracle OPERA（OHIP）連携 API サーバー |

呼び出し経路：`FE → BE → Core → OPERA Cloud (OHIP)`

---

## 言語とスタック

| 区分 | 技術 |
| --- | --- |
| 言語 | TypeScript 5.9（strict） |
| ランタイム | Node.js 20.11+ |
| フレームワーク | NestJS 10 |
| データベース | PostgreSQL 16 |
| ORM | Prisma 6 —— マイグレーション駆動のスキーマ管理 |
| 認証 | JWT（`@nestjs/jwt`）・bcryptjs・グローバルガード |
| バリデーション | class-validator・class-transformer（whitelist · forbidNonWhitelisted） |
| レート制限 | `@nestjs/throttler` —— ログインは 5 分 10 回で別途制限 |
| API ドキュメント | `@nestjs/swagger`（`/docs`） |
| テスト | Jest —— 237 件 |
| 品質 | ESLint・Prettier・GitHub Actions |
| デプロイ | Docker・docker-compose |
| パッケージ管理 | pnpm 9 |

---

## ディレクトリ構成

```
prisma/
├── schema.prisma                 データモデル（OPERA の概念に準拠）
├── migrations/                   マイグレーション履歴
└── seed.ts                       冪等シード —— ホテル 2 件・役割別アカウント・予約

src/
├── auth/                         ログイン・JWT ガード・ロールガード・ログインスロットル
├── users/                        アカウント管理（入社・役割・所属・退社）
├── properties/
│   ├── property-scope.ts         複数ホテルのアクセス境界 —— 分離の核心
│   └── properties.service.ts     ホテル・客室タイプ
├── core/                         Core（OHIP）HTTP クライアント・エラー変換
├── reservations/
│   ├── booking.service.ts        作成・変更・取消・ノーショー —— 委譲後にミラーリング
│   └── reservations.service.ts   一覧・チェックイン・チェックアウト
├── blocks/                       団体ブロック・ルーミングリスト
├── profiles/                     ゲストプロファイル・嗜好・重複統合
├── folios/                       フォリオ・取引登録
├── payments/
│   ├── payment.driver.ts         決済代行ドライバーのインターフェース
│   ├── mock-payment.driver.ts    モック決済代行
│   └── payments.service.ts       オーソリ・売上確定・取消・返金
├── pos/
│   ├── pos-key.guard.ts          アウトレット API キー認証
│   ├── pos.service.ts            ルームチャージ・取消（重複防止）
│   └── outlets.service.ts        アウトレット発行・再発行・停止
├── doorlock/
│   ├── doorlock.driver.ts        施錠装置ドライバーのインターフェース
│   ├── mock-doorlock.driver.ts   モック施錠装置
│   ├── local-time.ts             ホテル現地時刻 → UTC
│   └── doorlock.service.ts       カード発行・無効化・自動回収
├── housekeeping/                 作業割当・客室ステータス・不一致検出
├── night-audit/                  締めチェックリスト・ノーショー
├── reports/                      稼働率・ADR・RevPAR・チャネル別内訳
├── rooms/                        客室一覧・ステータス集計
├── sync/                         OPERA 予約同期・マッパー
└── main.ts
```

---

## 実行方法

### 必要環境

- Node.js 20.11 以上
- pnpm 9
- PostgreSQL 16
- 起動中の [PlanForge Core](https://github.com/PlanForge-Package/PlanForge-Package-Core)

### インストールと起動

```bash
pnpm install
cp .env.example .env          # DATABASE_URL · JWT_SECRET · CORE_BASE_URL を設定

pnpm prisma:deploy            # マイグレーション適用
pnpm prisma:seed              # シードデータ
pnpm start:dev
```

| URL | 用途 |
| --- | --- |
| `http://localhost:3001/api` | API |
| `http://localhost:3001/docs` | Swagger UI |
| `http://localhost:3001/api/health` | ヘルスチェック（認証不要） |

### シードアカウント

パスワードはすべて `planforge`（`SEED_PASSWORD` で変更可）。

| メール | 役割 | 所属 |
| --- | --- | --- |
| `admin@planforge.local` | ADMIN | 本社（全ホテル） |
| `manager@planforge.local` | MANAGER | PlanForge Seoul |
| `frontdesk@planforge.local` | FRONT_DESK | PlanForge Seoul |
| `housekeeping@planforge.local` | HOUSEKEEPING | PlanForge Seoul |

### 主なコマンド

| コマンド | 説明 |
| --- | --- |
| `pnpm start:dev` | 開発サーバー（watch） |
| `pnpm build` / `pnpm start:prod` | ビルド / 本番実行 |
| `pnpm test` / `pnpm test:cov` | Jest |
| `pnpm prisma:deploy` / `pnpm prisma:seed` | マイグレーション / シード |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | 品質チェック |

### 環境変数

| 名前 | 説明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 接続文字列 |
| `JWT_SECRET` | **32 文字以上。** 短いと起動を拒否します |
| `JWT_EXPIRES_IN` | トークン有効期間（既定 `12h`） |
| `CORE_BASE_URL` | Core API のアドレス（既定 `http://localhost:3002`） |
| `CORE_API_KEY` | Core の `SERVICE_API_KEY` と同じ値 |
| `DOORLOCK_MODE` | `mock` \| `live` —— 既定は `mock` |
| `PAYMENT_MODE` | `mock` \| `live` —— 既定は `mock` |
| `SEED_PASSWORD` | シードアカウントのパスワード（8 文字以上） |

`NODE_ENV=production` で `DOORLOCK_MODE`・`PAYMENT_MODE` が `live` でない場合は**起動を拒否
します。** フロントがカードを発行したと信じているのに客室に入れない、決済されたと信じているのに
入金がない —— それが最悪の事態です。

### デプロイ

```bash
cd deploy && docker compose up -d
```

`deploy/docker-compose.yml` が PostgreSQL・Core・BE・FE をまとめて起動します。Core は内部
ネットワークのみに置き、ポートを公開しません。

---

## 提供エンドポイント

<details>
<summary><b>認証・アカウント・ホテル</b></summary>

| メソッド | パス | 説明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | ログイン（公開） |
| `GET` | `/api/auth/me` | 現在のアカウント |
| `POST` | `/api/auth/change-password` | 本人のパスワード変更 |
| `GET` `POST` | `/api/users` | アカウント一覧・作成（ADMIN） |
| `PATCH` | `/api/users/:id` | 役割・所属・在籍（ADMIN） |
| `POST` | `/api/users/:id/password` | パスワード初期化（ADMIN） |
| `GET` | `/api/properties` | アクセス可能なホテル |
| `GET` | `/api/properties/:id/room-types` | ホテルの客室タイプ |
| `POST` `PATCH` | `/api/properties` | ホテル登録・変更（ADMIN） |
| `GET` | `/api/health` | サービス・DB 状態（公開） |

</details>

<details>
<summary><b>予約・フォリオ・決済</b></summary>

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/reservations` | 予約一覧（状態・チャネル・検索） |
| `GET` | `/api/reservations/summary` | 当日の到着・出発・在館 |
| `GET` | `/api/reservations/:id` | 予約単件（フォリオ含む） |
| `POST` | `/api/reservations/:id/check-in` | チェックイン —— 客室割当・フォリオ開設 |
| `POST` | `/api/reservations/:id/confirm-waitlist` | ウェイトリスト確定（OPERA へ委譲） |
| `POST` | `/api/reservations/:id/share` `\|` `/unshare` | 客室シェア・解除 |
| `POST` | `/api/reservations/:id/check-out` | チェックアウト —— フォリオ締め・客室返却 |
| `GET` `POST` | `/api/reservations/:id/folios` | フォリオ照会・ウィンドウ追加 |
| `POST` | `/api/reservations/:id/folios/:window/postings` | 請求・入金の登録 |
| `POST` | `/api/reservations/:id/folios/postings/:postingId/transfer` | 取引を別ウィンドウへ移管 |
| `GET` `POST` | `/api/reservations/:id/folios/routings` | ルーティング指示の照会・設定 |
| `DELETE` | `/api/reservations/:id/folios/routings/:transactionCode` | ルーティング指示の解除 |
| `GET` | `/api/reservations/:id/payments` | 決済履歴 |
| `POST` | `/api/reservations/:id/folios/:window/payments` | オーソリ |
| `POST` | `/api/payments/:id/capture` `\|` `/void` | 売上確定・オーソリ取消 |
| `POST` | `/api/payments/:id/refund` | 返金（MANAGER） |
| `GET` | `/api/cashier/shifts/current` | 開いている自分のシフトと集計 |
| `GET` | `/api/cashier/shifts` `\|` `/api/cashier/shifts/:id` | 過去のシフト・詳細 |
| `POST` | `/api/cashier/shifts` | シフト開始（釣銭準備金） |
| `POST` | `/api/cashier/shifts/:id/close` | 締め —— 過不足を残します |
| `GET` | `/api/traces` | 日付・部署別のトレース |
| `GET` `POST` | `/api/reservations/:id/traces` | 予約のトレース照会・登録 |
| `PATCH` | `/api/traces/:id/complete` | 処理済みにする |
| `DELETE` | `/api/traces/:id` | 取り下げ（未処理のみ） |

</details>

<details>
<summary><b>後払い取引先 (AR・シティレジャー)</b></summary>

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/ar/accounts` | 取引先一覧 — 残高付き |
| `GET` | `/api/ar/accounts/:id` | 取引先詳細 — 残高・元帳・請求書 |
| `POST` `PATCH` | `/api/ar/accounts` | 取引先の登録・修正 (MANAGER) |
| `POST` | `/api/reservations/:id/ar/transfer` | フォリオ残高を取引先へ振替 — OPERA のフォリオも空にします |
| `POST` | `/api/ar/accounts/:id/payments` | 入金の記録 (MANAGER) |
| `POST` | `/api/ar/accounts/:id/invoices` | 未請求の取引をまとめて請求書を発行 (MANAGER) |
| `GET` | `/api/ar/invoices/:id` | 請求書詳細 |
| `PATCH` | `/api/ar/invoices/:id/status` | 状態変更 — 無効に戻すと取引が解放されます (MANAGER) |

</details>

<details>
<summary><b>団体・プロファイル・客室キー</b></summary>

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/blocks` | 団体ブロック一覧 |
| `GET` | `/api/blocks/:id` | ブロック詳細 —— 日付別の割当とピックアップ |
| `GET` | `/api/blocks/:id/reservations` | ルーミングリスト |
| `POST` `PATCH` | `/api/blocks` | ブロック作成・変更（MANAGER） |
| `GET` | `/api/profiles` | プロファイル検索 |
| `GET` | `/api/profiles/:id` | プロファイル詳細 —— 宿泊履歴 |
| `GET` | `/api/profiles/:id/duplicates` | 重複候補とその根拠 |
| `PATCH` | `/api/profiles/:id` | 嗜好・会員・メモ |
| `POST` | `/api/profiles/:id/merge` | 重複統合（MANAGER） |
| `GET` `POST` | `/api/reservations/:id/keys` | 客室キー履歴・発行 |
| `POST` | `/api/door-keys/:keyId/revoke` | 客室キーの無効化 |

</details>

<details>
<summary><b>ハウスキーピング・ナイトオーディット・実績・POS</b></summary>

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/rooms` `\|` `/api/rooms/summary` | 客室一覧・ステータス集計 |
| `GET` `POST` | `/api/housekeeping/tasks` | 当日の作業・生成 |
| `PATCH` | `/api/housekeeping/tasks/:id[/assign]` | 割当・進捗 |
| `PATCH` | `/api/housekeeping/rooms/:id/status` | 客室ステータス（OPERA へ委譲） |
| `GET` | `/api/room-outages` | 使用不可客室の一覧 |
| `POST` | `/api/room-outages` | 使用不可の登録（OPERA へ委譲） |
| `DELETE` | `/api/room-outages/:id` | 使用不可の解除（OPERA へ委譲） |
| `GET` | `/api/housekeeping/discrepancies` | ステータスと在館の不一致 |
| `GET` | `/api/night-audit` | 締めチェックリスト |
| `POST` | `/api/night-audit/reservations/:id/no-show` | ノーショー処理 |
| `GET` | `/api/rates/quote` | 期間料金 — 日別単価・パッケージ |
| `GET` `POST` | `/api/rates/plans` | 料金コード一覧・登録 (MANAGER) |
| `GET` `PATCH` | `/api/rates/plans/:ratePlanCode` | 料金コード単件・修正 |
| `POST` | `/api/rates/plans/:ratePlanCode/seasons` | シーズン料金の追加 — 期間・曜日 (MANAGER) |
| `DELETE` | `/api/rates/plans/:ratePlanCode/seasons/:seasonId` | シーズン料金の削除 (MANAGER) |
| `GET` `POST` | `/api/rates/packages` | パッケージ一覧・登録 (MANAGER) |
| `PATCH` | `/api/rates/packages/:packageCode` | パッケージ修正 (MANAGER) |
| `GET` | `/api/reports/daily` | 稼働率・ADR・RevPAR・チャネル別内訳（MANAGER） |
| `GET` | `/api/reports/journal` | 締め仕訳 — 取引コード別の売上・税額と収納照合 (MANAGER) |
| `GET` `POST` `PATCH` | `/api/pos-outlets` | POS アウトレット管理（MANAGER） |
| `GET` `POST` | `/api/pos/rooms` `\|` `/api/pos/charges[/void]` | ルームチャージ（アウトレットキー） |
| `POST` `GET` | `/api/sync/reservations` `\|` `/api/sync/logs` | OPERA 同期・履歴 |

</details>

---

## 設計判断

### 認証と権限

`@Public()` が付いていない**すべて**のルートが有効な Bearer トークンを要求します。ホワイト
リストではなく既定を「保護済み」にした理由は、新しいコントローラーを追加するときに保護を忘れる
方がはるかに危険だからです。公開ルートは `/api/auth/login` と `/api/health` のみです。

`property-scope.ts` が複数ホテル分離のすべてです。所属が指定されたアカウントは他ホテルの資料に
触れられず、一覧は自動的に絞られ、単件照会でも範囲を確認します —— 確認番号や URL が漏れただけで
他ホテルの予約が開いてはいけません。

### チェックイン・チェックアウト

客室割当・予約状態・フォリオが同時に成立する必要があるため、ひとつのトランザクションで処理
します。在館中の客室の重複割当、販売不可の客室への割当、未収残高がある状態でのチェックアウトは
拒否します。

### ナイトオーディット

**締めそのものは OPERA が回します** —— 営業日を進めて室料・税を自動計上するのは PMS の仕事で、
真似れば二つのシステムで売上が割れます。`/api/night-audit` が行うのは**「いま締めたら何が
おかしく残るか」**を示すことです：未到着・未チェックアウト・在館なのに客室未割当・残高が残った
フォリオ・客室ステータスの不一致。

### 実績

二種類の売上をはっきり分けます。

- **客室売上（契約ベース）** —— 予約総額を泊数で按分した値。稼働率・ADR・RevPAR の根拠
- **フォリオ請求（実計上）** —— フォリオに載った請求・入金・調整。チェックイン以降にのみ発生

混ぜると「なぜ売上が違うのか」を誰も説明できなくなります。精算照合にはポスティングを、販売指標
には契約ベースを使います。`Posting.amount` は保存時点で符号が付いている（入金は負）ため、未収は
単純な合計です。

稼働率の分母は**現在**故障・販売停止でない客室数です。過去時点の故障履歴は残さないため、その
時点の実際の販売可能数とは異なり得ます。この根拠はレスポンスと画面の双方に明記します。

### ゲストプロファイル

氏名・連絡先は OPERA プロファイルの写しであり、**嗜好・内部メモは PlanForge が所有します。**
嗜好は自由テキストではなくコードで保存します —— テキストにすると「高層」「高い階」「high floor」
が混在し、割当の際に誰も絞り込めません。

統合では元を削除しません。過去の予約が参照しており、削除するとその滞在からゲストが消えます。
双方が OPERA プロファイルの場合は Core を経由して **OPERA 側で先に統合します** —— ローカルだけ
統合すると次の同期で消した側が復活します。OPERA が拒否した場合はローカルも一切変更しません。

### 客室キー（ドアロック）

施錠装置はベンダーごとにプロトコルがまったく異なります —— Assa Abloy（Vingcard）・Salto・Onity
はカードのエンコード方式も接続方式も噛み合いません。そのためドメインが知るのは
`DoorLockDriver` インターフェースだけで、実際の通信は実装ファイル 1 本に閉じ込めます。

最も危険な失敗は**カードが生きたまま忘れられること**です。チェックアウトした客のカードが、次の
客が入った部屋を開けます。そこでチェックアウトと客室変更が残ったカードを自動的に無効化し、その
呼び出しが失敗すればチェックアウト・客室変更自体を巻き戻します。無効化は**ベンダー側を先に**
行ってからローカルを更新します —— 順序が逆だと「無効と記録されているのに実際は開くカード」が
残ります。

### 決済

オーソリ → 売上確定 →（必要なら）返金の三段階をそのまま保ちます。**フォリオに決済が載るのは
売上確定の時点です** —— オーソリだけで残高を減らすと、確定に失敗したときに受け取っていない金が
受け取ったことになります。

**カード番号と CVV はどこにも保存しません。** 端末が決済代行に直接通し、こちらは結果のトークン
だけを受け取ります。残るのはマスクされた下 4 桁と取引識別子だけです。

冪等キーで再送を防ぎます。客の金が二重に出ていくことは、他の何より取り返しがつきません。結果
不明（タイムアウト）は履歴を残しません —— 冪等キーを消費すると同じキーで再試行できず、実際に
オーソリされたかを確認する道も塞がれます。

### POS インターフェース

**スタッフの JWT は使いません。** 端末にスタッフのパスワードを入れることになり、その端末が
スタッフ権限のすべてを得てしまうためです。アウトレットごとに自分のキー（`x-pos-key`）を発行し、
そのキーでできるのは在館中の客室への課金と、自分が付けた課金の取消だけです。客室一覧も**客室
番号と姓のみ**を返します。

`(outletId, reference)` の一意制約で二重課金を防ぎ、再送の場合は新たに付けずに既存のものを成功
として返します —— そうしないと POS の再試行が止まりません。

---

## ライセンス

UNLICENSED —— 社内専用。

<div align="center">

# PlanForge BE

**酒店管理平台的业务逻辑服务器**

负责预订、前台、客房、账务、POS 与房卡。对 OPERA 的写入委托给 Core，并将结果镜像到本地。

[한국어](README.md) · [English](README.en.md) · **中文** · [日本語](README.ja.md)

![TypeScript](https://img.shields.io/badge/TypeScript-83.2%25-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5.1%25-2D3748?style=flat-square&logo=prisma&logoColor=white)
![SQL](https://img.shields.io/badge/SQL-3.7%25-336791?style=flat-square&logo=postgresql&logoColor=white)
![Markdown](https://img.shields.io/badge/Markdown-3.1%25-083FA1?style=flat-square)
![YAML](https://img.shields.io/badge/YAML-2.0%25-CB171E?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-0.5%25-2496ED?style=flat-square&logo=docker&logoColor=white)

</div>

---

## 项目背景

目标是在使用 Oracle OPERA 的酒店中，**不替换 PMS，而是在其之上叠加运营工具**。预订、库存与
房价的记录源头是 OPERA，BE 持有其副本，并补上日常运营真正需要的部分。

边界很清晰：

| OPERA 拥有 | PlanForge 拥有 |
| --- | --- |
| 预订 · 库存 · 房价 · 确认号 | 客房清扫任务分配 |
| 客史档案的姓名与联系方式 | 偏好设置 · 内部备注 |
| 团队房控与实收 | POS 门店密钥 · 房卡记录 |
| 营业日 | 员工账号 · 权限 |

**所有写操作先反映到 OPERA，再用返回值填充本地。** 若写入我们发送的值，就会丢失 OPERA 调整过
的结果。本地记录是为了让列表与检索更快的缓存。

### 平台构成

| 仓库 | 职责 |
| --- | --- |
| [PlanForge-Package-FE](https://github.com/PlanForge-Package/PlanForge-Package-FE) | 运营 / 前台 Web 界面 |
| **PlanForge-Package-BE** | **业务逻辑 · 自有数据库** |
| [PlanForge-Package-Core](https://github.com/PlanForge-Package/PlanForge-Package-Core) | Oracle OPERA（OHIP）对接 API 服务器 |

调用链路：`FE → BE → Core → OPERA Cloud (OHIP)`

---

## 语言与技术栈

| 分类 | 技术 |
| --- | --- |
| 语言 | TypeScript 5.9（strict） |
| 运行时 | Node.js 20.11+ |
| 框架 | NestJS 10 |
| 数据库 | PostgreSQL 16 |
| ORM | Prisma 6 —— 基于迁移的模式管理 |
| 认证 | JWT（`@nestjs/jwt`）· bcryptjs · 全局守卫 |
| 校验 | class-validator · class-transformer（whitelist · forbidNonWhitelisted） |
| 限流 | `@nestjs/throttler` —— 登录另设 5 分钟 10 次 |
| API 文档 | `@nestjs/swagger`（`/docs`） |
| 测试 | Jest —— 237 个用例 |
| 质量 | ESLint · Prettier · GitHub Actions |
| 部署 | Docker · docker-compose |
| 包管理 | pnpm 9 |

---

## 目录结构

```
prisma/
├── schema.prisma                 数据模型（沿用 OPERA 概念）
├── migrations/                   迁移历史
└── seed.ts                       幂等种子 —— 2 家酒店 · 各角色账号 · 预订

src/
├── auth/                         登录 · JWT 守卫 · 角色守卫 · 登录限流
├── users/                        账号管理（入职 · 角色 · 归属 · 离职）
├── properties/
│   ├── property-scope.ts         多酒店访问边界 —— 隔离的核心
│   └── properties.service.ts     酒店 · 房型
├── core/                         Core（OHIP）HTTP 客户端 · 错误转换
├── reservations/
│   ├── booking.service.ts        创建 · 修改 · 取消 · No-show —— 委托后镜像
│   └── reservations.service.ts   列表 · 入住 · 退房
├── blocks/                       团队房控 · 房单
├── profiles/                     客史档案 · 偏好 · 重复合并
├── folios/                       账单 · 入账
├── payments/
│   ├── payment.driver.ts         支付网关驱动接口
│   ├── mock-payment.driver.ts    模拟支付网关
│   └── payments.service.ts       授权 · 请款 · 撤销 · 退款
├── pos/
│   ├── pos-key.guard.ts          门店 API Key 认证
│   ├── pos.service.ts            挂房账 · 撤销（防重复）
│   └── outlets.service.ts        门店发放 · 换发 · 停用
├── doorlock/
│   ├── doorlock.driver.ts        门锁驱动接口
│   ├── mock-doorlock.driver.ts   模拟门锁
│   ├── local-time.ts             酒店当地时间 → UTC
│   └── doorlock.service.ts       制卡 · 作废 · 自动回收
├── housekeeping/                 任务分配 · 房态 · 差异检测
├── night-audit/                  夜审检查表 · No-show
├── reports/                      出租率 · ADR · RevPAR · 渠道拆解
├── rooms/                        房间列表 · 房态汇总
├── sync/                         OPERA 预订同步 · 映射
└── main.ts
```

---

## 运行方式

### 环境要求

- Node.js 20.11 以上
- pnpm 9
- PostgreSQL 16
- 已启动的 [PlanForge Core](https://github.com/PlanForge-Package/PlanForge-Package-Core)

### 安装与启动

```bash
pnpm install
cp .env.example .env          # 设置 DATABASE_URL · JWT_SECRET · CORE_BASE_URL

pnpm prisma:deploy            # 应用迁移
pnpm prisma:seed              # 种子数据
pnpm start:dev
```

| 地址 | 用途 |
| --- | --- |
| `http://localhost:3001/api` | API |
| `http://localhost:3001/docs` | Swagger UI |
| `http://localhost:3001/api/health` | 健康检查（无需认证） |

### 种子账号

密码统一为 `planforge`（可用 `SEED_PASSWORD` 覆盖）。

| 邮箱 | 角色 | 归属 |
| --- | --- | --- |
| `admin@planforge.local` | ADMIN | 总部（全部酒店） |
| `manager@planforge.local` | MANAGER | PlanForge Seoul |
| `frontdesk@planforge.local` | FRONT_DESK | PlanForge Seoul |
| `housekeeping@planforge.local` | HOUSEKEEPING | PlanForge Seoul |

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm start:dev` | 开发服务器（watch） |
| `pnpm build` / `pnpm start:prod` | 构建 / 生产运行 |
| `pnpm test` / `pnpm test:cov` | Jest |
| `pnpm prisma:deploy` / `pnpm prisma:seed` | 迁移 / 种子 |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | 质量检查 |

### 环境变量

| 名称 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `JWT_SECRET` | **32 字符以上。** 过短将拒绝启动 |
| `JWT_EXPIRES_IN` | 令牌有效期（默认 `12h`） |
| `CORE_BASE_URL` | Core API 地址（默认 `http://localhost:3002`） |
| `CORE_API_KEY` | 需与 Core 的 `SERVICE_API_KEY` 一致 |
| `DOORLOCK_MODE` | `mock` \| `live` —— 默认 `mock` |
| `PAYMENT_MODE` | `mock` \| `live` —— 默认 `mock` |
| `SEED_PASSWORD` | 种子账号密码（8 位以上） |

在 `NODE_ENV=production` 下，若 `DOORLOCK_MODE` 与 `PAYMENT_MODE` 不是 `live`，服务将
**拒绝启动**。最坏的情况是前台以为已制卡而客人打不开房门，或以为已收款而实际没有到账。

### 部署

```bash
cd deploy && docker compose up -d
```

`deploy/docker-compose.yml` 会一并启动 PostgreSQL、Core、BE 与 FE。Core 仅置于内网，不对外
开放端口。

---

## 接口一览

<details>
<summary><b>认证 · 账号 · 酒店</b></summary>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 登录（公开） |
| `GET` | `/api/auth/me` | 当前账号 |
| `POST` | `/api/auth/change-password` | 修改本人密码 |
| `GET` `POST` | `/api/users` | 账号列表 · 创建（ADMIN） |
| `PATCH` | `/api/users/:id` | 角色 · 归属 · 在职状态（ADMIN） |
| `POST` | `/api/users/:id/password` | 重置密码（ADMIN） |
| `GET` | `/api/properties` | 可访问的酒店 |
| `GET` | `/api/properties/:id/room-types` | 酒店房型 |
| `POST` `PATCH` | `/api/properties` | 登记 · 修改酒店（ADMIN） |
| `GET` | `/api/health` | 服务 · 数据库状态（公开） |

</details>

<details>
<summary><b>预订 · 账单 · 支付</b></summary>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/reservations` | 预订列表（状态 · 渠道 · 检索） |
| `GET` | `/api/reservations/summary` | 当日抵店 · 离店 · 在住 |
| `GET` | `/api/reservations/:id` | 单条预订（含账单） |
| `POST` | `/api/reservations/:id/check-in` | 入住 —— 分房 · 开账 |
| `POST` | `/api/reservations/:id/check-out` | 退房 —— 结账 · 释放房间 |
| `GET` `POST` | `/api/reservations/:id/folios` | 账单查询 · 新增账窗 |
| `POST` | `/api/reservations/:id/folios/:window/postings` | 入账 |
| `POST` | `/api/reservations/:id/folios/postings/:postingId/transfer` | 将账目转到其他账窗 |
| `GET` `POST` | `/api/reservations/:id/folios/routings` | 查询 · 设置路由指令 |
| `DELETE` | `/api/reservations/:id/folios/routings/:transactionCode` | 解除路由指令 |
| `GET` | `/api/reservations/:id/payments` | 支付记录 |
| `POST` | `/api/reservations/:id/folios/:window/payments` | 授权 |
| `POST` | `/api/payments/:id/capture` `\|` `/void` | 请款 · 撤销授权 |
| `POST` | `/api/payments/:id/refund` | 退款（MANAGER） |
| `GET` | `/api/cashier/shifts/current` | 我当前的班次与汇总 |
| `GET` | `/api/cashier/shifts` `\|` `/api/cashier/shifts/:id` | 历史班次 · 详情 |
| `POST` | `/api/cashier/shifts` | 开始班次（备用金） |
| `POST` | `/api/cashier/shifts/:id/close` | 结班 —— 记录长短款 |
| `GET` | `/api/traces` | 按日期与部门查看指示 |
| `GET` `POST` | `/api/reservations/:id/traces` | 查询 · 登记预订指示 |
| `PATCH` | `/api/traces/:id/complete` | 标记已处理 |
| `DELETE` | `/api/traces/:id` | 撤回（仅未处理） |

</details>

<details>
<summary><b>团队 · 客史 · 房卡</b></summary>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/blocks` | 团队房控列表 |
| `GET` | `/api/blocks/:id` | 房控详情 —— 按日配额与实收 |
| `GET` | `/api/blocks/:id/reservations` | 房单 |
| `POST` `PATCH` | `/api/blocks` | 创建 · 修改房控（MANAGER） |
| `GET` | `/api/profiles` | 客史检索 |
| `GET` | `/api/profiles/:id` | 客史详情 —— 住店记录 |
| `GET` | `/api/profiles/:id/duplicates` | 重复候选与依据 |
| `PATCH` | `/api/profiles/:id` | 偏好 · 会员 · 备注 |
| `POST` | `/api/profiles/:id/merge` | 合并重复（MANAGER） |
| `GET` `POST` | `/api/reservations/:id/keys` | 房卡记录 · 制卡 |
| `POST` | `/api/door-keys/:keyId/revoke` | 作废房卡 |

</details>

<details>
<summary><b>客房 · 夜审 · 报表 · POS</b></summary>

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/rooms` `\|` `/api/rooms/summary` | 房间列表 · 房态汇总 |
| `GET` `POST` | `/api/housekeeping/tasks` | 当班任务 · 生成 |
| `PATCH` | `/api/housekeeping/tasks/:id[/assign]` | 分配 · 进度 |
| `PATCH` | `/api/housekeeping/rooms/:id/status` | 房态变更（委托 OPERA） |
| `GET` | `/api/room-outages` | 停用房间列表 |
| `POST` | `/api/room-outages` | 登记停用（委托 OPERA） |
| `DELETE` | `/api/room-outages/:id` | 解除停用（委托 OPERA） |
| `GET` | `/api/housekeeping/discrepancies` | 房态与在住的差异 |
| `GET` | `/api/night-audit` | 夜审检查表 |
| `POST` | `/api/night-audit/reservations/:id/no-show` | No-show 处理 |
| `GET` | `/api/reports/daily` | 出租率 · ADR · RevPAR · 渠道拆解（MANAGER） |
| `GET` `POST` `PATCH` | `/api/pos-outlets` | POS 门店管理（MANAGER） |
| `GET` `POST` | `/api/pos/rooms` `\|` `/api/pos/charges[/void]` | 挂房账（门店密钥） |
| `POST` `GET` | `/api/sync/reservations` `\|` `/api/sync/logs` | OPERA 同步 · 记录 |

</details>

---

## 设计取舍

### 认证与权限

**所有**未标注 `@Public()` 的路由都要求有效的 Bearer 令牌。默认「受保护」而非维护白名单，是因为
新增控制器时忘记加保护，比反过来危险得多。公开路由仅有 `/api/auth/login` 与 `/api/health`。

`property-scope.ts` 就是多酒店隔离的全部。已指定归属的账号无法触及其他酒店的数据：列表自动
收窄，单条查询也会校验范围 —— 仅凭泄露的确认号或 URL，绝不能打开别家酒店的预订。

### 入住与退房

分房、预订状态与账单必须同时成立，因此放在一个事务中。重复分配在住房间、分配停售房间、以及
存在未结余额时退房，都会被拒绝。

### 夜审

**夜审由 OPERA 执行** —— 推进营业日、自动过账房费与税金是 PMS 的职责，模仿只会让两套系统的
营业额分裂。`/api/night-audit` 所做的是展示**「此刻结账会留下什么问题」**：未抵店、未退房、
在住未分房、仍有余额的账单、房态与在住不一致。

### 报表

明确区分两种营业额：

- **客房营业额（合约口径）** —— 将预订总额按间夜分摊。出租率、ADR、RevPAR 的依据
- **账单入账（实际计提）** —— 账单上的收费、付款与调整；入住后才产生

两者混用会让「营业额为何不同」无人能解释。对账用入账，销售指标用合约口径。`Posting.amount` 在
写入时已带符号（付款为负），因此应收就是简单求和。

出租率的分母是**当前**非故障、非停售的房间数。系统不保留历史故障记录，因此可能与当时实际可售
房数不同 —— 该依据会同时在响应与界面上标明。

### 客史档案

姓名与联系方式是 OPERA 档案的副本，而**偏好设置与内部备注归 PlanForge 所有**。偏好以代码存储
而非自由文本 —— 用文本会让「高层」「高楼层」「high floor」混杂，分房时无人能筛选。

合并不会删除原档案。历史预订仍在引用，删除会让那些住店记录失去客人。若双方都是 OPERA 档案，
则先经 Core **在 OPERA 侧合并** —— 只在本地合并会被下一次同步复活。OPERA 拒绝时，本地也不做
任何改动。

### 房卡（门锁）

门锁协议因厂商而完全不同 —— Assa Abloy（Vingcard）、Salto、Onity 在卡片编码与连接方式上都不
一致。因此领域层只认识 `DoorLockDriver` 接口，实际通信封闭在一个实现文件中。

最危险的失败是**房卡仍然有效却被遗忘**：已退房客人的卡能打开下一位客人入住的房间。所以退房与
换房会自动作废剩余房卡，若该调用失败，退房或换房本身也会回滚。作废先在**厂商侧**执行，再标记
本地 —— 顺序反过来会留下「记录为已作废、实际仍能开门」的卡。

### 支付

授权 → 请款 →（必要时）退款，三个阶段保持独立。**账单在请款时才记入** —— 仅凭授权就冲减余额，
一旦请款失败，就会把没收到的钱记成已收。

**卡号与 CVV 一律不存储。** 由终端直连支付网关，我们只接收结果令牌；留下的仅是掩码后四位与
交易标识。

用幂等键阻止重复扣款。客人账户被扣两次，比几乎任何事都更难挽回。结果不明（超时）不留记录 ——
消耗掉幂等键后，既无法用同一键重试，也堵死了确认是否真正授权的途径。

### POS 接口

**不使用员工 JWT。** 那会把员工密码放进终端，并让该终端获得员工的全部权限。每个门店发放各自的
密钥（`x-pos-key`），该密钥能做的只有向在住房间挂账、以及撤销自己挂的账。房间列表也只返回
**房号与姓氏**。

`(outletId, reference)` 唯一约束阻止重复挂账；若为重发，则不再新增而是把已有记录作为成功返回
—— 否则 POS 会不断重试。

---

## 许可

UNLICENSED —— 仅限公司内部使用。

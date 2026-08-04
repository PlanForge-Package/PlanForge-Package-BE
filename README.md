<div align="center">

# PlanForge BE

**호텔 관리 플랫폼의 업무 로직 서버**

예약·프런트데스크·하우스키핑·회계·POS·객실 키를 다룹니다. OPERA 로의 쓰기는 Core 에 위임하고
결과를 미러링합니다.

**한국어** · [English](README.en.md) · [中文](README.zh.md) · [日本語](README.ja.md)

![TypeScript](https://img.shields.io/badge/TypeScript-83.2%25-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5.1%25-2D3748?style=flat-square&logo=prisma&logoColor=white)
![SQL](https://img.shields.io/badge/SQL-3.7%25-336791?style=flat-square&logo=postgresql&logoColor=white)
![Markdown](https://img.shields.io/badge/Markdown-3.1%25-083FA1?style=flat-square)
![YAML](https://img.shields.io/badge/YAML-2.0%25-CB171E?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-0.5%25-2496ED?style=flat-square&logo=docker&logoColor=white)

</div>

---

## 프로젝트 배경

Oracle OPERA 를 쓰는 호텔에서 **PMS 를 대체하지 않고 그 위에 운영 도구를 얹는** 것이 목표입니다.
예약·재고·요금의 기록 원천은 OPERA 이고, BE 는 그 사본을 들고 실무에 필요한 것을 더합니다.

경계는 분명합니다.

| OPERA 가 소유 | PlanForge 가 소유 |
| --- | --- |
| 예약·재고·요금·확인 번호 | 하우스키핑 작업 배정 |
| 게스트 프로필의 이름·연락처 | 선호 사항 · 내부 메모 |
| 블록 재고와 픽업 | POS 아웃렛 키 · 객실 키 이력 |
| 영업일 | 직원 계정 · 권한 |

**모든 쓰기는 OPERA 에 먼저 반영하고, 돌아온 값으로 로컬을 채웁니다.** 우리가 보낸 값을 적으면
OPERA 가 조정한 결과를 놓칩니다. 로컬 레코드는 목록·검색을 빠르게 하려는 캐시입니다.

### 플랫폼 구성

| 리포지토리 | 역할 |
| --- | --- |
| [PlanForge-Package-FE](https://github.com/PlanForge-Package/PlanForge-Package-FE) | 운영자·프론트데스크 웹 UI |
| **PlanForge-Package-BE** | **업무 로직 · 자체 데이터베이스** |
| [PlanForge-Package-Core](https://github.com/PlanForge-Package/PlanForge-Package-Core) | Oracle OPERA(OHIP) 연동 API 서버 |

호출 경로: `FE → BE → Core → OPERA Cloud (OHIP)`

---

## 언어 및 스택

| 구분 | 사용 기술 |
| --- | --- |
| 언어 | TypeScript 5.9 (strict) |
| 런타임 | Node.js 20.11+ |
| 프레임워크 | NestJS 10 |
| 데이터베이스 | PostgreSQL 16 |
| ORM | Prisma 6 — 마이그레이션 기반 스키마 관리 |
| 인증 | JWT (`@nestjs/jwt`) · bcryptjs · 전역 가드 |
| 검증 | class-validator · class-transformer (whitelist · forbidNonWhitelisted) |
| 속도 제한 | `@nestjs/throttler` — 로그인은 5분 10회로 별도 제한 |
| API 문서 | `@nestjs/swagger` (`/docs`) |
| 테스트 | Jest — 237건 |
| 품질 | ESLint · Prettier · GitHub Actions |
| 배포 | Docker · docker-compose |
| 패키지 관리 | pnpm 9 |

---

## 디렉토리 구조

```
prisma/
├── schema.prisma                 데이터 모델 (OPERA 개념을 그대로 따름)
├── migrations/                   마이그레이션 이력
└── seed.ts                       멱등 시드 — 호텔 2곳 · 역할별 계정 · 예약

src/
├── auth/                         로그인 · JWT 가드 · 역할 가드 · 로그인 스로틀
├── users/                        계정 관리 (입사 · 역할 · 소속 · 퇴사)
├── properties/
│   ├── property-scope.ts         다중 호텔 접근 경계 — 이 파일이 격리의 핵심
│   └── properties.service.ts     호텔 · 객실 타입
├── core/                         Core(OHIP) HTTP 클라이언트 · 오류 변환
├── reservations/
│   ├── booking.service.ts        생성 · 수정 · 취소 · 노쇼 — OPERA 위임 + 미러링
│   └── reservations.service.ts   목록 · 체크인 · 체크아웃
├── blocks/                       단체 블록 · 룸리스트
├── profiles/                     게스트 프로필 · 선호 · 중복 병합
├── folios/                       폴리오 · 거래 등록
├── payments/
│   ├── payment.driver.ts         PG 드라이버 인터페이스
│   ├── mock-payment.driver.ts    모의 PG
│   └── payments.service.ts       승인 · 매입 · 승인취소 · 환불
├── pos/
│   ├── pos-key.guard.ts          아웃렛 API 키 인증
│   ├── pos.service.ts            룸차지 · 취소 (중복 전송 방지)
│   └── outlets.service.ts        아웃렛 발급 · 재발급 · 사용 중지
├── doorlock/
│   ├── doorlock.driver.ts        잠금장치 드라이버 인터페이스
│   ├── mock-doorlock.driver.ts   모의 잠금장치
│   ├── local-time.ts             호텔 현지 시각 → UTC
│   └── doorlock.service.ts       카드 발급 · 무효화 · 자동 회수
├── housekeeping/                 작업 배정 · 객실 상태 · 불일치 탐지
├── night-audit/                  마감 점검표 · 노쇼 처리
├── reports/                      점유율 · ADR · RevPAR · 채널별 분해
├── rooms/                        객실 목록 · 상태 집계
├── sync/                         OPERA 예약 동기화 · 매퍼
└── main.ts
```

---

## 실행 방법

### 요구 사항

- Node.js 20.11 이상
- pnpm 9
- PostgreSQL 16
- 기동 중인 [PlanForge Core](https://github.com/PlanForge-Package/PlanForge-Package-Core)

### 설치와 기동

```bash
pnpm install
cp .env.example .env          # DATABASE_URL · JWT_SECRET · CORE_BASE_URL 설정

pnpm prisma:deploy            # 마이그레이션 적용
pnpm prisma:seed              # 시드 데이터
pnpm start:dev
```

| 주소 | 용도 |
| --- | --- |
| `http://localhost:3001/api` | API |
| `http://localhost:3001/docs` | Swagger UI |
| `http://localhost:3001/api/health` | 헬스체크 (인증 불필요) |

### 시드 계정

비밀번호는 모두 `planforge` (`SEED_PASSWORD` 로 변경 가능).

| 이메일 | 역할 | 소속 |
| --- | --- | --- |
| `admin@planforge.local` | ADMIN | 본사 (전 호텔) |
| `manager@planforge.local` | MANAGER | PlanForge Seoul |
| `frontdesk@planforge.local` | FRONT_DESK | PlanForge Seoul |
| `housekeeping@planforge.local` | HOUSEKEEPING | PlanForge Seoul |

### 주요 명령

| 명령 | 설명 |
| --- | --- |
| `pnpm start:dev` | 개발 서버 (watch) |
| `pnpm build` / `pnpm start:prod` | 빌드 / 프로덕션 실행 |
| `pnpm test` / `pnpm test:cov` | Jest |
| `pnpm prisma:deploy` / `pnpm prisma:seed` | 마이그레이션 / 시드 |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | 품질 검사 |

### 환경 변수

| 이름 | 설명 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 연결 문자열 |
| `JWT_SECRET` | **32자 이상.** 짧으면 기동을 거부합니다 |
| `JWT_EXPIRES_IN` | 토큰 수명 (기본 `12h`) |
| `CORE_BASE_URL` | Core API 주소 (기본 `http://localhost:3002`) |
| `CORE_API_KEY` | Core 의 `SERVICE_API_KEY` 와 같은 값 |
| `DOORLOCK_MODE` | `mock` \| `live` — 기본 `mock` |
| `PAYMENT_MODE` | `mock` \| `live` — 기본 `mock` |
| `SEED_PASSWORD` | 시드 계정 비밀번호 (8자 이상) |

`NODE_ENV=production` 에서 `DOORLOCK_MODE` · `PAYMENT_MODE` 가 `live` 가 아니면 **기동을
거부합니다.** 프런트가 카드를 발급했다고 믿는데 손님이 방에 못 들어가거나, 결제됐다고 믿는데
돈이 들어오지 않는 상황이 최악입니다.

### 배포

```bash
cd deploy && docker compose up -d
```

`deploy/docker-compose.yml` 이 PostgreSQL · Core · BE · FE 를 함께 띄웁니다. Core 는 내부
네트워크에만 두고 포트를 열지 않습니다.

---

## 제공 엔드포인트

<details>
<summary><b>인증 · 계정 · 호텔</b></summary>

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 로그인 (공개) |
| `GET` | `/api/auth/me` | 현재 계정 |
| `POST` | `/api/auth/change-password` | 본인 비밀번호 변경 |
| `GET` `POST` | `/api/users` | 계정 목록 · 생성 (ADMIN) |
| `PATCH` | `/api/users/:id` | 역할·소속·재직 여부 (ADMIN) |
| `POST` | `/api/users/:id/password` | 비밀번호 초기화 (ADMIN) |
| `GET` | `/api/properties` | 접근 가능한 호텔 |
| `GET` | `/api/properties/:id/room-types` | 호텔의 객실 타입 |
| `POST` `PATCH` | `/api/properties` | 호텔 등록 · 수정 (ADMIN) |
| `GET` | `/api/health` | 서비스 · DB 상태 (공개) |

</details>

<details>
<summary><b>예약 · 폴리오 · 결제</b></summary>

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/reservations` | 예약 목록 (상태·채널·검색) |
| `GET` | `/api/reservations/summary` | 당일 도착·출발·재실 |
| `GET` | `/api/reservations/:id` | 예약 단건 (폴리오 포함) |
| `POST` | `/api/reservations/:id/check-in` | 체크인 — 객실 배정 · 폴리오 개설 |
| `POST` | `/api/reservations/:id/confirm-waitlist` | 대기 확정 (OPERA 위임) |
| `POST` | `/api/reservations/:id/share` `\|` `/unshare` | 객실 공유 · 해제 (OPERA 위임) |
| `POST` | `/api/reservations/:id/check-out` | 체크아웃 — 폴리오 마감 · 객실 반납 |
| `GET` `POST` | `/api/reservations/:id/folios` | 폴리오 조회 · 윈도 추가 |
| `POST` | `/api/reservations/:id/folios/:window/postings` | 청구·결제 등록 |
| `POST` | `/api/reservations/:id/folios/postings/:postingId/transfer` | 거래를 다른 창구로 이관 |
| `GET` `POST` | `/api/reservations/:id/folios/routings` | 라우팅 지시 조회 · 설정 |
| `DELETE` | `/api/reservations/:id/folios/routings/:transactionCode` | 라우팅 해제 |
| `GET` | `/api/reservations/:id/payments` | 결제 이력 |
| `POST` | `/api/reservations/:id/folios/:window/payments` | 승인 |
| `POST` | `/api/payments/:id/capture` `\|` `/void` | 매입 · 승인 취소 |
| `POST` | `/api/payments/:id/refund` | 환불 (MANAGER) |
| `GET` | `/api/cashier/shifts/current` | 지금 열려 있는 내 근무조와 집계 |
| `GET` | `/api/cashier/shifts` `\|` `/api/cashier/shifts/:id` | 지난 근무조 · 상세 |
| `POST` | `/api/cashier/shifts` | 근무조 시작 (시작 시재) |
| `POST` | `/api/cashier/shifts/:id/close` | 마감 — 센 현금과의 차이를 남깁니다 |
| `GET` | `/api/traces` | 날짜·부서별 지시 목록 |
| `GET` `POST` | `/api/reservations/:id/traces` | 예약의 지시 조회 · 등록 |
| `PATCH` | `/api/traces/:id/complete` | 처리 완료 |
| `DELETE` | `/api/traces/:id` | 지시 거두기 (미처리만) |

</details>

<details>
<summary><b>후불 거래처 (AR · 시티레저)</b></summary>

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/ar/accounts` | 거래처 목록 — 잔액 포함 |
| `GET` | `/api/ar/accounts/:id` | 거래처 상세 — 잔액·거래·청구서 |
| `POST` `PATCH` | `/api/ar/accounts` | 거래처 등록 · 수정 (MANAGER) |
| `POST` | `/api/reservations/:id/ar/transfer` | 폴리오 잔액을 거래처로 이관 — OPERA 폴리오도 비웁니다 |
| `POST` | `/api/ar/accounts/:id/payments` | 거래처 입금 기록 (MANAGER) |
| `POST` | `/api/ar/accounts/:id/invoices` | 청구서 발행 — 미청구 거래를 모읍니다 (MANAGER) |
| `GET` | `/api/ar/invoices/:id` | 청구서 상세 |
| `PATCH` | `/api/ar/invoices/:id/status` | 상태 변경 — 무효로 돌리면 거래가 다시 풀립니다 (MANAGER) |

</details>

<details>
<summary><b>단체 · 프로필 · 객실 키</b></summary>

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/blocks` | 단체 블록 목록 |
| `GET` | `/api/blocks/:id` | 블록 상세 — 일자별 할당·픽업 |
| `GET` | `/api/blocks/:id/reservations` | 룸리스트 |
| `POST` `PATCH` | `/api/blocks` | 블록 생성 · 수정 (MANAGER) |
| `GET` | `/api/profiles` | 프로필 검색 |
| `GET` | `/api/profiles/:id` | 프로필 상세 — 투숙 이력 |
| `GET` | `/api/profiles/:id/duplicates` | 중복 후보와 근거 |
| `PATCH` | `/api/profiles/:id` | 선호·멤버십·메모 |
| `POST` | `/api/profiles/:id/merge` | 중복 병합 (MANAGER) |
| `GET` `POST` | `/api/reservations/:id/keys` | 객실 키 이력 · 발급 |
| `POST` | `/api/door-keys/:keyId/revoke` | 객실 키 무효화 |

</details>

<details>
<summary><b>하우스키핑 · 야간 감사 · 실적 · POS</b></summary>

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/rooms` `\|` `/api/rooms/summary` | 객실 목록 · 상태 집계 |
| `GET` `POST` | `/api/housekeeping/tasks` | 근무일 작업 · 생성 |
| `PATCH` | `/api/housekeeping/tasks/:id[/assign]` | 배정 · 진행 상태 |
| `PATCH` | `/api/housekeeping/rooms/:id/status` | 객실 상태 (OPERA 위임) |
| `GET` | `/api/room-outages` | 사용 불가 객실 목록 |
| `POST` | `/api/room-outages` | 사용 불가 등록 (OPERA 위임) |
| `DELETE` | `/api/room-outages/:id` | 사용 불가 해제 (OPERA 위임) |
| `GET` | `/api/housekeeping/discrepancies` | 객실 상태·재실 불일치 |
| `GET` | `/api/night-audit` | 마감 점검표 |
| `POST` | `/api/night-audit/reservations/:id/no-show` | 노쇼 처리 |
| `GET` | `/api/rates/quote` | 기간 요금 — 일자별 단가·패키지 |
| `GET` `POST` | `/api/rates/plans` | 요금 코드 목록 · 등록 (MANAGER) |
| `GET` `PATCH` | `/api/rates/plans/:ratePlanCode` | 요금 코드 단건 · 수정 |
| `POST` | `/api/rates/plans/:ratePlanCode/seasons` | 시즌 요금 추가 — 기간·요일 (MANAGER) |
| `DELETE` | `/api/rates/plans/:ratePlanCode/seasons/:seasonId` | 시즌 요금 삭제 (MANAGER) |
| `GET` `POST` | `/api/rates/packages` | 패키지 목록 · 등록 (MANAGER) |
| `PATCH` | `/api/rates/packages/:packageCode` | 패키지 수정 (MANAGER) |
| `GET` | `/api/reports/daily` | 점유율·ADR·RevPAR·채널별 분해 (MANAGER) |
| `GET` | `/api/reports/journal` | 마감 분개 — 거래 코드별 매출·세금과 수납 대사 (MANAGER) |
| `GET` `POST` `PATCH` | `/api/pos-outlets` | POS 아웃렛 관리 (MANAGER) |
| `GET` `POST` | `/api/pos/rooms` `\|` `/api/pos/charges[/void]` | 룸차지 (아웃렛 키) |
| `POST` `GET` | `/api/sync/reservations` `\|` `/api/sync/logs` | OPERA 동기화 · 이력 |

</details>

---

## 설계 판단

### 인증과 권한

`@Public()` 이 붙지 않은 **모든** 라우트가 유효한 Bearer 토큰을 요구합니다. 화이트리스트가 아니라
기본을 "보호됨" 으로 둔 이유는, 새 컨트롤러를 추가할 때 보호를 잊는 쪽이 훨씬 위험하기
때문입니다. 공개 라우트는 `/api/auth/login` 과 `/api/health` 뿐입니다.

`property-scope.ts` 가 다중 호텔 격리의 전부입니다. 소속이 지정된 계정은 다른 호텔의 자료에
닿을 수 없고, 목록은 자동으로 좁혀지며 단건 조회도 범위를 확인합니다 — 확인 번호나 URL 이 새어
나가는 것만으로 남의 호텔 예약이 열려서는 안 됩니다.

### 체크인·체크아웃

객실 배정·예약 상태·폴리오가 함께 성립해야 하므로 한 트랜잭션으로 처리합니다. 재실 중인 객실
중복 배정, 판매 불가 객실 배정, 미결제 잔액이 남은 상태의 체크아웃은 거절합니다.

### 야간 감사

마감 자체는 OPERA 가 돌립니다 — 영업일을 넘기고 룸·세금을 자동 포스팅하는 것은 PMS 의 일이고,
흉내 내면 두 시스템의 매출이 갈립니다. `/api/night-audit` 이 하는 일은 **"지금 마감하면 무엇이
잘못 남는가"** 를 보여 주는 것입니다: 미도착·미체크아웃·객실 미배정·잔액이 남은 폴리오·객실
상태 불일치.

### 실적

두 가지 매출을 분명히 나눕니다.

- **객실 매출(계약 기준)** — 예약 총액을 박수로 나눠 각 날짜에 배분한 값. 점유율·ADR·RevPAR 의 근거
- **폴리오 청구(실제 계상)** — 폴리오에 올라간 청구·결제·조정. 체크인 이후에만 생김

둘을 섞으면 "매출이 왜 다른가" 를 아무도 설명할 수 없게 됩니다. 정산 대사에는 포스팅을, 판매
지표에는 계약 기준을 씁니다. `Posting.amount` 는 저장 시점에 이미 부호가 붙어 있어(결제는 음수)
미수는 단순 합계입니다.

점유율의 분모는 **현재** 고장·판매중지가 아닌 객실 수입니다. 과거 시점의 고장 이력은 남기지
않으므로 그때의 실제 가용 객실과 다를 수 있고, 이 근거를 응답과 화면에 함께 표시합니다.

### 게스트 프로필

이름·연락처는 OPERA 프로필의 사본이고, **선호 사항·내부 메모는 PlanForge 가 소유**합니다.
선호는 자유 텍스트가 아니라 코드로 저장합니다 — 텍스트로 받으면 "고층"·"높은 층"·"high floor"
가 뒤섞여 배정할 때 아무도 걸러낼 수 없습니다.

중복 병합은 원본을 지우지 않습니다. 과거 예약이 참조하고 있어 지우면 예약의 게스트가 사라집니다.
양쪽 모두 OPERA 프로필이면 Core 를 거쳐 **OPERA 에서 먼저 합칩니다** — 로컬만 합치면 다음
동기화가 지운 쪽을 되살립니다. OPERA 가 거절하면 로컬도 건드리지 않습니다.

### 객실 키 (도어락)

잠금장치는 벤더마다 프로토콜이 완전히 다릅니다 — Assa Abloy(Vingcard) · Salto · Onity 는 카드
인코딩도, 연결 방식도 서로 맞지 않습니다. 그래서 `DoorLockDriver` 인터페이스만 도메인이 알고,
실제 통신은 구현체 한 파일에 가둡니다.

가장 위험한 실패는 **카드가 살아 있는 채로 잊히는 것**입니다. 체크아웃한 손님의 카드가 다음
손님이 들어온 방을 엽니다. 그래서 체크아웃과 객실 변경이 자동으로 남은 카드를 죽이고, 그 호출이
실패하면 체크아웃·객실 변경 자체를 되돌립니다. 무효화는 **벤더에서 먼저** 죽이고 로컬을
표시합니다 — 순서가 반대면 "죽었다고 적혀 있지만 실제로는 열리는 카드" 가 남습니다.

### 결제

승인 → 매입 → (필요하면) 환불의 세 단계를 그대로 둡니다. **폴리오에 결제가 올라가는 시점은
매입입니다** — 승인만으로 잔액을 줄이면 매입에 실패했을 때 받지도 않은 돈이 받은 것으로 남습니다.

**카드 번호와 CVV 는 어디에도 저장하지 않습니다.** 단말이 PG 에 직접 태우고 우리는 결과 토큰만
받습니다. 마스킹된 뒷자리와 거래 식별자만 남습니다.

멱등키로 재전송을 막습니다. 손님 돈이 두 번 나가는 일은 그 무엇보다 되돌리기 어렵습니다.
결과 불명(타임아웃)은 이력을 남기지 않습니다 — 멱등키를 소진하면 같은 키로 다시 시도할 수 없고
실제 승인 여부를 확인할 길도 막힙니다.

### POS 인터페이스

**직원 JWT 를 쓰지 않습니다.** 단말에 직원 비밀번호를 심게 되고 그 단말이 직원 권한 전부를 얻기
때문입니다. 아웃렛마다 자기 키(`x-pos-key`)를 발급하고, 그 키로 할 수 있는 일은 재실 객실에
요금을 달고 자기가 단 요금을 취소하는 것뿐입니다. 객실 목록도 **객실 번호와 성만** 돌려줍니다.

`(outletId, reference)` 고유 제약으로 중복 청구를 막고, 재전송이면 새로 달지 않고 이미 단 것을
성공으로 돌려줍니다 — 그래야 POS 의 재시도가 멈춥니다.

---

## 라이선스

UNLICENSED — 사내 전용.

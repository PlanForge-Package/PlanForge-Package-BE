# PlanForge-Package-BE

Oracle OPERA(OHIP) 기반 호텔 관리 플랫폼 **PlanForge** 의 백엔드입니다.
업무 로직과 자체 데이터베이스를 담당하며, OPERA 연동은 Core 를 경유합니다.

## 플랫폼 구성

| 리포지토리 | 역할 | 스택 |
| --- | --- | --- |
| [PlanForge-Package-FE](https://github.com/PlanForge-Package/PlanForge-Package-FE) | 운영자·프론트데스크 웹 UI | Next.js 15 · TypeScript · Tailwind CSS 4 |
| [PlanForge-Package-BE](https://github.com/PlanForge-Package/PlanForge-Package-BE) | 업무 로직 · 자체 데이터베이스 | NestJS · Prisma · PostgreSQL |
| [PlanForge-Package-Core](https://github.com/PlanForge-Package/PlanForge-Package-Core) | Oracle OPERA(OHIP) 연동 API 서버 | Fastify · OpenAPI |

호출 경로: `FE → BE → Core → OPERA Cloud (OHIP)`

## 요구 사항

- Node.js 20.11 이상
- pnpm 9
- PostgreSQL 16

## 시작하기

```bash
pnpm install
cp .env.example .env

# PostgreSQL — 둘 중 하나
docker compose up -d                                   # Docker 를 쓰는 경우
winget install PostgreSQL.PostgreSQL.16                # Windows 에 직접 설치하는 경우

pnpm prisma:deploy            # 마이그레이션 적용
pnpm prisma:seed              # 개발용 시드 데이터 (선택)
pnpm start:dev
```

PostgreSQL 을 직접 설치했다면 역할과 데이터베이스를 먼저 만듭니다.

```sql
CREATE ROLE planforge LOGIN PASSWORD 'planforge' CREATEDB;
CREATE DATABASE planforge OWNER planforge;
```

### 시드 데이터

`pnpm prisma:seed` 는 호텔 1곳, 객실 8실, 게스트 6명, 예약 6건을 넣습니다.
도착·출발일은 실행 시점 기준 상대 날짜라 언제 돌려도 "오늘 도착", "재실" 같은
상태가 유지됩니다. 재실 예약에는 잔액이 남은 폴리오가 붙어 있어 체크아웃 차단
로직을 바로 시험할 수 있습니다. 모두 upsert 라 여러 번 돌려도 결과가 같으며,
`NODE_ENV=production` 이면 실행을 거부합니다.

- API: `http://localhost:3001/api`
- Swagger: `http://localhost:3001/docs`
- 헬스체크: `GET http://localhost:3001/api/health`

## 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/health` | 서비스 및 DB 상태 |
| `GET` | `/api/reservations` | 예약 목록 (상태·도착일·확인번호/이름 검색) |
| `GET` | `/api/reservations/summary` | 당일 도착·출발·재실 요약 |
| `GET` | `/api/reservations/:id` | 예약 단건 (폴리오·거래 포함) |
| `POST` | `/api/reservations/:id/check-in` | 체크인 — 객실 배정 및 폴리오 개설 |
| `POST` | `/api/reservations/:id/check-out` | 체크아웃 — 폴리오 마감 및 객실 반납 |
| `GET` | `/api/rooms` | 객실 목록 |
| `GET` | `/api/rooms/summary` | 객실 상태별 집계 |
| `PATCH` | `/api/rooms/:id/status` | 하우스키핑 상태 변경 |
| `POST` | `/api/sync/reservations` | Core 를 통해 OPERA 예약 동기화 |
| `GET` | `/api/sync/logs` | 동기화 이력 조회 |

체크인·체크아웃은 객실 배정·예약 상태·폴리오가 함께 성립해야 하므로 한 트랜잭션으로
처리합니다. 재실 중인 객실 중복 배정, 판매 불가 객실 배정, 미결제 잔액이 남은 상태의
체크아웃은 거절합니다.

## Core 연동

`CoreClient` 가 Core 를 호출하고, `SyncService` 가 결과를 로컬 DB 에 반영합니다.
예약 한 건의 실패가 배치 전체를 멈추지 않도록 건별로 격리하며, 실패는 `SyncLog` 에
남겨 나중에 재시도할 수 있게 합니다. 재시도는 Core 가 담당하는 401 재발급 외에는
하지 않습니다 — 예약 도메인에서는 즉시 재시도보다 이력을 남기고 배치로 다시 도는
편이 안전합니다.

## 데이터 모델

`prisma/schema.prisma` 에 OPERA 개념을 반영한 모델을 정의했습니다.

- **Property / RoomType / Room / RatePlan** — 자산과 요금
- **Profile** — 게스트·회사·여행사 프로필 (OPERA Profile)
- **Reservation** — 예약 (도착/출발, 상태, 객실 배정)
- **Folio / Posting** — 폴리오와 거래 내역 (OPERA Folio Window)
- **SyncLog** — Core 를 통한 OPERA 동기화 이력

PlanForge 자체 ID 를 1차 키로 두고, OPERA 식별자는 `operaHotelId`, `operaProfileId`,
`operaReservationId`, `operaFolioId` 필드로 함께 보관해 동기화 매칭 키로 사용합니다.

## 환경 변수

| 이름 | 설명 |
| --- | --- |
| `PORT` | 서버 포트 (기본 `3001`) |
| `DATABASE_URL` | PostgreSQL 접속 문자열 |
| `CORS_ORIGIN` | 허용 오리진 (쉼표 구분) |
| `CORE_BASE_URL` | Core API 서버 주소 |
| `CORE_API_KEY` | Core 호출용 API 키 (`x-api-key`) |
| `CORE_REQUEST_TIMEOUT_MS` | Core 호출 타임아웃 (기본 `15000`) |

## 스크립트

| 명령 | 설명 |
| --- | --- |
| `pnpm start:dev` | 개발 서버 (watch) |
| `pnpm build` / `pnpm start:prod` | 빌드 / 프로덕션 실행 |
| `pnpm prisma:migrate` | 마이그레이션 생성·적용 |
| `pnpm prisma:deploy` | 운영 마이그레이션 적용 |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | 검사 |

## 라이선스

UNLICENSED — 사내 전용.

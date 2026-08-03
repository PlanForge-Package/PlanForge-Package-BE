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
로직을 바로 시험할 수 있습니다. `NODE_ENV=production` 이면 실행을 거부합니다.

시드는 자기가 만든 데이터에 한해 멱등합니다 — 객실 점유와 폴리오 상태·거래를
매번 초기화하므로 체크인·체크아웃까지 시험한 뒤 다시 돌려도 같은 출발점이 됩니다.
시드 밖에서 생긴 데이터까지 지우려면 `pnpm exec prisma migrate reset` 을 씁니다.

- API: `http://localhost:3001/api`
- Swagger: `http://localhost:3001/docs`
- 헬스체크: `GET http://localhost:3001/api/health`

## 엔드포인트

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 로그인 후 액세스 토큰 발급 (공개) |
| `GET` | `/api/auth/me` | 현재 계정 조회 |
| `GET` | `/api/health` | 서비스 및 DB 상태 (공개) |
| `GET` | `/api/reservations` | 예약 목록 (상태·도착일·확인번호/이름 검색) |
| `GET` | `/api/reservations/summary` | 당일 도착·출발·재실 요약 |
| `GET` | `/api/reservations/:id` | 예약 단건 (폴리오·거래 포함) |
| `POST` | `/api/reservations/:id/check-in` | 체크인 — 객실 배정 및 폴리오 개설 |
| `POST` | `/api/reservations/:id/check-out` | 체크아웃 — 폴리오 마감 및 객실 반납 |
| `GET` | `/api/reservations/:id/folios` | 폴리오와 거래 내역 조회 |
| `POST` | `/api/reservations/:id/folios` | 폴리오 윈도 추가 개설 (분할 정산) |
| `POST` | `/api/reservations/:id/folios/:window/postings` | 청구·결제 등록 후 잔액 재계산 |
| `GET` | `/api/rooms` | 객실 목록 |
| `GET` | `/api/rooms/summary` | 객실 상태별 집계 |
| `PATCH` | `/api/rooms/:id/status` | 하우스키핑 상태 변경 |
| `POST` | `/api/sync/reservations` | Core 를 통해 OPERA 예약 동기화 |
| `GET` | `/api/sync/logs` | 동기화 이력 조회 |

체크인·체크아웃은 객실 배정·예약 상태·폴리오가 함께 성립해야 하므로 한 트랜잭션으로
처리합니다. 재실 중인 객실 중복 배정, 판매 불가 객실 배정, 미결제 잔액이 남은 상태의
체크아웃은 거절합니다.

### 인증과 권한

`@Public()` 이 붙지 않은 **모든** 라우트가 유효한 Bearer 토큰을 요구합니다. 화이트리스트가
아니라 기본을 "보호됨" 으로 둔 이유는, 새 컨트롤러를 추가할 때 보호를 잊는 쪽이 훨씬
위험하기 때문입니다. 공개 라우트는 `/api/auth/login` 과 `/api/health` 뿐입니다.

| 역할 | 예약·폴리오 | 객실 조회 | 객실 상태 변경 | OPERA 동기화 | 계정 관리 |
| --- | --- | --- | --- | --- | --- |
| `ADMIN` | O | O | O | O | O |
| `MANAGER` | O | O | O | O | – |
| `FRONT_DESK` | O | O | O | – | – |
| `HOUSEKEEPING` | – | O | O | – | – |

`ADMIN` 은 `@Roles()` 목록에 없어도 항상 통과합니다 — 권한을 늘릴 때마다 목록에서
`ADMIN` 을 빠뜨려 스스로 잠기는 일을 막기 위해서입니다.

로그인 실패는 원인(없는 계정·틀린 비밀번호·비활성 계정)과 무관하게 같은 문구를
돌려주고, 없는 계정에도 해싱 비용을 치릅니다. 응답 내용이나 시간으로 계정 존재
여부가 새어 나가지 않게 하기 위해서입니다.

`GET /api/auth/me` 는 매번 DB 를 확인합니다. 토큰은 8시간 유효하지만 그 사이 계정이
비활성화될 수 있어, 토큰만 믿으면 해고된 직원이 남은 시간 동안 계속 접근합니다.

`JWT_SECRET` 이 없거나 32자 미만이면 서버가 기동하지 않습니다.

### 폴리오 금액 규칙

`amount` 는 **항상 양수**로 보냅니다. 잔액에 더할지 뺄지는 `type` 이 정합니다.

| type | 잔액 방향 |
| --- | --- |
| `CHARGE`, `TAX` | 증가 |
| `PAYMENT` | 감소 |
| `ADJUSTMENT` | 기본 증가, `negative: true` 면 감소 |

부호를 호출자가 정하게 하면 결제를 양수로 보내 잔액이 되레 늘어나는 사고가 나기
쉽기 때문입니다. 잔액은 거래를 더해 가는 대신 **매번 거래 합계로 다시 계산**합니다 —
증분 방식은 한 번의 실패가 영구적인 잔액 오차로 남습니다.

마감된 폴리오에는 거래를 등록할 수 없습니다. 마감 후 거래가 붙으면 체크아웃 시점의
잔액 0 검증이 무의미해지기 때문입니다.

```bash
# 체크인 → 청구 → 결제 → 체크아웃
curl -X POST .../reservations/$ID/check-in       -d '{"roomNumber":"1501"}'
curl -X POST .../reservations/$ID/folios/1/postings \
  -d '{"type":"CHARGE","transactionCode":"1000","description":"객실료","amount":240000}'
curl -X POST .../reservations/$ID/folios/1/postings \
  -d '{"type":"PAYMENT","transactionCode":"5000","description":"카드 결제","amount":240000}'
curl -X POST .../reservations/$ID/check-out      -d '{}'
```

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
| `JWT_SECRET` | 토큰 서명 키. 32자 이상 필수 (`openssl rand -base64 48`) |
| `JWT_EXPIRES_IN` | 토큰 수명 (기본 `8h` — 한 근무 교대) |
| `SEED_PASSWORD` | 시드 계정 비밀번호 (개발용, 기본 `planforge`) |

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

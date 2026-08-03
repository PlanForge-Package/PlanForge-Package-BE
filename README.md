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
- PostgreSQL 16 (`docker compose up -d` 로 기동 가능)

## 시작하기

```bash
pnpm install
cp .env.example .env
docker compose up -d          # PostgreSQL
pnpm prisma:migrate           # 최초 마이그레이션 생성/적용
pnpm start:dev
```

- API: `http://localhost:3001/api`
- Swagger: `http://localhost:3001/docs`
- 헬스체크: `GET http://localhost:3001/api/health`

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
| `CORE_API_KEY` | Core 호출용 API 키 |

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

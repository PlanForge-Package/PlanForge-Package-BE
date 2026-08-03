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
| `POST` | `/api/auth/change-password` | 본인 비밀번호 변경 (전 역할) |
| `GET` | `/api/users` | 계정 목록 (ADMIN) |
| `POST` | `/api/users` | 계정 생성 — 입사 (ADMIN) |
| `PATCH` | `/api/users/:id` | 역할·소속·재직 여부 수정 (ADMIN) |
| `POST` | `/api/users/:id/password` | 비밀번호 초기화 (ADMIN) |
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
| `GET` | `/api/housekeeping/tasks` | 근무일 작업 — 하우스키핑은 본인 것만 |
| `POST` | `/api/housekeeping/tasks/generate` | 근무일 작업 생성 |
| `PATCH` | `/api/housekeeping/tasks/:id/assign` | 작업 배정·해제 |
| `PATCH` | `/api/housekeeping/tasks/:id` | 작업 진행 상태 변경 |
| `PATCH` | `/api/housekeeping/rooms/:id/status` | 객실 상태 변경 (OPERA 위임) |
| `GET` | `/api/housekeeping/attendants` | 배정 가능한 직원 |
| `GET` | `/api/housekeeping/discrepancies` | 객실 상태·재실 불일치 |
| `GET` | `/api/rooms/summary` | 객실 상태별 집계 |
| `GET` | `/api/blocks` | 단체 블록 목록 (OPERA 조회 후 미러링) |
| `GET` | `/api/blocks/:id` | 블록 상세 — 일자·객실 타입별 할당과 픽업 |
| `GET` | `/api/blocks/:id/reservations` | 룸리스트 — 이 블록에서 빠져나간 예약 |
| `POST` | `/api/blocks` | 블록 생성 (MANAGER 이상) |
| `PATCH` | `/api/blocks/:id` | 블록 수정 — 이름·상태·컷오프 (MANAGER 이상) |
| `GET` | `/api/profiles` | 게스트 프로필 검색 — 이름·이메일·전화·멤버십 |
| `GET` | `/api/profiles/:id` | 프로필 상세 — 투숙 이력과 누적 실적 |
| `GET` | `/api/profiles/:id/duplicates` | 중복 후보와 그 근거 |
| `PATCH` | `/api/profiles/:id` | 선호·멤버십·내부 메모 수정 |
| `POST` | `/api/profiles/:id/merge` | 중복 병합 (MANAGER) |
| `GET` | `/api/reservations/:id/keys` | 발급된 객실 키 이력 |
| `POST` | `/api/reservations/:id/keys` | 객실 키 발급 |
| `POST` | `/api/door-keys/:keyId/revoke` | 객실 키 무효화 |
| `GET` | `/api/pos-outlets` | POS 아웃렛 목록 (MANAGER) |
| `POST` | `/api/pos-outlets` | 아웃렛 등록 — 키는 이 응답에서만 (MANAGER) |
| `PATCH` | `/api/pos-outlets/:id` | 이름·거래 코드·사용 여부 (MANAGER) |
| `POST` | `/api/pos-outlets/:id/rotate-key` | 키 재발급 (MANAGER) |
| `GET` | `/api/pos/rooms` | 요금을 달 수 있는 객실 (아웃렛 키) |
| `POST` | `/api/pos/charges` | 룸차지 (아웃렛 키) |
| `POST` | `/api/pos/charges/void` | 룸차지 취소 (아웃렛 키) |
| `GET` | `/api/reports/daily` | 일별 실적 — 점유율·ADR·RevPAR·매출 (MANAGER) |
| `GET` | `/api/night-audit` | 야간 감사 점검표 — 마감을 막는 항목 |
| `POST` | `/api/night-audit/reservations/:id/no-show` | 노쇼 처리 (OPERA 위임) |
| `POST` | `/api/sync/reservations` | Core 를 통해 OPERA 예약 동기화 |
| `GET` | `/api/sync/logs` | 동기화 이력 조회 |

체크인·체크아웃은 객실 배정·예약 상태·폴리오가 함께 성립해야 하므로 한 트랜잭션으로
처리합니다. 재실 중인 객실 중복 배정, 판매 불가 객실 배정, 미결제 잔액이 남은 상태의
체크아웃은 거절합니다.

### 야간 감사

마감 자체는 OPERA 가 돌립니다 — 영업일을 넘기고 룸·세금을 자동 포스팅하는 것은 PMS 의
일이고, 흉내 내면 두 시스템의 매출이 갈립니다. `/api/night-audit` 이 하는 일은 "지금
마감하면 무엇이 잘못 남는가" 를 보여 주는 것입니다: 미도착·미체크아웃·객실 미배정·잔액이
남은 폴리오·객실 상태 불일치.

영업일은 Core 를 통해 OPERA 에서 읽습니다. 닿지 못하면 달력 날짜로 대신하되 그 사실을
응답에 실어 보냅니다 — 잘못된 날짜로 마감 판단을 조용히 내리면 매출이 하루 밀려 붙습니다.

### 실적

두 가지 매출을 분명히 나눕니다.

- **객실 매출(계약 기준)** — 예약 총액을 박수로 나눠 각 날짜에 배분한 값. OPERA 가 확정한
  금액이라 모든 예약에 있고, 점유율·ADR·RevPAR 의 근거가 됩니다.
- **폴리오 청구(실제 계상)** — 폴리오에 올라간 청구·결제·조정. 체크인 이후에만 생깁니다.

둘을 섞으면 "매출이 왜 다른가" 를 아무도 설명할 수 없게 됩니다. 정산 대사에는 포스팅을,
판매 지표에는 계약 기준을 씁니다. `Posting.amount` 는 저장 시점에 이미 부호가 붙어 있어
(결제는 음수) 미수는 단순 합계입니다.

### 객실 키 (도어락)

잠금장치는 벤더마다 프로토콜이 완전히 다릅니다 — Assa Abloy(Vingcard) · Salto · Onity 는
카드 인코딩도, 연결 방식(로컬 인코더 SDK · 온프레미스 서버 · 클라우드 API)도 서로 맞지
않습니다. 그래서 `DoorLockDriver` 인터페이스만 도메인이 알고, 실제 통신은 구현체 한 파일에
가둡니다. 도메인이 벤더에게 요구하는 것은 두 가지뿐입니다: 카드를 만들고, 죽이는 것.

**지금은 모의 드라이버만 있습니다.** 발급 이력은 남지만 실제 카드는 만들어지지 않으며,
화면이 그 사실을 표시합니다. `DOORLOCK_MODE=live` 는 구현체가 없어 기동을 거부하고,
운영 환경에서 모의 모드도 기동을 거부합니다 — 프런트가 카드를 발급했다고 믿는데 손님이
방에 못 들어가는 상황이 최악입니다.

가장 위험한 실패는 **카드가 살아 있는 채로 잊히는 것**입니다. 체크아웃한 손님의 카드가
다음 손님이 들어온 방을 엽니다. 그래서 체크아웃과 객실 변경이 자동으로 남은 카드를 죽이고,
그 호출이 실패하면 체크아웃·객실 변경 자체를 되돌립니다. 무효화는 **벤더에서 먼저** 죽이고
로컬을 표시합니다 — 순서가 반대면 "죽었다고 적혀 있지만 실제로는 열리는 카드" 가 남습니다.

유효 기간은 호텔 현지 시각 기준입니다. UTC 로 "출발일 12시" 를 잡으면 서울에서는 밤 9시가
되어 카드가 반나절 더 살아 있습니다.

### POS 인터페이스

레스토랑·바 같은 외부 단말이 객실로 요금을 다는 통로입니다. **직원 JWT 를 쓰지 않습니다** —
단말에 직원 비밀번호를 심게 되고 그 단말이 직원 권한 전부를 얻기 때문입니다. 아웃렛마다
자기 키(`x-pos-key`)를 발급하고, 그 키로 할 수 있는 일은 재실 객실에 요금을 달고 자기가 단
요금을 취소하는 것뿐입니다. 예약이나 손님 정보는 읽지 못하고, 객실 목록도 **객실 번호와
성만** 돌려줍니다 — 매장 단말에 손님 명단이 통째로 뜨면 그 자체로 유출입니다.

키는 bcrypt 해시로만 저장하므로 발급 순간에만 볼 수 있습니다. 앞자리(`apiKeyPrefix`)는
비밀이 아니므로 후보를 좁히는 인덱스로 씁니다 — 전부 bcrypt 로 비교하면 아웃렛 수만큼 해시
연산이 돌아 룸차지 한 건이 수백 밀리초씩 걸립니다.

**중복 청구 방지가 이 인터페이스의 핵심입니다.** 네트워크가 끊겨 POS 가 같은 요청을 다시
보내는 일은 흔하고, 손님에게 두 번 청구되면 되돌리기 어렵습니다. `(outletId, reference)`
고유 제약으로 막고, 재전송이면 새로 달지 않고 이미 단 것을 성공으로 돌려줍니다 — 그래야
POS 의 재시도가 멈춥니다. 동시 요청은 조회로 못 잡으므로 고유 제약이 마지막 방어선입니다.

취소는 원본을 지우지 않고 반대 부호의 조정을 하나 더 답니다. 지우면 손님 명세서에서 요금이
통째로 사라져 무엇이 어떻게 정정됐는지 설명할 수 없습니다.

### 게스트 프로필

이름·연락처는 OPERA 프로필의 사본이고, **선호 사항·내부 메모는 PlanForge 가 소유**합니다.
"고층 선호" 는 프론트의 운영 지식이지 OPERA 로 밀어 넣을 필드가 아닙니다. 선호는 자유
텍스트가 아니라 코드로 저장합니다 — 텍스트로 받으면 "고층"·"높은 층"·"high floor" 가
뒤섞여 배정할 때 아무도 걸러낼 수 없습니다.

중복 병합은 원본을 지우지 않습니다. 과거 예약이 참조하고 있어 지우면 예약의 게스트가
사라집니다. 예약을 정본으로 옮기고 원본에는 어디로 합쳐졌는지만 남깁니다. 양쪽 모두
OPERA 프로필이면 Core 를 거쳐 **OPERA 에서 먼저 합칩니다** — 로컬만 합치면 OPERA 에는
여전히 둘이고 다음 동기화가 지운 쪽을 되살립니다. OPERA 가 거절하면 로컬도 건드리지
않습니다. 한쪽만 합쳐진 상태가 가장 나쁩니다.

중복 후보는 자동으로 합치지 않고 근거(이메일·전화·이름·멤버십 번호 일치)만 보여 줍니다.
이름이 같은 다른 사람은 흔하고, 잘못 합치면 남의 투숙 이력과 선호가 섞입니다.

예약을 만들 때 이메일로 아는 손님이면 그 OPERA 프로필 ID 를 함께 보냅니다. 보내지 않으면
OPERA 가 매번 새 프로필을 만들어 재방문 손님마다 중복이 쌓입니다 — 만들지 않는 편이
지우는 것보다 훨씬 쌉니다.

프로필에는 호텔 범위가 없습니다. 같은 손님이 여러 호텔에 묵기 때문입니다. 대신 투숙
이력은 요청자가 볼 수 있는 호텔로 좁힙니다.

예약 경로는 OPERA 를 따라 **세 축**으로 나눕니다: `sourceCode`(받은 방법) ·
`marketCode`(손님 성격) · `channelCode`(구체적인 판매 채널). 하나로 합치면 "OTA 를 통해
들어온 법인 예약" 같은 조합을 구분할 수 없어 채널별 수익성 판단이 무너집니다. 허용 코드
검증은 OPERA 가 합니다 — 호텔마다 설정이 다르므로 BE·FE 에 목록을 박아 두면 설정이
바뀔 때마다 세 곳을 고쳐야 합니다.

실적은 채널·출처·시장별로 분해해 함께 내려보냅니다. 코드가 비어 있는 예약은 `(미지정)`
으로 모읍니다 — 빼 버리면 분해 합계가 전체와 어긋나 어느 쪽이 맞는지 알 수 없게 됩니다.

점유율의 분모는 **현재** 고장·판매중지가 아닌 객실 수입니다. 과거 시점의 고장 이력은
남기지 않으므로 그때의 실제 가용 객실과 다를 수 있고, 이 근거를 응답과 화면에 함께
표시합니다. 회계 마감용 공식 수치는 OPERA 의 리포트를 따릅니다.

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

### 하우스키핑

**객실 상태는 OPERA 가 원천**이라 변경을 위임합니다. 프론트데스크의 재고 판단과
하우스키핑의 청소 상태가 같은 값을 봐야 하는데, PlanForge 가 따로 들고 있으면
체크인 가능 여부가 두 시스템에서 달라집니다.

반면 **"누가 어느 객실을 청소하는가"는 PlanForge 가 소유**합니다. 직원 근무 편성이라
OPERA 에 보낼 성질이 아닙니다. `HousekeepingTask` 가 이를 담습니다.

작업 상태(`TaskStatus`)와 객실 상태(`RoomStatus`)는 다릅니다 — 앞은 "직원이 어디까지
했는가", 뒤는 "객실이 팔 수 있는 상태인가" 입니다.

하우스키핑 역할은 **본인에게 배정된 작업만** 조회·변경할 수 있습니다. 남의 작업을
완료 처리하면 실제로는 청소되지 않은 객실이 판매 가능으로 올라갑니다.

`/housekeeping/discrepancies` 는 객실 상태와 재실이 어긋난 곳을 뽑습니다 — 체크아웃
누락, 배정 불일치, 재실 중 청소 완료 표시. 하우스키핑이 매일 확인하는 항목입니다.

### 다중 호텔과 데이터 격리

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/api/properties` | 접근 가능한 호텔 목록 (전 역할) |
| `GET` | `/api/properties/:id` | 호텔 단건 |
| `GET` | `/api/properties/:id/room-types` | 호텔의 객실 타입 목록 |
| `POST` | `/api/properties` | 호텔 등록 (ADMIN) |
| `PATCH` | `/api/properties/:id` | 호텔 수정 · 운영 중단 (ADMIN) |

계정의 `propertyId` 가 접근 범위를 정합니다.

- **소속 없음(본사)** — 호텔을 지정해 조회할 수 있고, 생략하면 전 호텔을 봅니다.
- **소속 있음** — 자기 호텔로 고정됩니다. 다른 호텔을 지정하면 403 입니다.

이것이 다중 호텔에서 가장 중요한 경계입니다. 소속 직원이 쿼리스트링의 `propertyId`
만 바꿔 남의 호텔 예약과 게스트 정보를 열람할 수 있으면, 역할 검사를 아무리 촘촘히
해도 소용이 없습니다. 목록은 범위로 걸러지고, 단건 조회·체크인/아웃·폴리오는 대상의
호텔을 다시 확인합니다 — ID 만 알면 닿는 경로이기 때문입니다.

관리자는 본사 계정(`propertyId=null`)으로 두어야 합니다. 특정 호텔에 묶으면 다른
호텔의 등록도 직원 배치도 막힙니다. 시드가 그렇게 만듭니다.

### 계정 관리

퇴사는 **삭제가 아니라 비활성화**(`active=false`)로 처리합니다. 계정을 지우면 그 사람이
남긴 예약·거래 이력의 주체를 추적할 수 없게 됩니다. 비활성 계정은 즉시 로그인이 막히고,
발급받은 토큰이 남아 있어도 `/auth/me` 가 매번 확인하므로 다음 요청부터 차단됩니다.

두 가지 조합을 막습니다. 둘 다 복구하려면 DB 를 직접 건드려야 해서 대가가 큽니다.

- **자기 잠김** — 자기 계정을 비활성화하거나 자기 역할을 바꿀 수 없습니다.
- **마지막 관리자 상실** — 활성 관리자가 하나뿐이면 강등도 비활성화도 거절합니다.

비밀번호는 관리자가 초기화할 수 있고(현재 비밀번호 불필요), 본인 변경은 반드시 현재
비밀번호를 확인합니다 — 자리를 비운 사이 남이 세션을 잡으면 확인 없이는 비밀번호를
갈아 끼워 계정을 통째로 뺏을 수 있습니다.

로그인은 **IP 당 5분에 10회**로 제한합니다. 전역 제한(분당 120회)만으로는 비밀번호를
수천 번 시도하기에 충분하기 때문입니다. 제한에 걸리면 올바른 자격으로도 429 를 받습니다.
리버스 프록시 뒤에 둘 때는 `TRUST_PROXY=true` 를 켜야 합니다 — 켜지 않으면 모든 요청이
프록시 IP 하나로 집계되어 한 사람이 전체 로그인을 잠급니다.

## 배포

`Dockerfile` 로 이미지를 만듭니다. 멀티스테이지에 비-root(`node`) 실행이며,
`/api/health` 를 보는 HEALTHCHECK 가 들어 있습니다.

```bash
docker build -t planforge-be .
```

기동 시 `docker-entrypoint.sh` 가 `prisma migrate deploy` 를 먼저 돌립니다.
`migrate deploy` 는 잠금을 잡고 이미 적용된 것을 건너뛰므로 여러 인스턴스가 동시에
떠도 한 번만 실행됩니다. 별도 잡으로 빼려면 `RUN_MIGRATIONS=false` 로 끄세요.

전체 스택은 `deploy/docker-compose.yml` 로 띄웁니다.

```bash
cd deploy
cp .env.example .env    # 값 채우기
docker compose up -d
```

외부에 노출되는 것은 FE 뿐이고 BE·Core·PostgreSQL 은 내부 네트워크에만 둡니다.
Core 는 OPERA 자격 증명을 들고 있어 절대 외부에 열지 않습니다.

이미지는 태그를 밀 때만 GHCR 에 발행됩니다 (`.github/workflows/release.yml`).
main 에 푸시할 때마다 올리면 무엇이 배포되어 있는지 추적할 수 없고 롤백 지점도
사라지기 때문입니다.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

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

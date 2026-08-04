<div align="center">

# PlanForge BE

**Business logic server for the hotel management platform**

Reservations, front desk, housekeeping, accounting, POS and room keys. Writes to OPERA are delegated
to Core and the results mirrored locally.

[한국어](README.md) · **English** · [中文](README.zh.md) · [日本語](README.ja.md)

![TypeScript](https://img.shields.io/badge/TypeScript-83.2%25-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-5.1%25-2D3748?style=flat-square&logo=prisma&logoColor=white)
![SQL](https://img.shields.io/badge/SQL-3.7%25-336791?style=flat-square&logo=postgresql&logoColor=white)
![Markdown](https://img.shields.io/badge/Markdown-3.1%25-083FA1?style=flat-square)
![YAML](https://img.shields.io/badge/YAML-2.0%25-CB171E?style=flat-square)
![Docker](https://img.shields.io/badge/Docker-0.5%25-2496ED?style=flat-square&logo=docker&logoColor=white)

</div>

---

## Background

The goal is to **add operational tooling on top of Oracle OPERA rather than replace the PMS.** OPERA
is the system of record for reservations, inventory and rates; BE keeps a copy and adds what daily
operations actually need.

The boundary is explicit:

| Owned by OPERA | Owned by PlanForge |
| --- | --- |
| Reservations · inventory · rates · confirmation numbers | Housekeeping task assignment |
| Guest name and contact details | Preferences · internal notes |
| Block allotment and pickup | POS outlet keys · room-key history |
| Business date | Staff accounts · permissions |

**Every write goes to OPERA first, and the local copy is filled from what comes back.** Writing what
we sent would lose whatever OPERA adjusted. Local records are a cache that makes lists and search
fast.

### Platform

| Repository | Role |
| --- | --- |
| [PlanForge-Package-FE](https://github.com/PlanForge-Package/PlanForge-Package-FE) | Operator / front-desk web UI |
| **PlanForge-Package-BE** | **Business logic · own database** |
| [PlanForge-Package-Core](https://github.com/PlanForge-Package/PlanForge-Package-Core) | Oracle OPERA (OHIP) integration API server |

Call path: `FE → BE → Core → OPERA Cloud (OHIP)`

---

## Language & stack

| Area | Technology |
| --- | --- |
| Language | TypeScript 5.9 (strict) |
| Runtime | Node.js 20.11+ |
| Framework | NestJS 10 |
| Database | PostgreSQL 16 |
| ORM | Prisma 6 — migration-driven schema |
| Auth | JWT (`@nestjs/jwt`) · bcryptjs · global guards |
| Validation | class-validator · class-transformer (whitelist · forbidNonWhitelisted) |
| Rate limiting | `@nestjs/throttler` — login limited separately to 10 per 5 minutes |
| API docs | `@nestjs/swagger` (`/docs`) |
| Tests | Jest — 237 cases |
| Quality | ESLint · Prettier · GitHub Actions |
| Deployment | Docker · docker-compose |
| Package manager | pnpm 9 |

---

## Directory structure

```
prisma/
├── schema.prisma                 Data model (mirrors OPERA concepts)
├── migrations/                   Migration history
└── seed.ts                       Idempotent seed — 2 hotels · one account per role · reservations

src/
├── auth/                         Login · JWT guard · roles guard · login throttle
├── users/                        Account management (hire · role · property · leave)
├── properties/
│   ├── property-scope.ts         Multi-hotel access boundary — the heart of isolation
│   └── properties.service.ts     Hotels · room types
├── core/                         Core (OHIP) HTTP client · error translation
├── reservations/
│   ├── booking.service.ts        Create · amend · cancel · no-show — delegate then mirror
│   └── reservations.service.ts   List · check-in · check-out
├── blocks/                       Group blocks · rooming list
├── profiles/                     Guest profiles · preferences · duplicate merge
├── folios/                       Folios · postings
├── payments/
│   ├── payment.driver.ts         PSP driver interface
│   ├── mock-payment.driver.ts    Mock PSP
│   └── payments.service.ts       Authorize · capture · void · refund
├── pos/
│   ├── pos-key.guard.ts          Outlet API key authentication
│   ├── pos.service.ts            Room charge · void (duplicate-safe)
│   └── outlets.service.ts        Outlet issue · rotate · deactivate
├── doorlock/
│   ├── doorlock.driver.ts        Door lock driver interface
│   ├── mock-doorlock.driver.ts   Mock door lock
│   ├── local-time.ts             Hotel local time → UTC
│   └── doorlock.service.ts       Issue · revoke · automatic recovery
├── housekeeping/                 Task assignment · room status · discrepancy detection
├── night-audit/                  Close-of-day checklist · no-show
├── reports/                      Occupancy · ADR · RevPAR · channel breakdown
├── rooms/                        Room list · status summary
├── sync/                         OPERA reservation sync · mappers
└── main.ts
```

---

## Getting started

### Requirements

- Node.js 20.11+
- pnpm 9
- PostgreSQL 16
- A running [PlanForge Core](https://github.com/PlanForge-Package/PlanForge-Package-Core)

### Install and run

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL · JWT_SECRET · CORE_BASE_URL

pnpm prisma:deploy            # apply migrations
pnpm prisma:seed              # seed data
pnpm start:dev
```

| URL | Purpose |
| --- | --- |
| `http://localhost:3001/api` | API |
| `http://localhost:3001/docs` | Swagger UI |
| `http://localhost:3001/api/health` | Health check (unauthenticated) |

### Seed accounts

All passwords are `planforge` (override with `SEED_PASSWORD`).

| Email | Role | Property |
| --- | --- | --- |
| `admin@planforge.local` | ADMIN | Head office (all hotels) |
| `manager@planforge.local` | MANAGER | PlanForge Seoul |
| `frontdesk@planforge.local` | FRONT_DESK | PlanForge Seoul |
| `housekeeping@planforge.local` | HOUSEKEEPING | PlanForge Seoul |

### Commands

| Command | Description |
| --- | --- |
| `pnpm start:dev` | Development server (watch) |
| `pnpm build` / `pnpm start:prod` | Build / production run |
| `pnpm test` / `pnpm test:cov` | Jest |
| `pnpm prisma:deploy` / `pnpm prisma:seed` | Migrate / seed |
| `pnpm prisma:studio` | Prisma Studio |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | Quality checks |

### Environment variables

| Name | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | **32 characters or more.** Shorter values refuse to boot |
| `JWT_EXPIRES_IN` | Token lifetime (default `12h`) |
| `CORE_BASE_URL` | Core API URL (default `http://localhost:3002`) |
| `CORE_API_KEY` | Must match Core's `SERVICE_API_KEY` |
| `DOORLOCK_MODE` | `mock` \| `live` — defaults to `mock` |
| `PAYMENT_MODE` | `mock` \| `live` — defaults to `mock` |
| `SEED_PASSWORD` | Seed account password (8+ characters) |

With `NODE_ENV=production`, the server **refuses to boot** unless `DOORLOCK_MODE` and
`PAYMENT_MODE` are `live`. The worst outcome is front desk believing a key was encoded when the
guest cannot open the door, or believing a payment succeeded when no money arrived.

### Deployment

```bash
cd deploy && docker compose up -d
```

`deploy/docker-compose.yml` brings up PostgreSQL, Core, BE and FE together. Core stays on the
internal network with no published ports.

---

## Endpoints

<details>
<summary><b>Auth · accounts · properties</b></summary>

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Login (public) |
| `GET` | `/api/auth/me` | Current account |
| `POST` | `/api/auth/change-password` | Change own password |
| `GET` `POST` | `/api/users` | List · create accounts (ADMIN) |
| `PATCH` | `/api/users/:id` | Role · property · active flag (ADMIN) |
| `POST` | `/api/users/:id/password` | Reset password (ADMIN) |
| `GET` | `/api/properties` | Accessible hotels |
| `GET` | `/api/properties/:id/room-types` | Room types of a hotel |
| `POST` `PATCH` | `/api/properties` | Register · amend hotel (ADMIN) |
| `GET` | `/api/health` | Service · DB status (public) |

</details>

<details>
<summary><b>Reservations · folios · payments</b></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/reservations` | Reservation list (status · channel · search) |
| `GET` | `/api/reservations/summary` | Today's arrivals · departures · in-house |
| `GET` | `/api/reservations/:id` | Single reservation (with folios) |
| `POST` | `/api/reservations/:id/check-in` | Check in — assign room · open folio |
| `POST` | `/api/reservations/:id/check-out` | Check out — close folio · release room |
| `GET` `POST` | `/api/reservations/:id/folios` | Folios · open a window |
| `POST` | `/api/reservations/:id/folios/:window/postings` | Post a charge or payment |
| `POST` | `/api/reservations/:id/folios/postings/:postingId/transfer` | Move a posting to another window |
| `GET` `POST` | `/api/reservations/:id/folios/routings` | Read · set routing instructions |
| `DELETE` | `/api/reservations/:id/folios/routings/:transactionCode` | Clear a routing instruction |
| `GET` | `/api/reservations/:id/payments` | Payment history |
| `POST` | `/api/reservations/:id/folios/:window/payments` | Authorize |
| `POST` | `/api/payments/:id/capture` `\|` `/void` | Capture · void |
| `POST` | `/api/payments/:id/refund` | Refund (MANAGER) |
| `GET` | `/api/cashier/shifts/current` | My open shift and its totals |
| `GET` | `/api/cashier/shifts` `\|` `/api/cashier/shifts/:id` | Past shifts · detail |
| `POST` | `/api/cashier/shifts` | Open a shift (with the opening float) |
| `POST` | `/api/cashier/shifts/:id/close` | Close — records the variance |
| `GET` | `/api/traces` | Traces by date and department |
| `GET` `POST` | `/api/reservations/:id/traces` | Read · add traces on a reservation |
| `PATCH` | `/api/traces/:id/complete` | Mark done |
| `DELETE` | `/api/traces/:id` | Withdraw (pending only) |

</details>

<details>
<summary><b>Blocks · profiles · room keys</b></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/blocks` | Group block list |
| `GET` | `/api/blocks/:id` | Block detail — allotment and pickup by date |
| `GET` | `/api/blocks/:id/reservations` | Rooming list |
| `POST` `PATCH` | `/api/blocks` | Create · amend block (MANAGER) |
| `GET` | `/api/profiles` | Profile search |
| `GET` | `/api/profiles/:id` | Profile detail — stay history |
| `GET` | `/api/profiles/:id/duplicates` | Duplicate candidates and evidence |
| `PATCH` | `/api/profiles/:id` | Preferences · membership · notes |
| `POST` | `/api/profiles/:id/merge` | Merge duplicates (MANAGER) |
| `GET` `POST` | `/api/reservations/:id/keys` | Room-key history · issue |
| `POST` | `/api/door-keys/:keyId/revoke` | Revoke a room key |

</details>

<details>
<summary><b>Housekeeping · night audit · reports · POS</b></summary>

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/rooms` `\|` `/api/rooms/summary` | Room list · status summary |
| `GET` `POST` | `/api/housekeeping/tasks` | Daily tasks · generate |
| `PATCH` | `/api/housekeeping/tasks/:id[/assign]` | Assign · progress |
| `PATCH` | `/api/housekeeping/rooms/:id/status` | Room status (delegated to OPERA) |
| `GET` | `/api/room-outages` | Out-of-order / out-of-service rooms |
| `POST` | `/api/room-outages` | Take a room out (delegated to OPERA) |
| `DELETE` | `/api/room-outages/:id` | Put it back on sale (delegated to OPERA) |
| `GET` | `/api/housekeeping/discrepancies` | Status vs occupancy mismatches |
| `GET` | `/api/night-audit` | Close-of-day checklist |
| `POST` | `/api/night-audit/reservations/:id/no-show` | Mark no-show |
| `GET` | `/api/reports/daily` | Occupancy · ADR · RevPAR · channel breakdown (MANAGER) |
| `GET` `POST` `PATCH` | `/api/pos-outlets` | POS outlet management (MANAGER) |
| `GET` `POST` | `/api/pos/rooms` `\|` `/api/pos/charges[/void]` | Room charge (outlet key) |
| `POST` `GET` | `/api/sync/reservations` `\|` `/api/sync/logs` | OPERA sync · history |

</details>

---

## Design decisions

### Auth and permissions

**Every** route without `@Public()` requires a valid bearer token. Defaulting to "protected" rather
than maintaining a whitelist matters because forgetting protection on a new controller is far more
dangerous than the reverse. Only `/api/auth/login` and `/api/health` are public.

`property-scope.ts` is the whole of multi-hotel isolation. Accounts assigned to a property cannot
reach another hotel's data: lists narrow automatically and single-record reads verify scope — a
leaked confirmation number or URL must not open another hotel's reservation.

### Check-in / check-out

Room assignment, reservation status and folio must all hold together, so they run in one
transaction. Double-assigning an occupied room, assigning an out-of-order room, and checking out
with an outstanding balance are all rejected.

### Night audit

**OPERA runs the audit itself** — rolling the business date and auto-posting room and tax is the
PMS's job, and imitating it would split revenue across two systems. What `/api/night-audit` does is
show **what would be left wrong if you closed now**: pending arrivals, pending departures,
in-house without a room, folios with a balance, and room-status mismatches.

### Reports

Two kinds of revenue are kept apart:

- **Room revenue (contracted)** — reservation total spread across nights. The basis for occupancy, ADR and RevPAR
- **Folio charges (actual)** — charges, payments and adjustments posted to folios; only exist after check-in

Mixing them makes "why is revenue different?" unanswerable. Reconciliation uses postings; sales
metrics use the contracted basis. `Posting.amount` is already signed at write time (payments are
negative), so outstanding is a plain sum.

The occupancy denominator is the number of rooms **currently** not out of order or out of service.
Historical out-of-order records are not kept, so it may differ from what was actually sellable then
— and that basis is stated in both the response and the screen.

### Guest profiles

Names and contact details are a copy of the OPERA profile; **preferences and internal notes belong
to PlanForge.** Preferences are stored as codes, not free text — free text lets "고층", "높은 층"
and "high floor" coexist, and then nobody can filter on them during assignment.

Merging never deletes the source. Past reservations reference it, so deleting would erase the guest
from those stays. When both sides are OPERA profiles the merge is **performed in OPERA first** via
Core — merging only locally lets the next sync resurrect the one you removed. If OPERA refuses,
nothing local changes either.

### Room keys (door locks)

Door lock protocols differ completely by vendor — Assa Abloy (Vingcard), Salto and Onity disagree on
card encoding and on how you connect. Only the `DoorLockDriver` interface is known to the domain;
actual communication lives in one implementation file.

The most dangerous failure is **a key left alive and forgotten**: a checked-out guest's card opens a
room the next guest has moved into. So check-out and room changes revoke remaining keys
automatically, and if that call fails the check-out or room change is rolled back too. Revocation
goes to the **vendor first**, then marks locally — the reverse order would leave a card recorded as
dead while it still opens the door.

### Payments

Authorize → capture → (if needed) refund are kept as three distinct steps. **The folio is credited
at capture** — reducing the balance on authorization alone would record money as received when the
capture later fails.

**Card numbers and CVV are never stored.** The terminal talks to the PSP directly and we receive
only the resulting token; the masked last digits and the transaction id are all that remain.

An idempotency key blocks retries from charging twice. Money leaving a guest's account twice is
harder to undo than almost anything else. An indeterminate result (timeout) records nothing —
consuming the idempotency key would prevent retrying with the same key and block any check of
whether the authorization actually went through.

### POS interface

**Staff JWTs are not used.** That would put a staff password on a terminal and grant that terminal
every staff permission. Each outlet gets its own key (`x-pos-key`), and that key can only post a
charge to an in-house room and void charges it created. The room list returns **only the room number
and surname**.

A `(outletId, reference)` unique constraint blocks duplicate charges, and a retransmission returns
the existing charge as a success rather than posting again — otherwise the POS keeps retrying.

---

## Licence

UNLICENSED — internal use only.

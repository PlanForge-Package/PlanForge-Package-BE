import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ArModule } from './ar/ar.module';
import { AuthModule } from './auth/auth.module';
import { BlocksModule } from './blocks/blocks.module';
import { CashierModule } from './cashier/cashier.module';
import { CoreModule } from './core/core.module';
import { DoorLockModule } from './doorlock/doorlock.module';
import { FoliosModule } from './folios/folios.module';
import { HealthModule } from './health/health.module';
import { HousekeepingModule } from './housekeeping/housekeeping.module';
import { NightAuditModule } from './night-audit/night-audit.module';
import { PrismaModule } from './prisma/prisma.module';
import { PaymentsModule } from './payments/payments.module';
import { PosModule } from './pos/pos.module';
import { ProfilesModule } from './profiles/profiles.module';
import { PropertiesModule } from './properties/properties.module';
import { RatesModule } from './rates/rates.module';
import { ReportsModule } from './reports/reports.module';
import { ReservationsModule } from './reservations/reservations.module';
import { RoomOutagesModule } from './room-outages/room-outages.module';
import { RoomsModule } from './rooms/rooms.module';
import { SyncModule } from './sync/sync.module';
import { TracesModule } from './traces/traces.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    // Global default limit. Login is bounded far more tightly in auth/throttle.ts.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    ArModule,
    AuthModule,
    BlocksModule,
    CashierModule,
    CoreModule,
    DoorLockModule,
    HealthModule,
    FoliosModule,
    HousekeepingModule,
    NightAuditModule,
    PaymentsModule,
    PosModule,
    ProfilesModule,
    PropertiesModule,
    RatesModule,
    ReportsModule,
    ReservationsModule,
    RoomOutagesModule,
    RoomsModule,
    SyncModule,
    TracesModule,
    UsersModule,
  ],
  providers: [
    // Login is @Public(), so the auth guard passes it straight through; this guard
    // counts attempts before the bcrypt password check is reached.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

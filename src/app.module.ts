import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { FoliosModule } from './folios/folios.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { ReservationsModule } from './reservations/reservations.module';
import { RoomsModule } from './rooms/rooms.module';
import { SyncModule } from './sync/sync.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    // 전역 기본 제한. 로그인은 auth/throttle.ts 에서 훨씬 좁게 다시 잡는다.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    CoreModule,
    HealthModule,
    FoliosModule,
    ReservationsModule,
    RoomsModule,
    SyncModule,
    UsersModule,
  ],
  providers: [
    // 로그인은 @Public() 이라 인증 가드가 즉시 통과시키므로, 비밀번호 검증(bcrypt)에
    // 도달하기 전에 이 가드가 횟수를 센다.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

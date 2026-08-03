import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

@Global()
@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');

        // 비밀키 없이 뜨면 아무나 토큰을 위조할 수 있다. 개발이라도 기동을 막는다.
        if (!secret || secret.length < 32) {
          throw new Error(
            'JWT_SECRET 이 없거나 너무 짧습니다(32자 이상 필요). .env 를 확인해 주세요.',
          );
        }

        return {
          secret,
          // @nestjs/jwt 11 은 expiresIn 을 ms 의 리터럴 유니온으로 좁혀 두어
          // 환경변수에서 온 string 을 그대로 받지 못한다. 값 검증은 위에서 끝냈다.
          signOptions: {
            expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '8h') as `${number}h`,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // 순서가 중요하다. 인증이 먼저 돌아 request.user 를 심어야 역할 검사가 가능하다.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}

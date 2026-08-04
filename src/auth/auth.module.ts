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

        // Booting without a secret lets anyone forge a token. Blocked even in development.
        if (!secret || secret.length < 32) {
          throw new Error(
            'JWT_SECRET 이 없거나 너무 짧습니다(32자 이상 필요). .env 를 확인해 주세요.',
          );
        }

        return {
          secret,
          // @nestjs/jwt 11 narrows expiresIn to ms's literal union and will not take a
          // string from the environment. The value is already validated above.
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
    // Order matters. Auth has to run first and set request.user before roles can be checked.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}

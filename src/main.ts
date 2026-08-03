import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const isProduction = process.env.NODE_ENV === 'production';

  app.use(helmet());

  // 리버스 프록시 뒤에서 뜨면 클라이언트 IP 가 전부 프록시 주소로 보인다.
  // 요청 제한이 IP 로 세는 이상, 이걸 켜지 않으면 한 사람이 전체를 잠글 수 있다.
  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',').map((value) => value.trim()) ?? true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // 운영에서는 API 스펙을 공개하지 않는다. 엔드포인트 목록은 공격면을 넓힌다.
  if (!isProduction || process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('PlanForge BE')
      .setDescription('호텔 관리 플랫폼 업무 로직 API')
      .setVersion('0.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  // 종료 신호를 받으면 진행 중인 요청을 마무리하고 DB 연결을 닫는다.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`PlanForge BE listening on port ${port}`);
}

void bootstrap();

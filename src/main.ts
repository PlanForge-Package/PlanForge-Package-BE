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

  // Behind a reverse proxy, every client IP looks like the proxy's address.
  // Since rate limiting counts by IP, without this one person can lock everyone out.
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

  // The API spec is not published in production. A list of endpoints widens the attack surface.
  if (!isProduction || process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('PlanForge BE')
      .setDescription('호텔 관리 플랫폼 업무 로직 API')
      .setVersion('0.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  // On a shutdown signal, in-flight requests finish and the DB connection closes.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`PlanForge BE listening on port ${port}`);
}

void bootstrap();

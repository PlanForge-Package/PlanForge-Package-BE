import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { PrismaService } from '../prisma/prisma.service';

describe('HealthController', () => {
  it('데이터베이스가 응답하면 ok 를 반환한다', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    const controller = moduleRef.get(HealthController);
    await expect(controller.check()).resolves.toEqual({ status: 'ok', database: 'up' });
  });

  it('데이터베이스가 실패하면 degraded 를 반환한다', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: PrismaService,
          useValue: { $queryRaw: jest.fn().mockRejectedValue(new Error('down')) },
        },
      ],
    }).compile();

    const controller = moduleRef.get(HealthController);
    await expect(controller.check()).resolves.toEqual({ status: 'degraded', database: 'down' });
  });
});

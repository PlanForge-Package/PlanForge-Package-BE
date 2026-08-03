import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.constants';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // 로드밸런서·모니터링이 토큰 없이 찔러야 하므로 공개한다.
  @Public()
  @Get()
  @ApiOperation({ summary: '서비스 및 데이터베이스 상태 확인' })
  async check(): Promise<{ status: string; database: string }> {
    let database = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = 'up';
    } catch {
      database = 'down';
    }

    return { status: database === 'up' ? 'ok' : 'degraded', database };
  }
}

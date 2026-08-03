import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from './auth.constants';
import { Public } from './auth.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { AuthUserDto, LoginDto, LoginResponseDto } from './dto/auth.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '로그인 후 액세스 토큰 발급' })
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.auth.login(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: '현재 로그인한 계정 조회' })
  me(@CurrentUser() user: AuthUser): Promise<AuthUserDto> {
    return this.auth.me(user.id);
  }
}

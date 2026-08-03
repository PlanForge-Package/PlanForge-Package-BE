import { Global, Module } from '@nestjs/common';
import { CoreClient } from './core.client';

@Global()
@Module({
  providers: [CoreClient],
  exports: [CoreClient],
})
export class CoreModule {}

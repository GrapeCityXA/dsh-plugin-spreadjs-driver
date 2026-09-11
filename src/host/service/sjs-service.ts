import { Context, Service } from '@deepseek-ai/cordis'
import type { SjsServiceMethods } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sjs: SjsService
  }
}

/** Service Definition for all host-side SpreadJS operations. */
export abstract class SjsService extends Service implements SjsServiceMethods {
  constructor(ctx: Context) {
    super(ctx, 'sjs')
  }

  abstract newFile(...args: Parameters<SjsServiceMethods['newFile']>): ReturnType<SjsServiceMethods['newFile']>
  abstract status(...args: Parameters<SjsServiceMethods['status']>): ReturnType<SjsServiceMethods['status']>
  abstract execute(...args: Parameters<SjsServiceMethods['execute']>): ReturnType<SjsServiceMethods['execute']>
  abstract importFile(...args: Parameters<SjsServiceMethods['importFile']>): ReturnType<SjsServiceMethods['importFile']>
  abstract exportFile(...args: Parameters<SjsServiceMethods['exportFile']>): ReturnType<SjsServiceMethods['exportFile']>
  abstract screenshot(...args: Parameters<SjsServiceMethods['screenshot']>): ReturnType<SjsServiceMethods['screenshot']>
  abstract worktreeCreate(...args: Parameters<SjsServiceMethods['worktreeCreate']>): ReturnType<SjsServiceMethods['worktreeCreate']>
  abstract worktreeList(...args: Parameters<SjsServiceMethods['worktreeList']>): ReturnType<SjsServiceMethods['worktreeList']>
}

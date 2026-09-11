import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable spreadjs domain error retained by DSH tool results and replay. */
export class SjsError extends HarnessError {
  /** Create a classified spreadjs error. */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}

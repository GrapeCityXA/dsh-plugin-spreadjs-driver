import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Optional image-attachment seam for the PNG screenshot path (read_image
 * pattern, task 7). A snapshot is a convenience, never a hard dependency: when
 * the calling route is image-capable AND a durable attachment store is mounted
 * AND the deployment accepts PNG, the png bytes are stored and an `image` block
 * is attached to the tool result so a vision model can actually see the table.
 * Every missing/refused condition degrades to the plain text/file-path result —
 * a failed preview must never fail the snapshot itself.
 */

/** The minimal `llm` service surface used to probe the calling route. */
interface LlmLike {
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>
}

/** Outcome of a PNG preview attach attempt. */
export type PngAttachment =
  | { attached: true; ref: ImageAttachmentRef }
  | { attached: false }

/**
 * Try to durably store `outputPath`'s PNG bytes as an image the calling model
 * can see. Resolves `{ attached: false }` on every non-fatal condition (store
 * missing, png not accepted, route not image-capable, unreadable file, storage
 * error) — never throws.
 */
export async function attachPngSnapshot(ctx: Context, exec: ToolRunContext, outputPath: string): Promise<PngAttachment> {
  const attachments = ctx.get('attachments') as AttachmentStore | undefined
  if (attachments === undefined) return { attached: false }
  if (!attachments.imageLimits.mediaTypes.includes('image/png')) return { attached: false }
  if (!(await imageCapableRoute(ctx, exec))) return { attached: false }
  let data: Uint8Array
  try {
    data = await readFile(outputPath)
  } catch {
    return { attached: false }
  }
  try {
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: basename(outputPath) })
    return { attached: true, ref }
  } catch {
    return { attached: false }
  }
}

/** Whether the calling model route declares image input (mirror of read_image). */
async function imageCapableRoute(ctx: Context, exec: ToolRunContext): Promise<boolean> {
  const llm = ctx.get('llm') as LlmLike | undefined
  if (llm?.resolveModelInfo === undefined) return false
  const routed = exec.agent?.session.requestHeader?.()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  if (provider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/**
 * Rebuild a typed attachment reference from the fields serialized under
 * `result.image` (a snapshot value crosses the JSON boundary). Accepts a
 * live `ImageAttachmentRef` as-is. Returns undefined for a malformed shape.
 */
export function imageRefFromValue(image: unknown): ImageAttachmentRef | undefined {
  if (image === null || typeof image !== 'object') return undefined
  const candidate = image as {
    attachmentId?: string
    mediaType?: ImageAttachmentRef['mediaType']
    bytes?: number
    width?: number
    height?: number
    name?: string
  }
  const { attachmentId, mediaType, bytes, width, height } = candidate
  if (
    typeof attachmentId !== 'string' ||
    typeof mediaType !== 'string' ||
    typeof bytes !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number'
  ) {
    return undefined
  }
  const ref: ImageAttachmentRef = {
    attachmentId: attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: mediaType as ImageAttachmentRef['mediaType'],
    bytes,
    width,
    height,
    ...(candidate.name === undefined ? {} : { name: candidate.name }),
  }
  return ref
}

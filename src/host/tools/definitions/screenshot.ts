import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '../../service/types.ts'
import type { SjsOperationResult } from '../../service/types.ts'
import { attachPngSnapshot, imageRefFromValue } from '../attachments.ts'
import { operationOutput, operationTitle, renderSjsOperationResult } from '../presentation.ts'
import { existingToolWorkbook, newToolScreenshotOutput } from '../workspace.ts'

/**
 * Create the `sjs_screenshot` tool definition — render a visual snapshot of a
 * canonical .ssjson workbook.
 *
 * format 'png' rasterizes the active sheet in the headless worker and writes a
 * real PNG (values, colors, borders, merges and layout; text is re-rendered in
 * one readable CJK-capable font, so per-cell font/weight variety is flattened).
 * When the calling route is image-capable and a durable attachment store is
 * mounted, the PNG is additionally attached to the result as an image block so
 * a vision model can actually see it; otherwise the snapshot degrades to a
 * plain text result naming the file. format 'pdf' writes the print-layout
 * snapshot via the PDF backend. The source workbook is never modified.
 */
export function screenshotTool(ctx: Context, timeoutMs: number) {
  return defineTool({
    name: 'sjs_screenshot',
    description:
      'Render a visual snapshot of a .ssjson workbook to a file. ' +
      "Formats: png (pixel render of the active sheet; use to 'see' the table — layout, colors, borders and text), " +
      'pdf (print-layout snapshot with embedded fonts). ' +
      'png text is re-rendered in a single readable CJK-capable font (per-cell font variety is flattened); the source workbook is never modified. ' +
      'A png snapshot is attached as an image when the current model accepts image input; on a text-only route the image cannot be seen at all (read_image refuses too), so verify the layout numerically or export a pdf instead. ' +
      'The output extension must match the format.',
    timeoutMs,
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute .ssjson workbook path to snapshot.',
      },
      output: {
        type: 'string',
        required: true,
        description: 'Workspace-relative or absolute output path ending in .png or .pdf (created; never overwrites).',
      },
      format: {
        type: 'string',
        required: true,
        enum: ['png', 'pdf'],
        description: 'Snapshot format. The output extension must match (e.g. .png for png).',
      },
    },
    output: {
      schema: operationOutput.schema,
      render: (args: unknown, value: SjsOperationResult): ContentBlock[] => {
        const blocks: ContentBlock[] = [{ type: 'text', text: renderSjsOperationResult(value) }]
        const image = imageRefFromValue(
          value.result !== null && typeof value.result === 'object'
            ? (value.result as { image?: unknown }).image
            : undefined,
        )
        if (image !== undefined) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    async execute(args, exec) {
      const source = await existingToolWorkbook(exec, args.file)
      const output = await newToolScreenshotOutput(exec, args.output, args.format)
      let value: SjsOperationResult = await ctx.sjs.screenshot(
        { workspace: source.workspace, filePath: source.path, outputPath: output.path, format: args.format },
        exec.signal,
      )
      if (args.format === 'png' && value.ok && value.result !== null && typeof value.result === 'object') {
        const shot = await attachPngSnapshot(ctx, exec, output.path)
        if (shot.attached) {
          // Carry the durable reference under `result.image` so the render pass
          // can emit the image block (and the model sees it in the JSON text).
          const merged = { ...(value.result as Record<string, JsonValue>), image: shot.ref } as unknown as JsonValue
          value = { ...value, result: merged }
        }
      }
      return value
    },
    presentCall: (args) => ({ card: 'generic', title: operationTitle(`screenshot-${args.format}`, args.file), kind: 'execute' }),
  })
}

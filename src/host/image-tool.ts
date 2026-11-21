// agy_image — in-session DSH tool allowing any model to generate or edit
// images through Antigravity's built-in generate_image / image-generator via
// the shared ImageService (reusing the account pool, quota rotation, region
// failover, and artifact validation).
import { pathToFileURL } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageRequest, ImageResult, ImageService } from './image.ts'
import { SUPPORTED_ASPECT_RATIOS } from './image.ts'

export function formatImageResultMarkdown(res: ImageResult): string {
  const uri = pathToFileURL(res.path).href
  const metaParts = [
    `${res.width}×${res.height}`,
    res.aspectRatio,
    res.mime,
    res.bytes >= 1024 * 1024 ? `${(res.bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.round(res.bytes / 1024)} KB`,
    `${(res.durationMs / 1000).toFixed(1)}s`,
    res.model,
    ...(res.accountId ? [`account: ${res.accountId}`] : []),
  ]
  return [
    `![${res.name || 'agy-image'}](${uri})`,
    '',
    `- **Path**: \`${res.path}\``,
    `- **Info**: ${metaParts.join(' · ')}`,
  ].join('\n')
}

export function defineAgyImageTool(deps: {
  imageService: () => ImageService
  log?: (msg: string) => void
}) {
  return defineTool({
    name: 'agy_image',
    description:
      'Generate or edit an image using Google Antigravity built-in image generation (`generate_image`), reusing the agy account pool and region/quota failover. Returns markdown with the verified local image path.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Detailed image prompt (or edit instruction when imagePaths is given).',
      },
      name: {
        type: 'string',
        description: 'Optional filename stem for the generated artifact.',
      },
      aspectRatio: {
        type: 'string',
        description: `Optional aspect ratio (${SUPPORTED_ASPECT_RATIOS.join(', ')}).`,
      },
      imagePaths: {
        type: 'string',
        description: 'Optional comma- or newline-separated local reference/source image paths for editing.',
      },
      outPath: {
        type: 'string',
        description: 'Optional output file path or directory to copy the generated image into.',
      },
      model: {
        type: 'string',
        description: 'Optional driving Antigravity model id.',
      },
      effort: {
        type: 'string',
        description: 'Optional reasoning effort (e.g. low, medium, high).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 5 * 60_000,
    async execute(args, exec) {
      const refList = typeof args.imagePaths === 'string' && args.imagePaths.trim() !== ''
        ? args.imagePaths.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
        : []
      const req: ImageRequest = {
        prompt: String(args.prompt ?? ''),
        ...(typeof args.name === 'string' && args.name.trim() !== '' ? { name: args.name.trim() } : {}),
        ...(typeof args.aspectRatio === 'string' && args.aspectRatio.trim() !== '' ? { aspectRatio: args.aspectRatio.trim() } : {}),
        ...(refList.length > 0 ? { imagePaths: refList } : {}),
        ...(typeof args.outPath === 'string' && args.outPath.trim() !== '' ? { outPath: args.outPath.trim() } : {}),
        ...(typeof args.model === 'string' && args.model.trim() !== '' ? { model: args.model.trim() } : {}),
        ...(typeof args.effort === 'string' && args.effort.trim() !== '' ? { effort: args.effort.trim() } : {}),
      }
      deps.log?.(`agy_image tool invoked: ratio=${req.aspectRatio ?? 'auto'} refs=${refList.length}`)
      const res = await deps.imageService().generate(req, exec.signal)
      if (!res.ok) {
        throw new Error(`agy_image failed (${res.code ?? 'AGY_ERROR'}): ${res.error ?? 'unknown error'}`)
      }
      return formatImageResultMarkdown(res)
    },
  })
}

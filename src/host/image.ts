// agy image generation, bridged as a first-class plugin feature
// (spec: .spec/image.md).
//
// There is no direct "tool RPC" in agy's CLI: the only way to run the built-in
// `generate_image` tool is to ask the model to call it. So this module is
// deliberately prompt-driven — but everything AROUND the prompt is strict:
//
//   * the arguments are fixed (Prompt / ImageName / AspectRatio / ImagePaths),
//   * the request tells the model not to rewrite them and to report either
//     `IMAGE_PATH=` or `IMAGE_ERROR=`,
//   * the result is accepted only after the artifact is located, its magic
//     bytes prove it is really an image, its dimensions parse, and the aspect
//     ratio matches what was asked for.
//
// The artifact location is not guessed: agy saves generated images into
// `<agy home>/.gemini/antigravity-cli/brain/<main conversation id>/<name>_<ts>.<ext>`
// (verified on agy 1.5.4). We read the conversation id from the `init` event,
// prefer explicit paths found in tool output/text, and fall back to scanning
// that directory for files created during the run.
//
// Implementation lives in src/features/image/*; this module is the stable
// façade so existing importers (`src/cli/image.ts`, `test/image.test.ts`)
// keep importing `../host/image.ts` unchanged.
export {
  IMAGE_EXTENSIONS,
  ImageService,
  SUPPORTED_ASPECT_RATIOS,
  aspectMatches,
  buildImageAgentPrompt,
  emptyImageResult,
  extractImagePaths,
  imageSummary,
  normalizeAspectRatio,
  normalizeImageName,
  parseImageReply,
  readImageInfo,
  resolveImageTarget,
  simplifyRatio,
  sniffImage,
} from '../features/image/index.ts'
export type {
  ImageAgentCall,
  ImageAgentResult,
  ImageAgentToolCall,
  ImageFailureCode,
  ImageInfo,
  ImageRequest,
  ImageResult,
  ImageServiceDeps,
  ImageTarget,
} from '../features/image/index.ts'

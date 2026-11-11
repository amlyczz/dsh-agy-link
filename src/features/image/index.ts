// Public surface of the image feature. src/host/image.ts re-exports this module
// so the CLI, the HTTP route and the tests keep importing the same names.
export {
  IMAGE_EXTENSIONS,
  SUPPORTED_ASPECT_RATIOS,
  type ImageAgentCall,
  type ImageAgentResult,
  type ImageAgentToolCall,
  type ImageFailureCode,
  type ImageInfo,
  type ImageRequest,
  type ImageResult,
  type ImageServiceDeps,
  type ImageTarget,
} from './types.ts'
export {
  buildImageAgentPrompt,
  extractImagePaths,
  normalizeAspectRatio,
  normalizeImageName,
  parseImageReply,
  resolveImageTarget,
} from './prompt.ts'
export { aspectMatches, readImageInfo, simplifyRatio, sniffImage } from './artifacts.ts'
export { ImageService, emptyImageResult, imageSummary } from './service.ts'

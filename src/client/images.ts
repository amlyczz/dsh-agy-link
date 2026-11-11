// Client-side local image display & lightbox enhancer for dsh-agy-link.
//
// Implementation lives in ./images/*:
//   - styles.ts  : injected stylesheet
//   - media.ts   : media URL + image-file detection
//   - lightbox.ts: fullscreen preview modal
//   - scanner.ts : DOM scanner + mutation observer
//
// This module keeps the public surface (and the scroll/overlay gating check)
// stable for existing importers.
import { isInteractionLocked } from './scroll-guard.ts';
import { scanAndEnhanceImages as scanAndEnhanceImagesImpl } from './images/scanner.ts';

export { buildMediaUrl, isImageFile } from './images/media.ts';
export { openLightbox } from './images/lightbox.ts';
export { installImageEnhancer } from './images/scanner.ts';

/** Scan the DOM, gated by the shared scroll/overlay lock. */
export function scanAndEnhanceImages(): void {
  if (isInteractionLocked()) return;
  scanAndEnhanceImagesImpl();
}

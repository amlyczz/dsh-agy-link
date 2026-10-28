import { isInteractionLocked, onScrollSettle } from './scroll-guard.ts';

// Client-side local image display & lightbox enhancer for dsh-agy-link.
//
// Solves local image display issues in DSH Web and Desktop:
// 1. Normalizes media endpoints across local Desktop and remote Web clients
// 2. Retroactively enhances historical sessions where file:/// images were rendered as inert alt text
// 3. Enhances markdown file:// image links into clickable preview thumbnails
// 4. Provides a full-featured Lightbox modal (zoom, pan, copy path, fullscreen)

let lightboxOverlay: HTMLElement | null = null;
let currentLightboxImg: HTMLImageElement | null = null;
let lightboxScale = 1.0;
let lightboxTranslateX = 0;
let lightboxTranslateY = 0;
let isDraggingLightbox = false;
let dragStartX = 0;
let dragStartY = 0;

const IMAGE_CSS = `
.agy-image-card {
  display: inline-flex;
  flex-direction: column;
  margin: 6px 0;
  max-width: 100%;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
  background: var(--dsw-alias-bg-l1, rgba(255, 255, 255, 0.03));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  vertical-align: middle;
}

.agy-image-card:hover {
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.45));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}

.agy-image-thumb-wrap {
  position: relative;
  overflow: hidden;
  max-height: 480px;
  cursor: zoom-in;
  display: flex;
  align-items: center;
  justify-content: center;
  background: repeating-conic-gradient(rgba(127,127,127,0.08) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}

.agy-image-thumb {
  display: block;
  max-width: 100%;
  max-height: 480px;
  height: auto;
  object-fit: contain;
  transition: transform 0.2s ease;
}

.agy-image-card:hover .agy-image-thumb {
  transform: scale(1.015);
}

.agy-image-caption {
  padding: 6px 10px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #aaa);
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.08));
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.15));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-image-link-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  margin: 0 2px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  color: var(--dsw-alias-label-primary, #ddd);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s ease;
}

.agy-image-link-chip:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.2));
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
}

/* Lightbox Modal */
.agy-lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: rgba(0, 0, 0, 0.9);
  /* No full-viewport backdrop blur: same flicker class as the console overlay.
     The image viewer is already near-opaque; a solid alpha is stable. */
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  user-select: none;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.agy-lightbox-backdrop.open {
  opacity: 1;
}

.agy-lightbox-header {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: rgba(20, 20, 20, 0.65);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 13px;
}

.agy-lightbox-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.agy-lightbox-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agy-lightbox-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.agy-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.agy-lightbox-btn-close {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(239, 68, 68, 0.4);
}

.agy-lightbox-btn-close:hover {
  background: rgba(239, 68, 68, 0.45);
}

.agy-lightbox-body {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
}

.agy-lightbox-body.grabbing {
  cursor: grabbing;
}

.agy-lightbox-img-wrap {
  transform-origin: center center;
  transition: transform 0.05s ease-out;
  display: inline-block;
}

.agy-lightbox-img {
  max-width: 90vw;
  max-height: 85vh;
  object-fit: contain;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  border-radius: 4px;
  pointer-events: none;
}
`;

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'dsh-agy-link-images-css';
  if (document.getElementById(styleId) === null) {
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = IMAGE_CSS;
    const host = document.head ?? document.documentElement;
    if (host) host.appendChild(st);
  }
}

function getOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return '';
}

/** Build media URL from path */
export function buildMediaUrl(rawPath: string): string {
  const origin = getOrigin();
  return `${origin}/plugins/agy-link/media?path=${encodeURIComponent(rawPath.trim())}`;
}

/**
 * Open fullscreen Lightbox modal
 */
export function openLightbox(src: string, title = 'Image Preview', rawPath?: string): void {
  if (typeof document === 'undefined') return;
  injectStyles();

  if (lightboxOverlay) {
    lightboxOverlay.remove();
    lightboxOverlay = null;
  }

  lightboxScale = 1.0;
  lightboxTranslateX = 0;
  lightboxTranslateY = 0;

  const overlay = document.createElement('div');
  overlay.className = 'agy-lightbox-backdrop';

  const header = document.createElement('div');
  header.className = 'agy-lightbox-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'agy-lightbox-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const actions = document.createElement('div');
  actions.className = 'agy-lightbox-actions';

  const btnZoomIn = document.createElement('button');
  btnZoomIn.className = 'agy-lightbox-btn';
  btnZoomIn.textContent = '🔍+';
  btnZoomIn.title = '放大 / Zoom In';

  const btnZoomOut = document.createElement('button');
  btnZoomOut.className = 'agy-lightbox-btn';
  btnZoomOut.textContent = '🔍-';
  btnZoomOut.title = '缩小 / Zoom Out';

  const btnReset = document.createElement('button');
  btnReset.className = 'agy-lightbox-btn';
  btnReset.textContent = '1:1';
  btnReset.title = '实际大小 / Reset';

  actions.appendChild(btnZoomIn);
  actions.appendChild(btnZoomOut);
  actions.appendChild(btnReset);

  if (rawPath) {
    const btnCopyPath = document.createElement('button');
    btnCopyPath.className = 'agy-lightbox-btn';
    btnCopyPath.textContent = '📋 复制路径';
    btnCopyPath.onclick = (e) => {
      e.stopPropagation();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(rawPath).then(() => {
          btnCopyPath.textContent = '✓ 已复制';
          setTimeout(() => { btnCopyPath.textContent = '📋 复制路径'; }, 1500);
        }).catch(() => {});
      }
    };
    actions.appendChild(btnCopyPath);
  }

  const btnClose = document.createElement('button');
  btnClose.className = 'agy-lightbox-btn agy-lightbox-btn-close';
  btnClose.textContent = '✕ 关闭';
  actions.appendChild(btnClose);

  header.appendChild(actions);
  overlay.appendChild(header);

  const body = document.createElement('div');
  body.className = 'agy-lightbox-body';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'agy-lightbox-img-wrap';

  const img = document.createElement('img');
  img.className = 'agy-lightbox-img';
  img.src = src;
  img.alt = title;
  currentLightboxImg = img;

  imgWrap.appendChild(img);
  body.appendChild(imgWrap);
  overlay.appendChild(body);

  const updateTransform = () => {
    imgWrap.style.transform = `translate(${lightboxTranslateX}px, ${lightboxTranslateY}px) scale(${lightboxScale})`;
  };

  btnZoomIn.onclick = (e) => {
    e.stopPropagation();
    lightboxScale = Math.min(lightboxScale * 1.3, 5.0);
    updateTransform();
  };

  btnZoomOut.onclick = (e) => {
    e.stopPropagation();
    lightboxScale = Math.max(lightboxScale / 1.3, 0.2);
    updateTransform();
  };

  btnReset.onclick = (e) => {
    e.stopPropagation();
    lightboxScale = 1.0;
    lightboxTranslateX = 0;
    lightboxTranslateY = 0;
    updateTransform();
  };

  const closeLightbox = () => {
    window.removeEventListener('keydown', onKeyDown);
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.remove();
      if (lightboxOverlay === overlay) lightboxOverlay = null;
    }, 200);
  };

  btnClose.onclick = (e) => {
    e.stopPropagation();
    closeLightbox();
  };

  overlay.onclick = (e) => {
    if (e.target === overlay || e.target === body) {
      closeLightbox();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeLightbox();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Drag and pan
  body.onmousedown = (e) => {
    isDraggingLightbox = true;
    dragStartX = e.clientX - lightboxTranslateX;
    dragStartY = e.clientY - lightboxTranslateY;
    body.classList.add('grabbing');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDraggingLightbox) return;
    lightboxTranslateX = e.clientX - dragStartX;
    lightboxTranslateY = e.clientY - dragStartY;
    updateTransform();
  };

  const onMouseUp = () => {
    if (isDraggingLightbox) {
      isDraggingLightbox = false;
      body.classList.remove('grabbing');
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // Wheel zoom
  body.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    lightboxScale = Math.max(0.2, Math.min(lightboxScale * factor, 5.0));
    updateTransform();
  };

  document.body.appendChild(overlay);
  lightboxOverlay = overlay;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

/** Check if a URL or path is an image */
export function isImageFile(pathOrUrl: string): boolean {
  if (!pathOrUrl || typeof pathOrUrl !== 'string') return false;
  const clean = pathOrUrl.split(/[?#]/)[0] ?? '';
  return /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i.test(clean);
}

/** Get React props of a DOM element */
function getReactProps(el: HTMLElement): Record<string, unknown> | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  if (!key) return null;
  return (el as unknown as Record<string, unknown>)[key] as Record<string, unknown> | null;
}

/**
 * Scan DOM for imageAlt spans and enhance them with live rendered images
 */
export function scanAndEnhanceImages(): void {
  if (typeof document === 'undefined') return;
  if (isInteractionLocked()) return;
  const origin = getOrigin();

  // 1. Rewrite any existing <img> src pointing to 127.0.0.1 to current origin if remote
  if (origin && !origin.includes('127.0.0.1') && !origin.includes('localhost')) {
    const images = document.querySelectorAll<HTMLImageElement>('img[src*="/plugins/agy-link/media"]');
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (img && img.src.includes('127.0.0.1')) {
        const u = new URL(img.src);
        img.src = `${origin}${u.pathname}${u.search}`;
      }
    }
  }

  // 2. Scan markdown containers for imageAlt spans and replace with real images
  const markdownContainers = document.querySelectorAll<HTMLElement>('div[class*="_markdown_"], [data-markdown-variant]');
  for (let i = 0; i < markdownContainers.length; i++) {
    const container = markdownContainers[i];
    if (!container) continue;

    const altSpans = container.querySelectorAll<HTMLElement>('span[class*="imageAlt"], span[class*="_imageAlt_"]');
    if (altSpans.length === 0) continue;

    // Check React props for original markdown text
    const props = getReactProps(container);
    const mdText = typeof props?.text === 'string' ? props.text : '';
    if (!mdText) continue;

    // Extract all image markdown definitions: ![alt](target)
    const imgMatches: Array<{ alt: string; target: string }> = [];
    const re = /!\[(.*?)\]\((file:\/\/\/[^\s)]+|file:\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+|\/home\/[^\s)]+|\/mnt\/[a-zA-Z]\/[^\s)]+|\\\\wsl\.localhost\\[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mdText)) !== null) {
      imgMatches.push({ alt: m[1] ?? '', target: m[2] ?? '' });
    }

    if (imgMatches.length === 0) continue;

    for (let j = 0; j < altSpans.length; j++) {
      const span = altSpans[j];
      if (!span || span.dataset.agyEnhanced === 'true') continue;

      const altText = (span.textContent ?? '').trim();
      const match = imgMatches.find((im) => im.alt.trim() === altText) ?? imgMatches[j];
      if (!match) continue;

      span.dataset.agyEnhanced = 'true';
      const mediaUrl = buildMediaUrl(match.target);

      // Create card
      const card = document.createElement('div');
      card.className = 'agy-image-card';

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'agy-image-thumb-wrap';
      thumbWrap.title = `${altText || 'Image'} (点击全屏放大)`;

      const img = document.createElement('img');
      img.className = 'agy-image-thumb';
      img.src = mediaUrl;
      img.alt = altText || 'Preview';
      img.loading = 'lazy';

      img.onerror = () => {
        // Fall back to original alt text if media loading fails
        card.style.display = 'none';
        span.style.display = '';
      };

      thumbWrap.appendChild(img);
      card.appendChild(thumbWrap);

      if (altText) {
        const caption = document.createElement('div');
        caption.className = 'agy-image-caption';
        caption.textContent = altText;
        card.appendChild(caption);
      }

      thumbWrap.onclick = (e) => {
        e.stopPropagation();
        openLightbox(mediaUrl, altText || 'Image Preview', match.target);
      };

      span.style.display = 'none';
      span.parentNode?.insertBefore(card, span);
    }
  }

  // 3. Scan for <a> links to file:// images
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href^="file://"]');
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link || link.dataset.agyLinkEnhanced === 'true') continue;

    const href = link.href ?? '';
    if (!isImageFile(href)) continue;

    link.dataset.agyLinkEnhanced = 'true';
    const mediaUrl = buildMediaUrl(href);
    const linkText = link.textContent ?? 'Image';

    link.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLightbox(mediaUrl, linkText, href);
    };

    // Add a visual preview indicator
    if (!link.querySelector('.agy-image-link-icon')) {
      const badge = document.createElement('span');
      badge.className = 'agy-image-link-chip agy-image-link-icon';
      badge.textContent = '🖼️ 预览';
      link.appendChild(badge);
    }
  }
}

let imageEnhancerDispose: (() => void) | null = null;
let imageScanTimer: ReturnType<typeof setTimeout> | null = null;
let unbindImageSettle: (() => void) | null = null;

function scheduleImageScan(): void {
  if (isInteractionLocked()) return;
  if (imageScanTimer !== null) return;
  imageScanTimer = setTimeout(() => {
    imageScanTimer = null;
    if (isInteractionLocked()) return;
    scanAndEnhanceImages();
  }, 100);
}

export function installImageEnhancer(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  // A plugin reload must DISCONNECT the previous observer instead of stacking
  // one more per reload (the ctx.effect contract main's installers follow).
  imageEnhancerDispose?.();
  injectStyles();

  const observer = new MutationObserver(() => {
    scheduleImageScan();
  });

  unbindImageSettle = onScrollSettle(() => {
    scheduleImageScan();
  });

  const setup = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      scanAndEnhanceImages();
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }

  const dispose = (): void => {
    observer.disconnect();
    if (unbindImageSettle !== null) {
      unbindImageSettle();
      unbindImageSettle = null;
    }
    if (imageScanTimer !== null) {
      clearTimeout(imageScanTimer);
      imageScanTimer = null;
    }
    window.removeEventListener('DOMContentLoaded', setup);
    if (imageEnhancerDispose === dispose) imageEnhancerDispose = null;
  };
  imageEnhancerDispose = dispose;
  return dispose;
}

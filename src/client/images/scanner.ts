// DOM scanner that turns rendered image alt-text / file links into previews.
//
// Split out of src/client/images.ts; behaviour is unchanged. All mutation is
// gated through isInteractionLocked() (scroll OR full-screen overlay).
import { isInteractionLocked, onScrollSettle } from '../scroll-guard.ts';
import { buildMediaUrl, getOrigin, isImageFile } from './media.ts';
import { openLightbox } from './lightbox.ts';
import { injectStyles } from './styles.ts';

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

    // Do NOT hijack link.onclick: preserving DSH's native link handling allows
    // clicking the filename to open/reveal the file in the workspace or editor.
    // The Lightbox preview is opened strictly through the attached preview button.

    // Add a visual preview indicator
    if (!link.querySelector('.agy-image-link-icon')) {
      const badge = document.createElement('span');
      badge.className = 'agy-image-link-chip agy-image-link-icon';
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.title = `预览图片 / Preview (${linkText})`;
      badge.innerHTML = '<span class="agy-image-chip-icon">🖼️</span><span class="agy-image-chip-text">预览</span>';

      badge.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(mediaUrl, linkText, href);
      };

      badge.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openLightbox(mediaUrl, linkText, href);
        }
      };

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

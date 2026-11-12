// DOM scanner that turns rendered image/media alt-text and file links into previews and native file handlers.
import { isInteractionLocked, onScrollSettle } from '../scroll-guard.ts';
import { buildMediaUrl, getOrigin, isImageFile, isVideoFile, isLocalFilePath, openInSystem } from './media.ts';
import { openLightbox, showToast } from './lightbox.ts';
import { injectStyles } from './styles.ts';

/** Get React props of a DOM element */
function getReactProps(el: HTMLElement): Record<string, unknown> | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  if (!key) return null;
  return (el as unknown as Record<string, unknown>)[key] as Record<string, unknown> | null;
}

function rewriteMediaOrigins(origin: string): void {
  if (!origin || origin.includes('127.0.0.1') || origin.includes('localhost')) return;
  const images = document.querySelectorAll<HTMLImageElement>('img[src*="/plugins/agy-link/media"]');
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img && img.src.includes('127.0.0.1')) {
      const u = new URL(img.src);
      img.src = `${origin}${u.pathname}${u.search}`;
    }
  }
}

function enhanceAltSpans(): void {
  const markdownContainers = document.querySelectorAll<HTMLElement>('div[class*="_markdown_"], [data-markdown-variant]');
  for (let i = 0; i < markdownContainers.length; i++) {
    const container = markdownContainers[i];
    if (!container) continue;

    const altSpans = container.querySelectorAll<HTMLElement>('span[class*="imageAlt"], span[class*="_imageAlt_"]');
    if (altSpans.length === 0) continue;

    const props = getReactProps(container);
    const mdText = typeof props?.text === 'string' ? props.text : '';
    if (!mdText) continue;

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
}

function enhanceImageLinks(links: NodeListOf<HTMLAnchorElement>): void {
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link || link.dataset.agyLinkEnhanced === 'true') continue;

    const rawHref = link.getAttribute('href') ?? '';
    const resolvedHref = link.href ?? '';
    if (!isImageFile(rawHref) && !isImageFile(resolvedHref)) continue;

    link.dataset.agyLinkEnhanced = 'true';
    const pathToUse = rawHref.startsWith('file://') ? rawHref : (resolvedHref.startsWith('file://') ? resolvedHref : (rawHref || resolvedHref));
    const mediaUrl = buildMediaUrl(pathToUse);
    const linkText = (link.textContent ?? 'Image').replace(/预览$/, '').trim();

    // Intercept clicking on the filename itself so local file preview opens in Lightbox
    link.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.closest?.('.agy-image-link-chip')) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(mediaUrl, linkText, pathToUse);
    });

    if (!link.querySelector('.agy-image-link-icon')) {
      const badge = document.createElement('span');
      badge.className = 'agy-image-link-chip agy-image-link-icon';
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.title = `预览图片 / Preview (${linkText})`;
      badge.innerHTML = '<span class="agy-image-chip-icon"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;display:inline-block;"><path d="M1 8s3-5.5 7-5.5S15 8 15 8s-3 5.5-7 5.5S1 8 1 8z"/><circle cx="8" cy="8" r="2.5"/></svg></span><span class="agy-image-chip-text">预览</span>';

      badge.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(mediaUrl, linkText, pathToUse);
      };

      badge.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openLightbox(mediaUrl, linkText, pathToUse);
        }
      };

      link.appendChild(badge);
    }
  }
}

function enhanceVideoLinks(links: NodeListOf<HTMLAnchorElement>): void {
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link || link.dataset.agyVideoEnhanced === 'true') continue;

    const rawHref = link.getAttribute('href') ?? '';
    const resolvedHref = link.href ?? '';
    if (!isVideoFile(rawHref) && !isVideoFile(resolvedHref)) continue;

    link.dataset.agyVideoEnhanced = 'true';
    const pathToUse = rawHref.startsWith('file://') ? rawHref : (resolvedHref.startsWith('file://') ? resolvedHref : (rawHref || resolvedHref));
    const mediaUrl = buildMediaUrl(pathToUse);
    const linkText = (link.textContent ?? 'Video').replace(/播放$/, '').trim();

    link.addEventListener('click', (e) => {
      if ((e.target as HTMLElement)?.closest?.('.agy-image-link-chip')) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(mediaUrl, linkText, pathToUse);
    });

    if (!link.querySelector('.agy-video-link-icon')) {
      const badge = document.createElement('span');
      badge.className = 'agy-image-link-chip agy-chip-video agy-video-link-icon';
      badge.setAttribute('role', 'button');
      badge.setAttribute('tabindex', '0');
      badge.title = `播放视频 / Play Video (${linkText})`;
      badge.innerHTML = '<span class="agy-image-chip-icon"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span><span class="agy-image-chip-text">播放</span>';

      badge.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(mediaUrl, linkText, pathToUse);
      };

      badge.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openLightbox(mediaUrl, linkText, pathToUse);
        }
      };

      link.appendChild(badge);
    }
  }
}

/**
 * Scan DOM for imageAlt spans and enhance them with live rendered images
 */
export function scanAndEnhanceImages(): void {
  if (typeof document === 'undefined') return;
  if (isInteractionLocked()) return;
  const origin = getOrigin();

  rewriteMediaOrigins(origin);
  enhanceAltSpans();

  const links = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  enhanceImageLinks(links);
  enhanceVideoLinks(links);
}

let imageEnhancerDispose: (() => void) | null = null;
let imageScanTimer: ReturnType<typeof setTimeout> | null = null;
let unbindImageSettle: (() => void) | null = null;
let delegatedClickListener: ((e: MouseEvent) => void) | null = null;

function scheduleImageScan(): void {
  if (isInteractionLocked()) return;
  if (imageScanTimer !== null) return;
  imageScanTimer = setTimeout(() => {
    imageScanTimer = null;
    if (isInteractionLocked()) return;
    scanAndEnhanceImages();
  }, 100);
}

function handleGlobalLinkClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  const a = target?.closest('a') as HTMLAnchorElement | null;
  if (!a) return;
  if (a.dataset.agyLinkEnhanced === 'true' || a.dataset.agyVideoEnhanced === 'true') return;
  if (target?.closest?.('.agy-image-link-chip')) return;

  const rawHref = a.getAttribute('href') ?? '';
  const resolvedHref = a.href ?? '';
  if (rawHref.startsWith('file://') || resolvedHref.startsWith('file://') || isLocalFilePath(rawHref)) {
    const pathToUse = rawHref.startsWith('file://') ? rawHref : (resolvedHref.startsWith('file://') ? resolvedHref : (rawHref || resolvedHref));
    if (/^https?:\/\//i.test(pathToUse) && !pathToUse.includes('/plugins/agy-link/')) return;

    e.preventDefault();
    e.stopPropagation();
    openInSystem(pathToUse, false).then((res) => {
      const fileName = pathToUse.split(/[/\\]/).pop() || pathToUse;
      showToast(res.ok ? `已在系统默认程序中打开: ${fileName}` : `打开失败: ${res.error || '未找到文件'}`);
    });
  }
}

export function installImageEnhancer(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  imageEnhancerDispose?.();
  injectStyles();

  const observer = new MutationObserver(() => {
    scheduleImageScan();
  });

  unbindImageSettle = onScrollSettle(() => {
    scheduleImageScan();
  });

  delegatedClickListener = handleGlobalLinkClick;
  document.addEventListener('click', delegatedClickListener, true);

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
    if (delegatedClickListener !== null) {
      document.removeEventListener('click', delegatedClickListener, true);
      delegatedClickListener = null;
    }
    window.removeEventListener('DOMContentLoaded', setup);
    if (imageEnhancerDispose === dispose) imageEnhancerDispose = null;
  };
  imageEnhancerDispose = dispose;
  return dispose;
}

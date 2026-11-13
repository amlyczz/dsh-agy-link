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
let currentClientCtx: any = null;

export function setClientContext(ctx: unknown): void {
  currentClientCtx = ctx;
  if (typeof window !== 'undefined' && ctx) {
    (window as any).__dshClientCtx__ = ctx;
  }
}

function getService<T>(c: any, name: string): T | undefined {
  if (!c) return undefined;
  try {
    const fromReflect = c.reflect?.get?.(name, false);
    if (fromReflect != null) return fromReflect;
  } catch {}
  try {
    const fromGet = typeof c.get === 'function' ? c.get(name) : undefined;
    if (fromGet != null) return fromGet;
  } catch {}
  try {
    const direct = c[name];
    if (direct != null) return direct;
  } catch {}
  return undefined;
}

export function parseFilePathAndLine(rawPath: string): { cleanPath: string; line?: number } {
  let cleanPath = rawPath.trim();
  let line: number | undefined;

  const hashIdx = cleanPath.indexOf('#');
  if (hashIdx >= 0) {
    const hash = cleanPath.slice(hashIdx + 1);
    const hashMatch = /^L(\d+)(?:-L(\d+))?$/i.exec(hash);
    if (hashMatch && hashMatch[1]) {
      const l = parseInt(hashMatch[1], 10);
      if (Number.isSafeInteger(l) && l > 0) {
        line = l;
      }
    }
    cleanPath = cleanPath.slice(0, hashIdx);
  }

  if (line === undefined) {
    const colonMatch = /:(\d+)(?::\d+|-(\d+))?$/.exec(cleanPath);
    if (colonMatch && colonMatch[1]) {
      const l = parseInt(colonMatch[1], 10);
      if (Number.isSafeInteger(l) && l > 0) {
        line = l;
        cleanPath = cleanPath.slice(0, -colonMatch[0].length);
      }
    }
  }

  if (cleanPath.startsWith('file://')) {
    cleanPath = cleanPath.slice(7);
    if (/^\/[A-Za-z]:[\\/]/.test(cleanPath)) {
      cleanPath = cleanPath.slice(1);
    } else if (!cleanPath.startsWith('/') && !/^[A-Za-z]:/.test(cleanPath)) {
      cleanPath = '/' + cleanPath.replace(/^localhost\/?/, '');
    }
  }

  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch {}

  return { cleanPath, line };
}

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeSegment).join('/');
}

function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\');
}

function isAbsoluteWorkspacePath(path: string): boolean {
  return path.startsWith('/') || isWindowsStylePath(path);
}

function sessionFileAddress(sessionId: string, path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}

export function fileAddressFor(sessionId: string, cwd: string | undefined, path: string): string {
  if (path.startsWith(FILE_ADDRESS_PREFIX)) return path;
  const normalized = path.replace(/\\/g, '/');
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '');
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);
}

export function resolveSessionId(targetCtx: any, cleanPath?: string): string {
  if (!targetCtx) return '';
  const sidebarRight = getService<any>(targetCtx, 'sidebarRight');
  const mounted = sidebarRight?.mounted?.getSnapshot?.();
  if (typeof mounted === 'string' && mounted) return mounted;

  const uiSession = getService<any>(targetCtx, 'uiSession');
  const adapterKey = uiSession?.adapter?.current?.getSnapshot?.()?.key;
  if (typeof adapterKey === 'string' && adapterKey) return adapterKey;

  const value = uiSession?.current?.value;
  if (value && typeof value === 'object') {
    for (const k of ['key', 'sessionId', 'id']) {
      const id = value[k];
      if (typeof id === 'string' && id) return id;
    }
  }

  const sessions = getService<any>(targetCtx, 'sessions');
  const byId = sessions?.list?.getSnapshot?.()?.byId;
  if (byId && typeof byId === 'object') {
    const keys = Object.keys(byId);
    if (keys.length === 1 && keys[0]) return keys[0];
    if (cleanPath) {
      const normClean = cleanPath.replace(/\\/g, '/');
      for (const key of keys) {
        const sessCwd = byId[key]?.cwd;
        if (sessCwd && typeof sessCwd === 'string') {
          const normCwd = sessCwd.replace(/\\/g, '/').replace(/\/+$/, '');
          if (normCwd && normClean.startsWith(`${normCwd}/`)) {
            return key;
          }
        }
      }
    }
    if (keys[0]) return keys[0];
  }

  return '';
}

export async function openInSidebar(rawPath: string, ctx?: unknown): Promise<boolean> {
  try {
    const targetCtx = (ctx || currentClientCtx || (typeof window !== 'undefined' ? (window as any).__dshClientCtx__ : undefined)) as any;
    if (!targetCtx) return false;

    const sidebarRight = getService<any>(targetCtx, 'sidebarRight');
    if (!sidebarRight || (typeof sidebarRight.openResource !== 'function' && typeof sidebarRight.openResourceIn !== 'function')) {
      return false;
    }

    const { cleanPath, line } = parseFilePathAndLine(rawPath);
    if (!cleanPath) return false;

    const sessionId = resolveSessionId(targetCtx, cleanPath);
    if (!sessionId) {
      console.warn('[dsh-agy-link] openInSidebar: could not determine current sessionId');
      return false;
    }

    const sessions = getService<any>(targetCtx, 'sessions');
    let cwd = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
    try {
      const bindingWd = sessions?.binding?.(sessionId)?.session?.projections?.faceOf?.('workingDirectory')?.getSnapshot?.();
      if (typeof bindingWd === 'string' && bindingWd) {
        cwd = bindingWd;
      }
    } catch {}

    const resourceUrl = fileAddressFor(sessionId, cwd, cleanPath);
    const options = line !== undefined ? { params: { line } } : {};

    if (typeof sidebarRight.openResource === 'function') {
      try {
        sidebarRight.openResource(resourceUrl, options);
        return true;
      } catch (err) {
        if (typeof sidebarRight.openResourceIn === 'function') {
          sidebarRight.openResourceIn(sessionId, resourceUrl, options);
          return true;
        }
        throw err;
      }
    } else if (typeof sidebarRight.openResourceIn === 'function') {
      sidebarRight.openResourceIn(sessionId, resourceUrl, options);
      return true;
    }

    return false;
  } catch (err) {
    console.warn('[dsh-agy-link] openInSidebar failed:', err);
    return false;
  }
}

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

    // Alt+Click bypass: open directly in system default app / Finder
    if (e.altKey) {
      openInSystem(pathToUse, false).then((res) => {
        const fileName = pathToUse.split(/[/\\]/).pop() || pathToUse;
        showToast(res.ok ? `已在系统默认程序中打开: ${fileName}` : `打开失败: ${res.error || '未找到文件'}`);
      });
      return;
    }

    // Visual media opens in lightbox
    if (isImageFile(pathToUse) || isVideoFile(pathToUse)) {
      const mediaUrl = buildMediaUrl(pathToUse);
      const linkText = (a.textContent ?? 'Media').trim();
      openLightbox(mediaUrl, linkText, pathToUse);
      return;
    }

    // Non-media file: open inside DSH's native right sidebar!
    openInSidebar(pathToUse).then((opened) => {
      if (opened) return;
      // Fallback to system default application if sidebar open was unavailable
      openInSystem(pathToUse, false).then((res) => {
        const fileName = pathToUse.split(/[/\\]/).pop() || pathToUse;
        showToast(res.ok ? `已在系统默认程序中打开: ${fileName}` : `打开失败: ${res.error || '未找到文件'}`);
      });
    });
  }
}

export function installImageEnhancer(ctx?: unknown): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (ctx) setClientContext(ctx);
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

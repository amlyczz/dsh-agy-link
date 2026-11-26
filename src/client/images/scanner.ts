// DOM scanner that turns rendered image/media alt-text and file links into previews and native file handlers.
import { isInteractionLocked, onScrollSettle } from '../scroll-guard.ts';
import { translateOr } from '../i18n-bridge.ts';
import { buildMediaUrl, getOrigin, isImageFile, isVideoFile, isAudioFile, isLocalFilePath, openInSystem } from './media.ts';
import { enhanceAudioLink } from './audio.ts';
import { openLightbox, showToast } from './lightbox.ts';
import { injectStyles } from './styles.ts';

/**
 * Cached client context. `installImageEnhancer` receives it from `apply(ctx)` so
 * the click handler — which runs long after apply returned — can still reach
 * `ctx.get('sidebarRight')`. Never dereferenced eagerly: Cordis throws on a
 * non-injected service, so every read stays inside a guard.
 */
let clientContext: unknown = null

export function setClientContext(ctx: unknown): void {
  clientContext = ctx
}

/** The tab type that previews a session file in the right Sidebar (documentpreview's fallback). */
const DOCUMENT_PREVIEW_TAB = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'

/**
 * Resolve one Cordis service without an injection declaration.
 *
 * Kept local (not imported from translate-context) on purpose: this module is
 * also loaded by SSR/toolview tests under plain ESM, and translate-context pulls
 * React in through `require`. A guarded `get()` plus a guarded property read is
 * enough here — Cordis throws on a non-injected service property, hence the try.
 */
function service<T>(ctx: unknown, name: string): T | undefined {
  const c = ctx as { get?: (key: string) => unknown } & Record<string, unknown>
  try {
    const fromGet = c.get?.(name)
    if (fromGet !== undefined && fromGet !== null) return fromGet as T
  } catch {
    // service not present in this composition
  }
  try {
    const direct = c[name]
    return direct === undefined || direct === null ? undefined : (direct as T)
  } catch {
    return undefined
  }
}

/** The Session the visible conversation belongs to; `''` when unknown. */
function currentSessionId(ctx: unknown): string {
  const uiSession = service<{ current?: { value?: Record<string, unknown> } }>(ctx, 'uiSession')
  const value = uiSession?.current?.value
  if (value !== undefined && value !== null) {
    for (const key of ['key', 'sessionId', 'id']) {
      const id = value[key]
      if (typeof id === 'string' && id !== '') return id
    }
  }
  const sessions = service<{ list?: { getSnapshot?: () => { byId?: Record<string, unknown> } } }>(ctx, 'sessions')
  const byId = sessions?.list?.getSnapshot?.()?.byId
  if (byId !== undefined && byId !== null) {
    const ids = Object.keys(byId)
    if (ids.length === 1 && ids[0] !== undefined) return ids[0]
  }
  return ''
}

interface SidebarRightLike {
  mounted?: { getSnapshot?: () => unknown }
  openResource?: (address: string, options?: Record<string, unknown>) => void
}

/** A Sidebar we proved callable in {@link sidebarRightOf}. */
type OpenableSidebar = SidebarRightLike & { openResource: NonNullable<SidebarRightLike['openResource']> }

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

/** `dsh-resource://file/session/<sessionId>/<path>`, mirroring DSH's `sessionFileAddress`. */
function sessionFileAddress(sessionId: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  return `dsh-resource://file/session/${encodeSegment(sessionId)}/${normalized.split('/').map(encodeSegment).join('/')}`
}

/**
 * `file:///C:/x` | `file://C:/x` | `C:\x` → `C:/x`, dropping a `#L12` / `?v=1` suffix.
 *
 * Percent-decoding happens AFTER the `?#` split (so `%3F` in a name is not
 * mistaken for a query) and before the separator normalization: an encoded href
 * (`Bio%20Fuel%20Cell`, `%5C`) otherwise never matches the session cwd, and the
 * address is then rebuilt with a second round of encoding (issue #141).
 */
export function normalizeLocalPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('file://')) {
    p = p.slice(7)
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  }
  const [pathPart] = p.split(/[?#]/)
  return decodePercent(pathPart ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
}

/** Decode a percent-encoded path, keeping the raw text when it is malformed. */
function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sidebarRightOf(ctx: unknown): OpenableSidebar | undefined {
  const sidebarRight = service<SidebarRightLike>(ctx, 'sidebarRight')
  return typeof sidebarRight?.openResource === 'function' ? (sidebarRight as OpenableSidebar) : undefined
}

/**
 * Whether a tab type can follow a session file address. Web/headless profiles
 * omit `ui-sidebar-documentpreview`; opening there would silently do nothing, so
 * the caller must fall back to the OS opener instead of reporting success.
 */
export function canPreviewFiles(ctx: unknown): boolean {
  // `get()` is keyed by tab KIND (e.g. 'text'), not by type id, so probing it
  // with DOCUMENT_PREVIEW_TAB always returned undefined and every file link fell
  // through to the OS opener (issue #141). Prefer `entries()`, which is keyed by
  // id; fall back to asking for the 'text' kind and confirming the id, so a
  // different text tab is never mistaken for the preview.
  const tabs = service<{
    entries?: () => readonly { id?: string }[]
    get?: (kind: string) => { id?: string } | undefined
  }>(ctx, 'sidebarRightTabs')
  const registered = tabs?.entries?.()
  if (Array.isArray(registered) && registered.some((entry) => entry?.id === DOCUMENT_PREVIEW_TAB)) return true
  return tabs?.get?.('text')?.id === DOCUMENT_PREVIEW_TAB
}

function mountedSessionId(sidebarRight: SidebarRightLike): string {
  const mounted = sidebarRight.mounted?.getSnapshot?.()
  return typeof mounted === 'string' ? mounted : ''
}

/** The on-screen Session's workspace root, normalized to forward slashes. */
function sessionWorkspace(ctx: unknown, sessionId: string): string {
  const sessions = service<{ list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: unknown }> } } }>(
    ctx as never,
    'sessions',
  )
  const cwd = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd
  return typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
}

/**
 * Open a local file in DSH's native right Sidebar (the `ui-sidebar-documentpreview`
 * tab), exactly like the native `fileMention` chip does.
 *
 * The address is built the way `fileAddressFor` builds it: a path inside the
 * Session workspace travels relative, anything else keeps its absolute spelling.
 * Returns `false` when no Sidebar can take it, so callers can fall back.
 */
export function openInRightSidebar(rawPath: string): boolean {
  if (clientContext === null) return false
  const sidebarRight = sidebarRightOf(clientContext)
  if (sidebarRight === undefined) return false
  if (!canPreviewFiles(clientContext)) return false

  // `mounted` is the Session whose Sidebar is on screen — the one `openResource`
  // places into. Fall back to the visible conversation when it is not adopted.
  const sessionId = mountedSessionId(sidebarRight) || currentSessionId(clientContext)
  if (sessionId === '') return false

  const target = normalizeLocalPath(rawPath)
  if (target === '') return false

  const cwd = sessionWorkspace(clientContext, sessionId)
  let addressPath = target
  if (cwd !== '') {
    const lowerCwd = cwd.toLowerCase()
    if (target.toLowerCase() === lowerCwd) addressPath = ''
    else if (target.toLowerCase().startsWith(`${lowerCwd}/`)) addressPath = target.slice(cwd.length + 1)
  }

  const line = /#L(\d+)/.exec(rawPath)
  try {
    sidebarRight.openResource(
      sessionFileAddress(sessionId, addressPath),
      line === null ? undefined : { params: { line: Number(line[1]) } },
    )
    return true
  } catch {
    return false
  }
}

/** Get React props of a DOM element */
function getReactProps(el: HTMLElement): Record<string, unknown> | null {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'));
  if (!key) return null;
  return (el as unknown as Record<string, unknown>)[key] as Record<string, unknown> | null;
}

function rewriteMediaOrigins(origin: string): void {
  if (!origin || origin.includes('127.0.0.1') || origin.includes('localhost')) return;
  const images = document.querySelectorAll<HTMLImageElement>(
    'img[src*="/plugins/agy-link/media"]:not([data-agy-origin-rewritten])',
  );
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) continue;
    if (img.src.includes('127.0.0.1')) {
      const u = new URL(img.src);
      img.src = `${origin}${u.pathname}${u.search}`;
    }
    img.dataset.agyOriginRewritten = 'true';
  }
}

/**
 * PR #110 stamps non-matching alt spans as "scanned" so later passes can exit
 * early. Streaming markdown grows while tokens arrive, so a span skipped once
 * must be re-evaluated when its container's markdown text changes. Track a
 * short fingerprint on the container (never the whole text) and clear the
 * stamps only for containers whose text actually changed — the fast path stays
 * a single cheap attribute query.
 */
const ALT_MD_ATTR = 'data-agy-alt-md';

function markdownTextOf(container: HTMLElement): string {
  const props = getReactProps(container);
  return typeof props?.text === 'string' ? props.text : '';
}

function altFingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${h}`;
}

function refreshChangedAltContainers(): void {
  const tracked = document.querySelectorAll<HTMLElement>(`[${ALT_MD_ATTR}]`);
  for (let i = 0; i < tracked.length; i++) {
    const container = tracked[i];
    if (!container) continue;
    const unenhanced = container.querySelector(
      'span[class*="imageAlt"]:not([data-agy-enhanced="true"]), span[class*="_imageAlt_"]:not([data-agy-enhanced="true"])',
    );
    if (!unenhanced) {
      container.removeAttribute(ALT_MD_ATTR);
      continue;
    }
    const next = altFingerprint(markdownTextOf(container));
    if (container.getAttribute(ALT_MD_ATTR) === next) continue;
    container.setAttribute(ALT_MD_ATTR, next);
    const spans = container.querySelectorAll<HTMLElement>('span[class*="imageAlt"], span[class*="_imageAlt_"]');
    for (let j = 0; j < spans.length; j++) {
      const span = spans[j];
      if (span && span.dataset.agyEnhanced !== 'true') delete span.dataset.agyAltScanned;
    }
  }
}

function enhanceAltSpans(): void {
  refreshChangedAltContainers();
  const unenhancedSpans = document.querySelectorAll<HTMLElement>(
    'span[class*="imageAlt"]:not([data-agy-alt-scanned]):not([data-agy-enhanced]), span[class*="_imageAlt_"]:not([data-agy-alt-scanned]):not([data-agy-enhanced])',
  );
  if (unenhancedSpans.length === 0) return;

  const seenContainers = new Set<HTMLElement>();
  for (let i = 0; i < unenhancedSpans.length; i++) {
    const span = unenhancedSpans[i];
    if (!span) continue;
    const container = span.closest<HTMLElement>('div[class*="_markdown_"], [data-markdown-variant]');
    if (container) {
      seenContainers.add(container);
    } else {
      span.dataset.agyAltScanned = 'true';
    }
  }

  for (const container of seenContainers) {
    const allSpans = container.querySelectorAll<HTMLElement>('span[class*="imageAlt"], span[class*="_imageAlt_"]');
    if (allSpans.length === 0) continue;

    const mdText = markdownTextOf(container);
    container.setAttribute(ALT_MD_ATTR, altFingerprint(mdText));
    if (!mdText) continue;

    const imgMatches: Array<{ alt: string; target: string }> = [];
    const re = /!\[(.*?)\]\((file:\/\/\/[^\s)]+|file:\/\/[^\s)]+|[A-Za-z]:[\\/][^\s)]+|\/home\/[^\s)]+|\/mnt\/[a-zA-Z]\/[^\s)]+|\\\\wsl\.localhost\\[^\s)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mdText)) !== null) {
      imgMatches.push({ alt: m[1] ?? '', target: m[2] ?? '' });
    }
    if (imgMatches.length === 0) {
      for (let j = 0; j < allSpans.length; j++) {
        const span = allSpans[j];
        if (span) span.dataset.agyAltScanned = 'true';
      }
      continue;
    }

    for (let j = 0; j < allSpans.length; j++) {
      const span = allSpans[j];
      if (!span || span.dataset.agyEnhanced === 'true') continue;
      span.dataset.agyAltScanned = 'true';

      const altText = (span.textContent ?? '').trim();
      const match = imgMatches.find((im) => im.alt.trim() === altText) ?? imgMatches[j];
      if (!match) continue;

      span.dataset.agyEnhanced = 'true';
      const mediaUrl = buildMediaUrl(match.target);

      const card = document.createElement('div');
      card.className = 'agy-image-card';

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'agy-image-thumb-wrap';
      thumbWrap.title = translateOr('image.zoomHint', '{alt} (click to view full screen)', { alt: altText || 'Image' });

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
    const stillUnenhanced = container.querySelector(
      'span[class*="imageAlt"]:not([data-agy-enhanced="true"]), span[class*="_imageAlt_"]:not([data-agy-enhanced="true"])',
    );
    if (!stillUnenhanced) container.removeAttribute(ALT_MD_ATTR);
  }
}

function enhanceImageLink(link: HTMLAnchorElement, rawHref: string, resolvedHref: string): void {
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
    badge.title = translateOr('image.previewTitle', 'Preview ({name})', { name: linkText });
    badge.innerHTML = '<span class="agy-image-chip-icon"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;display:inline-block;"><path d="M1 8s3-5.5 7-5.5S15 8 15 8s-3 5.5-7 5.5S1 8 1 8z"/><circle cx="8" cy="8" r="2.5"/></svg></span><span class="agy-image-chip-text">' + translateOr('image.previewChip', 'Preview') + '</span>';

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

function enhanceVideoLink(link: HTMLAnchorElement, rawHref: string, resolvedHref: string): void {
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
    badge.title = translateOr('image.playTitle', 'Play video ({name})', { name: linkText });
    badge.innerHTML = '<span class="agy-image-chip-icon"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg></span><span class="agy-image-chip-text">' + translateOr('image.playChip', 'Play') + '</span>';

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

function enhanceFileLink(link: HTMLAnchorElement, rawHref: string, resolvedHref: string): void {
  link.dataset.agyFileEnhanced = 'true';
  const pathToUse = rawHref.startsWith('file://') ? rawHref : (resolvedHref.startsWith('file://') ? resolvedHref : (rawHref || resolvedHref));

  // The link text is the affordance: clicking it opens the native right Sidebar
  // (no extra badge), falling back to the OS opener when no Sidebar can take it.
  link.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.closest?.('.agy-image-link-chip')) return;
    e.preventDefault();
    e.stopPropagation();
    const fileName = pathToUse.split(/[/\\]/).pop() || pathToUse;
    if (openInRightSidebar(pathToUse)) {
      showToast(translateOr('file.openedInSidebar', 'Opened in the sidebar: {name}', { name: fileName }));
      return;
    }
    openInSystem(pathToUse, false).then((res) => {
      showToast(res.ok
        ? translateOr('file.openedInSystem', 'Opened in the system app: {name}', { name: fileName })
        : translateOr('file.openFailed', 'Could not open: {error}', { error: res.error || translateOr('file.notFound', 'file not found') }));
    });
  });
}

function enhanceLinks(): void {
  const links = document.querySelectorAll<HTMLAnchorElement>(
    'a[href]:not([data-agy-link-scanned]):not([data-agy-link-enhanced]):not([data-agy-video-enhanced]):not([data-agy-audio-enhanced]):not([data-agy-file-enhanced])',
  );
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    if (!link) continue;
    link.dataset.agyLinkScanned = 'true';

    const rawHref = link.getAttribute('href') ?? '';
    const resolvedHref = link.href ?? '';
    if (rawHref.includes('/plugins/agy-link/embed') || resolvedHref.includes('/plugins/agy-link/embed')) continue;

    if (isImageFile(rawHref) || isImageFile(resolvedHref)) {
      enhanceImageLink(link, rawHref, resolvedHref);
    } else if (isVideoFile(rawHref) || isVideoFile(resolvedHref)) {
      enhanceVideoLink(link, rawHref, resolvedHref);
    } else if (isAudioFile(rawHref) || isAudioFile(resolvedHref)) {
      enhanceAudioLink(link, rawHref, resolvedHref);
    } else if (rawHref.startsWith('file://') || resolvedHref.startsWith('file://') || isLocalFilePath(rawHref)) {
      enhanceFileLink(link, rawHref, resolvedHref);
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
  enhanceLinks();
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
  if (a.dataset.agyLinkEnhanced === 'true' || a.dataset.agyVideoEnhanced === 'true' || a.dataset.agyAudioEnhanced === 'true' || a.dataset.agyFileEnhanced === 'true') return;
  if (target?.closest?.('.agy-image-link-chip')) return;

  const rawHref = a.getAttribute('href') ?? '';
  const resolvedHref = a.href ?? '';
  if (rawHref.includes('/plugins/agy-link/embed') || resolvedHref.includes('/plugins/agy-link/embed')) return;
  if (rawHref.startsWith('file://') || resolvedHref.startsWith('file://') || isLocalFilePath(rawHref)) {
    const pathToUse = rawHref.startsWith('file://') ? rawHref : (resolvedHref.startsWith('file://') ? resolvedHref : (rawHref || resolvedHref));
    if (/^https?:\/\//i.test(pathToUse) && !pathToUse.includes('/plugins/agy-link/')) return;

    e.preventDefault();
    e.stopPropagation();
    const fileName = pathToUse.split(/[/\\]/).pop() || pathToUse;
    if (openInRightSidebar(pathToUse)) {
      showToast(translateOr('file.openedInSidebar', 'Opened in the sidebar: {name}', { name: fileName }));
      return;
    }
    openInSystem(pathToUse, false).then((res) => {
      showToast(res.ok
        ? translateOr('file.openedInSystem', 'Opened in the system app: {name}', { name: fileName })
        : translateOr('file.openFailed', 'Could not open: {error}', { error: res.error || translateOr('file.notFound', 'file not found') }));
    });
  }
}

export function installImageEnhancer(ctx?: any): () => void {
  if (ctx) setClientContext(ctx);
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

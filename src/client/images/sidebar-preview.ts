// Native DSH right-sidebar media previewers (video, audio, extended images).
//
// Registers three `DocumentPreviewDefinition` entries (`loading: 'renderer'`)
// with DSH's `documentPreviews` service plus their matching keyed
// `sidebar.right.tab.document` React slot renderers. This lets users click any
// video, audio, or TIFF/HEIC file in DSH's native File Explorer or in chat
// links and preview it directly inside DSH's right sidebar (both locally and
// over Cloudflare Tunnel) without spawning any host OS application.
import { NS } from '../locales.ts';
import { h, useEffect, useState } from '../react.ts';
import { translateOr } from '../i18n-bridge.ts';
import {
  buildMediaUrl,
  isRemoteUrl,
  openInSystem,
  probeMediaError,
  shouldUseBuiltInMediaOnly,
  triggerBrowserDownload,
} from './media.ts';
import { openLightbox, showToast } from './lightbox.ts';
import { injectStyles } from './styles.ts';

export const SIDEBAR_VIDEO_ID = 'dsh-agy-link/video';
export const SIDEBAR_AUDIO_ID = 'dsh-agy-link/audio';
export const SIDEBAR_IMAGE_COMPAT_ID = 'dsh-agy-link/image-compat';

export const SIDEBAR_VIDEO_EXTENSIONS = [
  '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.ogv', '.avi', '.flv', '.wmv',
] as const;

export const SIDEBAR_AUDIO_EXTENSIONS = [
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus',
] as const;

// Standard web images (.png/.jpg/.webp/.gif/.svg/.bmp/.ico/.avif) keep DSH's
// built-in image previewer; we extend the sidebar with formats that require
// host-side compatibility conversion.
export const SIDEBAR_IMAGE_COMPAT_EXTENSIONS = [
  '.tif', '.tiff', '.heic', '.heif',
] as const;

export interface SidebarDocumentContentLike {
  kind?: string;
  revision?: number;
  absolutePath?: string;
  loaded?: (version?: string) => void;
  failed?: () => void;
  reload?: () => void;
}

export interface SidebarDocumentSlotProps {
  resourceAddress?: string;
  content?: SidebarDocumentContentLike;
  absolutePath?: string;
  sessionId?: string;
}

interface DocumentPreviewsServiceLike {
  register?: (definition: Record<string, unknown>) => (() => void) | undefined;
}

interface SidebarPreviewContextLike {
  get?: (name: string) => unknown;
  inject?: (deps: string[], apply: (scope: SidebarPreviewContextLike) => unknown) => unknown;
  effect?: (setup: () => () => void, label?: string) => unknown;
  slots?: {
    inject?: (name: string, register: () => () => void) => void;
    register?: (opts: Record<string, unknown>, Component: (props?: unknown) => unknown) => () => void;
  };
  [key: string]: unknown;
}

function readService<T>(ctx: unknown, name: string): T | undefined {
  const c = ctx as SidebarPreviewContextLike | null | undefined;
  if (!c) return undefined;
  try {
    const fromGet = c.get?.(name);
    if (fromGet !== undefined && fromGet !== null) return fromGet as T;
  } catch {
    // service absent in this composition
  }
  try {
    const direct = c[name];
    return direct === undefined || direct === null ? undefined : (direct as T);
  } catch {
    return undefined;
  }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sessionCwd(ctx: unknown, sessionId: string): string {
  if (!sessionId) return '';
  const sessions = readService<{ list?: { getSnapshot?: () => { byId?: Record<string, { cwd?: unknown }> } } }>(
    ctx,
    'sessions',
  );
  const cwd = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]?.cwd;
  return typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : '';
}

/**
 * Resolve a DSH sidebar `dsh-resource://file/session/<sessionId>/<path>` address
 * back to an absolute filesystem path suitable for `/plugins/agy-link/media`.
 */
export function resolveSidebarResourcePath(
  ctx: unknown,
  resourceAddress: string,
  metaAbsolutePath?: string,
): string {
  if (typeof metaAbsolutePath === 'string' && metaAbsolutePath.trim() !== '') {
    return metaAbsolutePath.trim();
  }
  const addr = (resourceAddress || '').trim();
  if (!addr) return '';
  const match = /^dsh-resource:\/\/file\/session\/([^/]+)\/(.*)$/i.exec(addr);
  if (match) {
    const sid = safeDecode(match[1] ?? '');
    const decodedRel = (match[2] ?? '')
      .split('/')
      .map(safeDecode)
      .join('/')
      .replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(decodedRel) || decodedRel.startsWith('/') || decodedRel.startsWith('//')) {
      return decodedRel;
    }
    const cwd = sessionCwd(ctx, sid);
    if (cwd) {
      return `${cwd}/${decodedRel.replace(/^\/+/, '')}`;
    }
    return decodedRel;
  }
  if (addr.startsWith('file://')) {
    let p = addr.slice(7);
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return safeDecode(p).replace(/\\/g, '/');
  }
  return addr;
}

type SidebarMediaKind = 'video' | 'audio' | 'image';

function withCacheBust(url: string, nonce: number): string {
  if (nonce <= 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}_r=${nonce}`;
}

function createSidebarMediaRenderer(
  ctx: unknown,
  kind: SidebarMediaKind,
): (props?: unknown) => unknown {
  return function SidebarMediaPreview(rawProps?: unknown): unknown {
    const props = (rawProps ?? {}) as SidebarDocumentSlotProps;
    const resourceAddress = props.resourceAddress ?? '';
    const content = props.content;
    const revision = content?.revision ?? 0;
    const filePath = resolveSidebarResourcePath(
      ctx,
      resourceAddress,
      props.absolutePath ?? content?.absolutePath,
    );
    const fileName = (filePath.split(/[/\\]/).pop() || resourceAddress || kind).trim();

    const [compatAttempted, setCompatAttempted] = useState(false);
    const [loading, setLoading] = useState(true);
    const [transcoding, setTranscoding] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [nonce, setNonce] = useState(0);

    useEffect(() => {
      injectStyles();
    }, []);

    useEffect(() => {
      setCompatAttempted(false);
      setLoading(true);
      setTranscoding(false);
      setErrorMsg(null);
      setNonce(0);
    }, [resourceAddress, revision]);

    const mediaSrc = filePath
      ? withCacheBust(
          buildMediaUrl(filePath, kind === 'video' && compatAttempted ? { compat: true } : undefined),
          nonce,
        )
      : '';

    const handleLoaded = (): void => {
      setLoading(false);
      setTranscoding(false);
      setErrorMsg(null);
      content?.loaded?.(String(revision));
    };

    const handleFailure = (urlToProbe: string): void => {
      setLoading(false);
      setTranscoding(false);
      setErrorMsg(
        translateOr(
          'lightbox.unavailableHint',
          'The file may still be generating, may have moved, or needs an external app.',
        ),
      );
      content?.failed?.();
      void probeMediaError(urlToProbe).then((detail) => {
        setErrorMsg(detail);
      });
    };

    const handleVideoError = (): void => {
      if (!compatAttempted && filePath && !isRemoteUrl(filePath)) {
        setCompatAttempted(true);
        setLoading(true);
        setTranscoding(true);
        setErrorMsg(null);
        return;
      }
      handleFailure(mediaSrc);
    };

    const handleReload = (): void => {
      setCompatAttempted(false);
      setLoading(true);
      setTranscoding(false);
      setErrorMsg(null);
      setNonce((n) => n + 1);
      content?.reload?.();
    };

    const handleCopyPath = (): void => {
      if (!filePath || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
      void navigator.clipboard.writeText(filePath).then(() => {
        showToast(translateOr('lightbox.pathCopied', 'File path copied to the clipboard'));
      }).catch(() => {});
    };

    const handleOpenInApp = (): void => {
      if (!filePath) return;
      void openInSystem(filePath, false).then((res) => {
        showToast(
          res.ok
            ? translateOr('lightbox.openedInApp', 'Opened in the system app')
            : translateOr('lightbox.openFailed', 'Could not open: {error}', {
                error: res.error || translateOr('lightbox.unknownError', 'unknown error'),
              }),
        );
      });
    };

    const builtInOnly = shouldUseBuiltInMediaOnly();
    const toolbarChildren: unknown[] = [
      h('span', { className: 'agy-sidebar-media-name', title: filePath }, fileName),
      h(
        'div',
        { className: 'agy-sidebar-media-actions' },
        kind !== 'audio' && filePath
          ? h(
              'button',
              {
                type: 'button',
                className: 'agy-sidebar-media-btn',
                'data-agy-action': 'fullscreen',
                onClick: () => openLightbox(mediaSrc, fileName, filePath),
              },
              translateOr('sidebarMedia.fullscreen', 'Fullscreen'),
            )
          : null,
        filePath
          ? h(
              'button',
              {
                type: 'button',
                className: 'agy-sidebar-media-btn',
                'data-agy-action': 'download',
                onClick: () => triggerBrowserDownload(filePath, fileName),
              },
              translateOr('sidebarMedia.download', 'Download'),
            )
          : null,
        filePath
          ? h(
              'button',
              {
                type: 'button',
                className: 'agy-sidebar-media-btn',
                'data-agy-action': 'copy-path',
                onClick: handleCopyPath,
              },
              translateOr('sidebarMedia.copyPath', 'Copy path'),
            )
          : null,
        filePath && !builtInOnly
          ? h(
              'button',
              {
                type: 'button',
                className: 'agy-sidebar-media-btn',
                'data-agy-action': 'open',
                onClick: handleOpenInApp,
              },
              translateOr('sidebarMedia.openInApp', 'Open in app'),
            )
          : null,
      ),
    ];

    let mediaNode: unknown = null;
    if (filePath && errorMsg === null) {
      if (kind === 'video') {
        mediaNode = h('video', {
          className: 'agy-sidebar-media-video',
          src: mediaSrc,
          controls: true,
          playsInline: true,
          preload: 'metadata',
          onLoadedMetadata: handleLoaded,
          onLoadedData: handleLoaded,
          onError: handleVideoError,
        });
      } else if (kind === 'audio') {
        mediaNode = h('audio', {
          className: 'agy-sidebar-media-audio',
          src: mediaSrc,
          controls: true,
          preload: 'metadata',
          onLoadedMetadata: handleLoaded,
          onCanPlay: handleLoaded,
          onError: () => handleFailure(mediaSrc),
        });
      } else {
        mediaNode = h('img', {
          className: 'agy-sidebar-media-img',
          src: mediaSrc,
          alt: fileName,
          onLoad: handleLoaded,
          onError: () => handleFailure(mediaSrc),
        });
      }
    }

    const statusBanner =
      errorMsg !== null
        ? h(
            'div',
            { className: 'agy-sidebar-media-error' },
            h('div', { className: 'agy-sidebar-media-error-title' }, translateOr('lightbox.unavailableTitle', 'Preview unavailable')),
            h('div', { className: 'agy-sidebar-media-error-detail' }, errorMsg),
            h(
              'div',
              { className: 'agy-sidebar-media-error-actions' },
              h(
                'button',
                { type: 'button', className: 'agy-sidebar-media-btn', 'data-agy-action': 'retry', onClick: handleReload },
                translateOr('sidebarMedia.retry', 'Reload'),
              ),
              filePath
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'agy-sidebar-media-btn',
                      'data-agy-action': 'download',
                      onClick: () => triggerBrowserDownload(filePath, fileName),
                    },
                    translateOr('sidebarMedia.download', 'Download'),
                  )
                : null,
            ),
          )
        : loading
          ? h(
              'div',
              { className: 'agy-sidebar-media-status' },
              transcoding
                ? translateOr('sidebarMedia.transcoding', 'Transcoding to browser-compatible MP4…')
                : translateOr('lightbox.loading', 'Loading media…'),
            )
          : null;

    return h(
      'div',
      { className: 'agy-sidebar-media', 'data-agy-sidebar-media': kind },
      h('div', { className: 'agy-sidebar-media-bar' }, ...toolbarChildren),
      h('div', { className: 'agy-sidebar-media-stage' }, statusBanner, mediaNode),
    );
  };
}

function buildDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      id: SIDEBAR_VIDEO_ID,
      extensions: [...SIDEBAR_VIDEO_EXTENSIONS],
      binaryExtensions: [...SIDEBAR_VIDEO_EXTENSIONS],
      priority: 'extension',
      title: () => translateOr('sidebarMedia.videoTitle', 'Video Preview'),
      loading: 'renderer',
      wrap: false,
    },
    {
      id: SIDEBAR_AUDIO_ID,
      extensions: [...SIDEBAR_AUDIO_EXTENSIONS],
      binaryExtensions: [...SIDEBAR_AUDIO_EXTENSIONS],
      priority: 'extension',
      title: () => translateOr('sidebarMedia.audioTitle', 'Audio Preview'),
      loading: 'renderer',
      wrap: false,
    },
    {
      id: SIDEBAR_IMAGE_COMPAT_ID,
      extensions: [...SIDEBAR_IMAGE_COMPAT_EXTENSIONS],
      binaryExtensions: [...SIDEBAR_IMAGE_COMPAT_EXTENSIONS],
      priority: 'extension',
      title: () => translateOr('sidebarMedia.imageTitle', 'Extended Image Preview'),
      loading: 'renderer',
      wrap: false,
    },
  ];
}

function registerPreviewDefinitions(ctx: SidebarPreviewContextLike): () => void {
  const registerAll = (scope: SidebarPreviewContextLike): (() => void) => {
    const previews = readService<DocumentPreviewsServiceLike>(scope, 'documentPreviews');
    if (typeof previews?.register !== 'function') return () => {};
    const disposers: Array<() => void> = [];
    for (const def of buildDefinitions()) {
      try {
        const d = previews.register(def);
        if (typeof d === 'function') disposers.push(d);
      } catch (err) {
        console.warn('[dsh-agy-link] sidebar documentPreview registration failed:', err);
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // already disposed with documentPreviews service
        }
      }
    };
  };

  if (typeof ctx.inject !== 'function') {
    return registerAll(ctx);
  }
  const fiber = ctx.inject(['documentPreviews'], (scope) => {
    if (typeof scope.effect !== 'function') return registerAll(scope);
    scope.effect(() => registerAll(scope), 'agy-link: sidebar documentPreviews');
    return undefined;
  }) as { dispose?: () => unknown } | undefined;

  return () => {
    try {
      fiber?.dispose?.();
    } catch {
      // fiber already disposed
    }
  };
}

/**
 * Install DSH native right-sidebar video, audio, and extended image previews.
 * Degrades cleanly to a no-op on hosts without `documentPreviews` or `slots`.
 */
export function installSidebarMediaPreviews(ctx: SidebarPreviewContextLike): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(registerPreviewDefinitions(ctx));

  const slots = ctx.slots;
  if (typeof slots?.inject === 'function' && typeof slots?.register === 'function') {
    const VideoRenderer = createSidebarMediaRenderer(ctx, 'video');
    const AudioRenderer = createSidebarMediaRenderer(ctx, 'audio');
    const ImageRenderer = createSidebarMediaRenderer(ctx, 'image');

    const slotDisposers: Array<() => void> = [];
    try {
      slots.inject('sidebar.right.tab.document', () => {
        const d1 = slots.register!(
          { name: 'sidebar.right.tab.document', key: SIDEBAR_VIDEO_ID, locale: NS },
          VideoRenderer,
        );
        const d2 = slots.register!(
          { name: 'sidebar.right.tab.document', key: SIDEBAR_AUDIO_ID, locale: NS },
          AudioRenderer,
        );
        const d3 = slots.register!(
          { name: 'sidebar.right.tab.document', key: SIDEBAR_IMAGE_COMPAT_ID, locale: NS },
          ImageRenderer,
        );
        const cleanup = (): void => {
          for (const d of [d3, d2, d1]) {
            try { d(); } catch { /* already torn down */ }
          }
        };
        slotDisposers.push(cleanup);
        return cleanup;
      });
    } catch (err) {
      console.warn('[dsh-agy-link] sidebar document slot registration failed:', err);
    }

    disposers.push(() => {
      for (const cleanup of slotDisposers.splice(0)) {
        try { cleanup(); } catch { /* already torn down */ }
      }
    });
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // ignore teardown errors
      }
    }
  };
}

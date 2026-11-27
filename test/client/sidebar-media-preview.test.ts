import '../helpers/client-render.ts'
import { React } from '../helpers/client-render.ts'

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html?: string, options?: Record<string, unknown>) => any }
const ReactDOMClient = nodeRequire('react-dom/client') as any
const testUtils = nodeRequire('react-dom/test-utils') as any

import {
  buildMediaUrl,
  isImageFile,
  isRemoteClient,
  isVideoFile,
  setBuiltInMediaPreviewOnly,
  shouldUseBuiltInMediaOnly,
} from '../../src/client/images/media.ts'
import { openLightbox, setLightboxSidebarOpener } from '../../src/client/images/lightbox.ts'
import { enhanceAudioLink } from '../../src/client/images/audio.ts'
import { scanAndEnhanceImages, setClientContext } from '../../src/client/images/scanner.ts'
import {
  SIDEBAR_AUDIO_ID,
  SIDEBAR_IMAGE_COMPAT_ID,
  SIDEBAR_VIDEO_ID,
  installSidebarMediaPreviews,
  resolveSidebarResourcePath,
} from '../../src/client/images/sidebar-preview.ts'
import { disposeStatusPolling, publishStatusSnapshot } from '../../src/client/status.ts'

const h = (React as { createElement: (type: unknown, props?: unknown) => unknown }).createElement

let dom: any
let saved: Array<[string, PropertyDescriptor | undefined]> = []

function setGlobal(key: string, value: unknown): void {
  saved.push([key, Object.getOwnPropertyDescriptor(globalThis, key)])
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
}

function installDom(url: string): any {
  restoreDom()
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url })
  const w = dom.window
  const keys = [
    'HTMLElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLVideoElement', 'HTMLAudioElement',
    'Node', 'Element', 'Event', 'MouseEvent', 'KeyboardEvent', 'URL', 'URLSearchParams',
  ]
  for (const key of keys) setGlobal(key, w[key])
  setGlobal('window', w)
  setGlobal('document', w.document)
  setGlobal('navigator', w.navigator)
  setGlobal('requestAnimationFrame', (cb: (t: number) => void) => w.requestAnimationFrame(cb))
  setGlobal('cancelAnimationFrame', (id: number) => w.cancelAnimationFrame(id))
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  return w
}

function restoreDom(): void {
  setClientContext(null)
  setLightboxSidebarOpener(null, null)
  setBuiltInMediaPreviewOnly(false)
  disposeStatusPolling()
  for (const [key, desc] of saved.reverse()) {
    if (desc !== undefined) Object.defineProperty(globalThis, key, desc)
    else delete (globalThis as Record<string, unknown>)[key]
  }
  saved = []
  if (dom !== undefined) {
    try { dom.window.close() } catch { /* ignore */ }
    dom = undefined
  }
}

afterEach(() => {
  restoreDom()
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function act(fn: () => void | Promise<void>): Promise<void> {
  await testUtils.act(async () => { await fn() })
}

test('media helpers: detect extended video/image formats, build compat/download/raw URLs, and distinguish local vs remote client', () => {
  assert.equal(isVideoFile('clip.avi'), true)
  assert.equal(isVideoFile('clip.m4v'), true)
  assert.equal(isVideoFile('clip.flv'), true)
  assert.equal(isVideoFile('clip.wmv'), true)
  assert.equal(isImageFile('photo.tiff'), true)
  assert.equal(isImageFile('photo.heic'), true)

  installDom('http://127.0.0.1:3000/')
  assert.equal(isRemoteClient(), false)
  assert.equal(shouldUseBuiltInMediaOnly(), false)
  assert.equal(
    buildMediaUrl('/tmp/a.mp4', { compat: true }),
    'http://127.0.0.1:3000/plugins/agy-link/media?path=%2Ftmp%2Fa.mp4&compat=1',
  )
  assert.equal(
    buildMediaUrl('/tmp/a.mp4', { download: true }),
    'http://127.0.0.1:3000/plugins/agy-link/media?path=%2Ftmp%2Fa.mp4&download=1',
  )

  // Local toggle forces built-in-only mode
  publishStatusSnapshot({ builtInMediaPreviewOnly: true })
  assert.equal(shouldUseBuiltInMediaOnly(), true)
  publishStatusSnapshot({ builtInMediaPreviewOnly: false })
  assert.equal(shouldUseBuiltInMediaOnly(), false)

  // Remote Cloudflare Tunnel origin automatically forces built-in-only mode
  installDom('https://dsh.example.com/chat')
  assert.equal(isRemoteClient(), true)
  assert.equal(shouldUseBuiltInMediaOnly(), true)
})

test('lightbox & audio & scanner: hide host Open/Reveal in remote or builtInMediaPreviewOnly mode, keep them locally', async () => {
  // 1. Local origin -> Open & Reveal visible
  installDom('http://127.0.0.1:3000/')
  setBuiltInMediaPreviewOnly(false)
  openLightbox('/plugins/agy-link/media?path=%2Ftmp%2Fa.png', 'A', '/tmp/a.png')
  assert.ok(document.querySelector('.agy-lightbox-btn[data-agy-action="open"]'), 'local lightbox shows Open')
  assert.ok(document.querySelector('.agy-lightbox-btn[data-agy-action="reveal"]'), 'local lightbox shows Reveal')
  assert.ok(document.querySelector('.agy-lightbox-btn[data-agy-action="download"]'), 'local lightbox shows Download')

  // 2. Local origin + builtInMediaPreviewOnly -> Open & Reveal hidden
  setBuiltInMediaPreviewOnly(true)
  openLightbox('/plugins/agy-link/media?path=%2Ftmp%2Fa.png', 'A', '/tmp/a.png')
  assert.equal(document.querySelector('.agy-lightbox-btn[data-agy-action="open"]'), null, 'built-in-only hides Open')
  assert.equal(document.querySelector('.agy-lightbox-btn[data-agy-action="reveal"]'), null, 'built-in-only hides Reveal')
  assert.ok(document.querySelector('.agy-lightbox-btn[data-agy-action="download"]'), 'Download remains available')

  // 3. Remote origin (Cloudflare) -> hides Open/Reveal in lightbox & audio, blocks openInSystem in scanner
  installDom('https://dsh.example.com/')
  const fetchUrls: string[] = []
  setGlobal('fetch', async (url: string) => {
    fetchUrls.push(url)
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })

  const audioLink = document.createElement('a')
  audioLink.setAttribute('href', 'file:///D:/work/voice.mp3')
  audioLink.textContent = 'voice.mp3'
  document.body.appendChild(audioLink)
  enhanceAudioLink(audioLink, 'file:///D:/work/voice.mp3', 'file:///D:/work/voice.mp3')
  const audioCard = document.querySelector('.agy-audio-card') as HTMLElement
  assert.ok(audioCard)
  assert.equal(audioCard.querySelector('[data-agy-action="open"]'), null, 'remote audio card hides host Open button')
  assert.ok(audioCard.querySelector('[data-agy-action="download"]'), 'remote audio card shows Download button')

  // Unpreviewable file link in remote mode must NOT call /plugins/agy-link/open
  const txtLink = document.createElement('a')
  txtLink.setAttribute('href', 'file:///D:/work/readme.txt')
  txtLink.textContent = 'readme.txt'
  document.body.appendChild(txtLink)
  scanAndEnhanceImages()
  txtLink.click()
  await wait(10)
  assert.equal(fetchUrls.some((u) => u.includes('/plugins/agy-link/open')), false, 'must never call /open from remote browser')
  assert.ok((document.querySelector('.agy-toast')?.textContent ?? '').includes('Host OS app launch is disabled'))
})

test('lightbox video: auto-retries with ?compat=1 on first error and displays real HTTP error on second failure', async () => {
  installDom('https://dsh.example.com/')
  setGlobal('fetch', async () => ({ ok: false, status: 403 }))

  openLightbox('https://dsh.example.com/plugins/agy-link/media?path=%2Ftmp%2Fbad.mp4', 'bad.mp4', '/tmp/bad.mp4')
  const video = document.querySelector('video.agy-lightbox-video') as HTMLVideoElement
  assert.ok(video, 'video element mounted')
  assert.equal(video.src.includes('compat=1'), false)

  // First error triggers transparent ?compat=1 retry instead of showing error card
  video.onerror?.(new Event('error'))
  assert.equal(video.src.includes('compat=1'), true, 'retries once with compat=1')
  assert.equal((document.querySelector('.agy-lightbox-error-card') as HTMLElement).style.display, 'none')

  // Second error shows error card and populates HTTP 403 reason via HEAD probe
  video.onerror?.(new Event('error'))
  assert.equal((document.querySelector('.agy-lightbox-error-card') as HTMLElement).style.display, 'flex')
  await wait(15)
  const hint = (document.querySelector('.agy-lightbox-error-hint') as HTMLElement).textContent ?? ''
  assert.match(hint, /HTTP 403/)
})

test('sidebar-preview: resolves session resource addresses, registers definitions + keyed slots, retries ?compat=1, and reports loaded/failed', async () => {
  installDom('https://dsh.example.com/')
  setGlobal('fetch', async () => ({ ok: false, status: 404 }))

  const registeredDefs: Array<Record<string, unknown>> = []
  const registeredSlots = new Map<string, (props?: unknown) => unknown>()
  let disposedDefs = 0
  let disposedSlots = 0

  const mockCtx = {
    get: (name: string) => {
      if (name === 'sessions') {
        return { list: { getSnapshot: () => ({ byId: { 'sess-1': { cwd: 'D:\\proj\\demo' } } }) } }
      }
      if (name === 'documentPreviews') {
        return {
          register: (def: Record<string, unknown>) => {
            registeredDefs.push(def)
            return () => { disposedDefs++ }
          },
        }
      }
      return undefined
    },
    inject: (deps: string[], fn: (scope: any) => unknown) => {
      assert.deepEqual(deps, ['documentPreviews'])
      let cleanup: (() => void) | undefined
      fn({
        get: (n: string) => mockCtx.get(n),
        effect: (setup: () => () => void) => { cleanup = setup() },
      })
      return { dispose: () => { cleanup?.() } }
    },
    slots: {
      inject: (name: string, register: () => () => void) => {
        assert.equal(name, 'sidebar.right.tab.document')
        register()
      },
      register: (opts: { key?: string }, Component: (props?: unknown) => unknown) => {
        if (opts.key) registeredSlots.set(opts.key, Component)
        return () => { disposedSlots++ }
      },
    },
  }

  // Path resolution from session resource URI
  assert.equal(
    resolveSidebarResourcePath(mockCtx, 'dsh-resource://file/session/sess-1/out/preview%20clip.mp4'),
    'D:/proj/demo/out/preview clip.mp4',
  )
  assert.equal(
    resolveSidebarResourcePath(mockCtx, 'dsh-resource://file/session/sess-1/C:/abs/clip.mp4'),
    'C:/abs/clip.mp4',
  )

  const dispose = installSidebarMediaPreviews(mockCtx)
  assert.deepEqual(
    registeredDefs.map((d) => d.id),
    [SIDEBAR_VIDEO_ID, SIDEBAR_AUDIO_ID, SIDEBAR_IMAGE_COMPAT_ID],
  )
  for (const def of registeredDefs) {
    assert.equal(def.loading, 'renderer')
    assert.equal(def.priority, 'extension')
    assert.deepEqual(def.binaryExtensions, def.extensions)
  }
  assert.ok(registeredSlots.has(SIDEBAR_VIDEO_ID))
  assert.ok(registeredSlots.has(SIDEBAR_AUDIO_ID))
  assert.ok(registeredSlots.has(SIDEBAR_IMAGE_COMPAT_ID))

  // Mount video sidebar component and test compat retry + error diagnostic + loaded callback
  const VideoComp = registeredSlots.get(SIDEBAR_VIDEO_ID)!
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = ReactDOMClient.createRoot(container)
  let loadedCalls = 0
  let failedCalls = 0

  await act(() => {
    root.render(
      h(VideoComp, {
        resourceAddress: 'dsh-resource://file/session/sess-1/out/demo.mp4',
        content: {
          kind: 'renderer',
          revision: 1,
          loaded: () => { loadedCalls++ },
          failed: () => { failedCalls++ },
        },
      }),
    )
  })

  const videoEl = container.querySelector('video.agy-sidebar-media-video') as HTMLVideoElement
  assert.ok(videoEl, 'sidebar video element rendered')
  assert.ok(videoEl.src.includes('D%3A%2Fproj%2Fdemo%2Fout%2Fdemo.mp4'))
  assert.equal(videoEl.src.includes('compat=1'), false)
  // Remote origin hides host Open in app button
  assert.equal(container.querySelector('[data-agy-action="open"]'), null)
  assert.ok(container.querySelector('[data-agy-action="fullscreen"]'))
  assert.ok(container.querySelector('[data-agy-action="download"]'))

  // Trigger first video error -> auto-switches to ?compat=1
  await act(() => { videoEl.dispatchEvent(new Event('error')) })
  const retriedVideo = container.querySelector('video.agy-sidebar-media-video') as HTMLVideoElement
  assert.equal(retriedVideo.src.includes('compat=1'), true, 'sidebar video auto-retries with compat=1')
  assert.equal(failedCalls, 0)

  // Trigger loadedmetadata -> calls content.loaded()
  await act(() => { retriedVideo.dispatchEvent(new Event('loadedmetadata')) })
  assert.equal(loadedCalls, 1)

  // Trigger second error -> calls content.failed() and shows HTTP 404 probe diagnostic
  await act(async () => {
    retriedVideo.dispatchEvent(new Event('error'))
    await wait(15)
  })
  assert.equal(failedCalls, 1)
  assert.match(container.textContent ?? '', /HTTP 404/)

  await act(() => { root.unmount() })
  dispose()
  assert.equal(disposedDefs, 3)
  assert.equal(disposedSlots, 3)
})

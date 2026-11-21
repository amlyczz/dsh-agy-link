// Sandboxed HTML widget delivery for Generative UI (`<agent-embed src="...">`).
// Serves confined local .html artifacts with strict CSP (no network/fetch,
// allowlisted Tailwind CSS CDN only) and injects a lightweight postMessage
// bridge for live DSH theme sync and auto-height resizing.
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import {
  isConfinementAllowed,
  isCrossOriginBlocked,
  resolveLocalMediaPath,
  type HttpRequestLike,
  type HttpResponseLike,
} from './media-route.ts'

const MAX_EMBED_BYTES = 2 * 1024 * 1024

const EMBED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://www.gstatic.com/antigravity/web/dev/tailwindcss.min.js",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
].join('; ')

function buildEmbedBridgeScript(embedId: string): string {
  const safeId = JSON.stringify(embedId)
  return `<script>
(function(){
  var EMBED_ID = ${safeId};
  var raf = 0;
  function postHeight(){
    raf = 0;
    try {
      var doc = document.documentElement;
      var body = document.body;
      var h = Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0, body ? body.offsetHeight : 0);
      if (h > 0 && window.parent) {
        window.parent.postMessage({ type: 'agy-embed-resize', id: EMBED_ID, height: h }, '*');
      }
    } catch (_) {}
  }
  function scheduleResize(){
    if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(postHeight);
  }
  window.addEventListener('message', function(ev){
    var d = ev && ev.data;
    if (!d || d.type !== 'agy-embed-theme') return;
    try {
      var root = document.documentElement;
      if (d.vars && typeof d.vars === 'object') {
        for (var k in d.vars) {
          if (Object.prototype.hasOwnProperty.call(d.vars, k) && typeof d.vars[k] === 'string') {
            root.style.setProperty(k, d.vars[k]);
          }
        }
      }
      root.classList.toggle('light', !d.dark);
      root.classList.toggle('dark', Boolean(d.dark));
      window.dispatchEvent(new Event('themechange'));
      scheduleResize();
    } catch (_) {}
  });
  function boot(){
    scheduleResize();
    if (typeof ResizeObserver === 'function' && document.documentElement) {
      new ResizeObserver(scheduleResize).observe(document.documentElement);
      if (document.body) new ResizeObserver(scheduleResize).observe(document.body);
    }
    setTimeout(postHeight, 120);
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.addEventListener('load', postHeight);
})();
</script>`
}

export function injectEmbedBridge(html: string, embedId: string): string {
  const snippet = buildEmbedBridgeScript(embedId)
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, () => snippet + '\n</head>')
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, () => snippet + '\n</body>')
  }
  return snippet + '\n' + html
}

export function handleEmbedRequest(
  req: HttpRequestLike,
  res: HttpResponseLike,
  opts: { workspaceRoot?: string; workspaceRoots?: string | readonly string[] } = {},
): void {
  if (isCrossOriginBlocked(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('cross-origin embed access denied')
    return
  }
  let targetPath = ''
  let embedId = 'embed'
  try {
    const u = new URL(req.url ?? '', 'http://localhost')
    targetPath = u.searchParams.get('path') ?? u.searchParams.get('url') ?? ''
    const rawId = u.searchParams.get('id') ?? 'embed'
    embedId = /^[a-zA-Z0-9_-]{1,64}$/.test(rawId) ? rawId : 'embed'
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('invalid url')
    return
  }
  if (!targetPath) {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('missing path query parameter')
    return
  }
  const roots = opts.workspaceRoots ?? opts.workspaceRoot
  const filePath = resolveLocalMediaPath(targetPath, roots)
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('embed artifact not found')
    return
  }
  const ext = extname(filePath).toLowerCase()
  if (ext !== '.html' && ext !== '.htm') {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('access denied: only .html/.htm widgets may be embedded')
    return
  }
  if (!isConfinementAllowed(filePath, roots)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('access denied: outside allowed workspace roots')
    return
  }
  try {
    const st = statSync(filePath)
    if (!st.isFile()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('not a regular file')
      return
    }
    if (st.size > MAX_EMBED_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain' })
      res.end('embed widget exceeds 2MB cap')
      return
    }
    const rawHtml = readFileSync(filePath, 'utf8')
    const body = injectEmbedBridge(rawHtml, embedId)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': EMBED_CSP,
    })
    res.end(body)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('failed to read embed widget: ' + String(err))
  }
}

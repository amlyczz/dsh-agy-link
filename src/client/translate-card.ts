// Translation card: the DSH-native surface that renders one Gemini translation.
//
// Split out of translate.ts (behavior-preserving). Owns the stylesheet, the
// minimal Markdown subset renderer and the card component itself; the record
// projection lives in translate-record.ts and the action strip in
// translate-state.ts.

import { BRAND_PATHS } from './brand-icons.ts'
import { h, useState, win, STYLE_ID } from './translate-context.ts'

const CSS = `
/* Card surface. It has to read as a HOST component, not a plugin banner: the
   recipe is DSH's own tool card (the console's agy-tv-card) — a hairline l1
   stroke, the markdown code-block fill, a 12px radius and a banner header.
   Nothing here is brand-themed. The only Gemini signal is one monochrome spark
   plus the "Gemini 译文" label; every colour is a DSH token, so light and dark
   come from the host theme instead of from this sheet. */
.agy-tsl-card {
  --agy-tsl-hairline: var(--dsw-alias-border-l1, rgba(127,127,127,.2));
  --agy-tsl-surface: var(--dsw-alias-markdown-code-block, rgba(127,127,127,.06));
  --agy-tsl-banner: var(--dsw-alias-markdown-code-block-banner, rgba(127,127,127,.04));
  margin: 12px 0 4px 0;
  border: 0.5px solid var(--agy-tsl-hairline);
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--agy-tsl-surface);
  overflow: hidden;
}
/* Explicit dark-theme fallbacks: DSH already flips every token, these only keep
   the card legible if a token is ever renamed or missing. */
body[data-ds-dark-theme] .agy-tsl-card,
body.dark .agy-tsl-card,
[data-theme="dark"] .agy-tsl-card {
  --agy-tsl-hairline: var(--dsw-alias-border-l1, rgba(255,255,255,.10));
  --agy-tsl-surface: var(--dsw-alias-markdown-code-block, rgba(255,255,255,.04));
  --agy-tsl-banner: var(--dsw-alias-markdown-code-block-banner, rgba(255,255,255,.03));
}
.agy-tsl-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  min-height: 32px; padding: 4px 8px 4px 12px;
  background: var(--agy-tsl-banner);
  border-bottom: 0.5px solid var(--agy-tsl-hairline);
  font-size: 12px; line-height: 20px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.agy-tsl-badge { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
/* Monochrome spark: identity by shape, accent by token — no gradient <defs>. */
.agy-tsl-mark { display: block; width: 14px; height: 14px; flex: 0 0 auto; color: inherit; }
.agy-tsl-badge > .agy-tsl-mark { color: var(--dsw-alias-state-business-primary, #4176e6); }
.agy-tsl-label {
  font-size: 12px; font-weight: 500; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #4a4c55);
}
.agy-tsl-meta {
  flex: 1 1 auto; min-width: 0; font-size: 11.5px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-caption, #8a8f98);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Actions wrap as ONE unit, so a narrow panel truncates the meta instead of
   splitting "copy" from "collapse" across two lines. */
.agy-tsl-actions {
  display: inline-flex; align-items: center; gap: 2px;
  flex: 0 0 auto; margin-left: auto;
}
/* Flat text buttons, same treatment as the console/tool-card copy button. */
.agy-tsl-btn {
  display: inline-flex; align-items: center; gap: 4px;
  margin: 0; padding: 2px 6px; border: 0; border-radius: var(--dsw-radius-xs, 4px);
  background: transparent; color: var(--dsw-alias-label-tertiary, #8a8f98);
  font: inherit; font-size: 11.5px; line-height: 16px; cursor: pointer;
  transition: background-color .1s ease, color .1s ease;
}
.agy-tsl-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, #1a1c21);
}
.agy-tsl-btn[data-active="true"] { color: var(--dsw-alias-label-primary, #1a1c21); }
.agy-tsl-body {
  padding: 10px 14px 12px 14px;
  font-size: var(--dsw-font-markdown-base-font-size, 14px);
  line-height: var(--dsw-font-markdown-base-line-height, 24px);
  color: var(--dsw-alias-label-primary, #1a1c21);
  overflow-wrap: break-word;
}
.agy-tsl-body p { margin: 0 0 8px 0; }
.agy-tsl-body p:last-child { margin-bottom: 0; }
.agy-tsl-body ul, .agy-tsl-body ol { margin: 0 0 8px 0; padding-left: 22px; }
.agy-tsl-body li { margin: 2px 0; }
.agy-tsl-body h4, .agy-tsl-body h5 { margin: 12px 0 6px 0; font-size: 14px; line-height: 22px; }
.agy-tsl-body code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: .9em; padding: 1px 4px; border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-markdown-inline-code, rgba(127,127,127,.16));
}
.agy-tsl-body pre {
  margin: 0 0 8px 0; padding: 10px 12px; overflow-x: auto;
  border: 0.5px solid var(--agy-tsl-hairline);
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--agy-tsl-banner);
}
.agy-tsl-body pre code { background: transparent; padding: 0; font-size: 12.5px; }
.agy-tsl-original {
  margin: 0; padding: 10px 14px;
  border-top: 0.5px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.28));
  font-size: 12.5px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #4a4c55);
  white-space: pre-wrap; max-height: 260px; overflow: auto;
}
/* Icon-only action that sits in the same strip as copy / thumbs / link, with
   the same neutral tint so it reads as part of that group. */
.agy-tsl-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--dsw-alias-label-tertiary, #8a8f98);
  cursor: pointer; transition: background .15s ease, color .15s ease;
}
.agy-tsl-icon:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14));
  color: var(--dsw-alias-label-primary, #1a1c21);
}
.agy-tsl-icon:disabled { cursor: default; }
.agy-tsl-icon[data-state="working"] { color: var(--dsw-alias-state-business-primary, #2563eb); cursor: wait; }
.agy-tsl-icon[data-state="done"] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.agy-tsl-icon[data-state="error"] { color: var(--dsw-alias-state-error-primary, #ef4444); }
.agy-tsl-icon svg { width: 15px; height: 15px; display: block; }
@keyframes agy-tsl-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
/* Own tooltip: the native title bubble never showed inside the desktop shell,
   and DSH's Tooltip primitive is not exposed to plugin bundles. It mirrors that
   primitive: same tokens (--dsw-alias-tooltip-bg / --dsw-static-neutral-bluish-00
   / 13px-20px / 3px 7px / --dsw-radius-sm), no caret, BELOW the anchor, and — like
   the primitive's portal — a body-level fixed node, so the transcript
   scroller can neither clip it nor let the composer cover it. */
.agy-tsl-wrap { position: relative; display: inline-flex; align-items: center; }
.agy-tsl-tip {
  position: fixed; z-index: 1100;
  padding: 3px 7px; border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-tooltip-bg, #1f2229);
  color: var(--dsw-static-neutral-bluish-00, #fff);
  font-size: 13px; line-height: 20px; font-weight: 400; letter-spacing: normal;
  white-space: pre-line; overflow-wrap: break-word; text-align: center;
  box-sizing: border-box; width: max-content;
  max-width: min(50vw, calc(100vw - 24px));
  pointer-events: none;
  animation: agy-tsl-tip-in .15s var(--ds-ease-in-out, ease-in-out);
}
@keyframes agy-tsl-tip-in { 0% { opacity: 0; } 100% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .agy-tsl-tip { animation: none; }
}
`

export function injectStyles(): void {
	if (typeof document === 'undefined') return
	const doc = win.document
	if (doc === null || doc === undefined) return
	const existing = doc.getElementById(STYLE_ID) as { textContent?: string } | null | undefined
	if (existing !== null && existing !== undefined) {
		// A plugin reload (the client HMR path, or a second copy of this plugin in
		// the same document) leaves the previous sheet behind. Returning early here
		// used to keep the OLD rules forever, so a newly added rule never applied —
		// that is exactly how the hover hint ended up rendered as plain inline text.
		if (existing.textContent !== CSS) existing.textContent = CSS
		return
	}
	const st = doc.createElement('style')
	st.id = STYLE_ID
	st.textContent = CSS
	const host = doc.head ?? doc.documentElement
	if (host) host.appendChild(st)
}

// ---------------------------------------------------------------------------
// Minimal Markdown renderer.
// The translation is Markdown; DSH's own renderer is internal to the chat
// package, so this renders the small subset the translator prompt produces
// (headings, lists, fenced code, inline bold/code) without a dependency.
// Everything is created as React elements (never innerHTML), so model output
// cannot inject HTML.
// ---------------------------------------------------------------------------

function inline(text: string): unknown[] {
	const out: unknown[] = []
	const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
	let last = 0
	let m: RegExpExecArray | null
	let i = 0
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) out.push(text.slice(last, m.index))
		const token = m[1] ?? ''
		if (token.startsWith('**')) out.push(h('strong', { key: 'b' + i }, token.slice(2, -2)))
		else out.push(h('code', { key: 'c' + i }, token.slice(1, -1)))
		last = m.index + token.length
		i++
	}
	if (last < text.length) out.push(text.slice(last) )
	return out
}

export function renderMarkdown(text: string): unknown {
	const lines = text.replace(/\r\n?/g, '\n').split('\n')
	const blocks: unknown[] = []
	let i = 0
	let key = 0
	while (i < lines.length) {
		const line = lines[i] ?? ''
		if (line.trim() === '') {
			i++
			continue
		}
		if (/^```/.test(line.trim())) {
			const lang = line.trim().slice(3).trim()
			const body: string[] = []
			i++
			while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
				body.push(lines[i] ?? '')
				i++
			}
			i++
			blocks.push(h('pre', { key: 'p' + key++ }, h('code', lang === '' ? null : { 'data-lang': lang }, body.join('\n'))))
			continue
		}
		if (/^#{1,4}\s+/.test(line)) {
			const label = line.replace(/^#{1,4}\s+/, '')
			blocks.push(h('h4', { key: 'h' + key++ }, inline(label)))
			i++
			continue
		}
		if (/^\s*[-*]\s+/.test(line)) {
			const items: unknown[] = []
			while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? '')) {
				items.push(h('li', { key: 'l' + key++ }, inline((lines[i] ?? '').replace(/^\s*[-*]\s+/, ''))))
				i++
			}
			blocks.push(h('ul', { key: 'u' + key++ }, items))
			continue
		}
		if (/^\s*\d+[.)]\s+/.test(line)) {
			const items: unknown[] = []
			while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
				items.push(h('li', { key: 'n' + key++ }, inline((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))))
				i++
			}
			blocks.push(h('ol', { key: 'o' + key++ }, items))
			continue
		}
		const para: string[] = []
		while (i < lines.length) {
			const cur = lines[i] ?? ''
			if (cur.trim() === '' || /^```/.test(cur.trim()) || /^#{1,4}\s+/.test(cur) || /^\s*[-*]\s+/.test(cur) || /^\s*\d+[.)]\s+/.test(cur)) break
			para.push(cur)
			i++
		}
		blocks.push(h('p', { key: 't' + key++ }, inline(para.join('\n'))))
	}
	return h('div', null, blocks)
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface TranslationCardData {
	text?: string
	original?: string
	model?: string
	effort?: string
	accountId?: string
	createdAt?: number
}

/**
 * The Gemini four-point spark. Drawn monochrome (`currentColor`) on purpose:
 * the card belongs to DSH's design system, so the brand shows up as one tinted
 * glyph in the header instead of a gradient-filled widget. Without <defs> there
 * is no per-render gradient id either, so several cards can coexist untouched.
 */
export function geminiMark(): unknown {
	return h(
		'svg',
		{ viewBox: '0 0 24 24', className: 'agy-tsl-mark', 'aria-hidden': 'true', focusable: 'false' },
		h('path', { d: BRAND_PATHS.gemini, fill: 'currentColor' }),
	)
}

/**
 * One native-looking card: banner header (spark + "Gemini 译文", model/effort as
 * caption meta, and the three flat actions) over DSH-markdown body text. Every
 * colour is a DSH token — the host theme decides light or dark.
 */
export const TranslationCard = (props?: Record<string, unknown>): unknown => {
	const node = (props?.node ?? {}) as { data?: TranslationCardData }
	const data = node.data ?? {}
	const t = (key: string, fallback?: string): string => {
		const fn = props?.t as ((k: string) => string) | undefined
		if (typeof fn !== 'function') return fallback ?? key
		try {
			const value = fn(key)
			return value === key && fallback !== undefined ? fallback : value
		} catch {
			return fallback ?? key
		}
	}
	const [open, setOpen] = useState(true)
	const [showOriginal, setShowOriginal] = useState(false)
	const [copied, setCopied] = useState(false)
	const text = typeof data.text === 'string' ? data.text : ''
	const original = typeof data.original === 'string' ? data.original : ''
	if (text.trim() === '') return null
	const meta: string[] = []
	if (typeof data.model === 'string' && data.model !== '') meta.push(data.model)
	if (typeof data.effort === 'string' && data.effort !== '') meta.push(data.effort)
	if (typeof data.accountId === 'string' && data.accountId !== '') meta.push(data.accountId)
	const copy = (): void => {
		void win.navigator?.clipboard?.writeText(text).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		}).catch(() => undefined)
	}
	const action = (key: string, label: string, onClick: () => void, active?: boolean): unknown =>
		h(
			'button',
			{
				key,
				type: 'button',
				className: 'agy-tsl-btn',
				...(active === undefined ? null : { 'data-active': active ? 'true' : 'false' }),
				onClick,
			},
			label,
		)
	const badge = t('tsl.badge', 'Gemini translation')
	return h(
		'div',
		{ className: 'agy-tsl-card', 'data-agy-translation': 'gemini', 'aria-label': badge },
		h(
			'div',
			{ className: 'agy-tsl-head' },
			h('span', { className: 'agy-tsl-badge' }, geminiMark(), h('span', { className: 'agy-tsl-label' }, badge)),
			meta.length === 0 ? null : h('span', { className: 'agy-tsl-meta', title: meta.join(' · ') }, meta.join(' · ')),
			h(
				'span',
				{ className: 'agy-tsl-actions' },
				original === ''
					? null
					: action(
							'original',
							showOriginal ? t('tsl.hideOriginal', 'Hide original') : t('tsl.showOriginal', 'Show original'),
							() => setShowOriginal(!showOriginal),
							showOriginal,
						),
				action('copy', copied ? t('tsl.copied', 'Copied') : t('tsl.copy', 'Copy'), copy),
				action('collapse', open ? t('tsl.collapse', 'Collapse') : t('tsl.expand', 'Expand'), () => setOpen(!open)),
			),
		),
		open ? h('div', { className: 'agy-tsl-body' }, renderMarkdown(text) as never) : null,
		showOriginal && original !== '' ? h('pre', { className: 'agy-tsl-original' }, original) : null,
	)
}

// Generative UI renderer: upgrades `/plugins/agy-link/embed?path=...` links
// produced from `<agent-embed>` into sandboxed, auto-resizing, theme-synced iframes.
import { isInteractionLocked, onScrollSettle } from './scroll-guard.ts';
import { translateOr } from './i18n-bridge.ts';
import { getOrigin, openInSystem } from './images/media.ts';
import { openInRightSidebar } from './images/scanner.ts';
import { showToast } from './images/lightbox.ts';

const EMBED_CSS = `
.agy-embed-card {
	display: flex;
	flex-direction: column;
	margin: 8px 0;
	border-radius: 10px;
	overflow: hidden;
	border: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28));
	background: var(--dsw-alias-markdown-code-block, rgba(127, 127, 127, 0.04));
}
.agy-embed-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 6px 10px;
	font-size: 11.5px;
	background: var(--dsw-alias-markdown-code-block-banner, rgba(127, 127, 127, 0.06));
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.18));
}
.agy-embed-title {
	font-weight: 600;
	color: var(--dsw-alias-label-primary, #1e293b);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.agy-embed-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
}
.agy-embed-btn {
	font-size: 11px;
	padding: 1px 7px;
	border-radius: 4px;
	border: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
	background: transparent;
	color: var(--dsw-alias-label-secondary, #64748b);
	cursor: pointer;
}
.agy-embed-btn:hover {
	color: var(--dsw-alias-label-primary, #0f172a);
}
.agy-embed-frame {
	width: 100%;
	height: 220px;
	border: none;
	display: block;
	background: transparent;
}
`;

function injectEmbedStyles(): void {
	if (typeof document === 'undefined') return;
	const id = 'dsh-agy-link-embed-css';
	if (document.getElementById(id) !== null) return;
	const st = document.createElement('style');
	st.id = id;
	st.textContent = EMBED_CSS;
	(document.head ?? document.documentElement)?.appendChild(st);
}

function readThemePayload(): { type: 'agy-embed-theme'; dark: boolean; vars: Record<string, string> } {
	const root = document.documentElement;
	const cs = typeof getComputedStyle === 'function' ? getComputedStyle(root) : null;
	const pickVar = (names: string[], fallback: string): string => {
		for (const n of names) {
			const v = cs?.getPropertyValue(n)?.trim();
			if (v) return v;
		}
		return fallback;
	};
	const cls = (root.className || '').toLowerCase();
	const dt = (root.getAttribute('data-theme') || '').toLowerCase();
	const dark = cls.includes('dark') || dt === 'dark' || (!cls.includes('light') && dt !== 'light' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches === true);
	const bg = pickVar(['--dsw-alias-bg-base', '--background'], dark ? '#0f172a' : '#ffffff');
	const card = pickVar(['--dsw-alias-markdown-code-block', '--card'], dark ? '#1e293b' : '#f8fafc');
	const border = pickVar(['--dsw-alias-border-l2', '--border'], dark ? '#334155' : '#e2e8f0');
	const fg = pickVar(['--dsw-alias-label-primary', '--foreground'], dark ? '#f1f5f9' : '#0f172a');
	const muted = pickVar(['--dsw-alias-label-tertiary', '--muted-foreground'], dark ? '#94a3b8' : '#64748b');
	const primary = pickVar(['--dsw-alias-state-business-primary', '--primary'], '#2563eb');
	return {
		type: 'agy-embed-theme',
		dark,
		vars: {
			'--background': bg,
			'--content': bg,
			'--card': card,
			'--sidebar': card,
			'--card-border': border,
			'--border': border,
			'--foreground': fg,
			'--muted-foreground': muted,
			'--placeholder': muted,
			'--code-foreground': fg,
			'--primary': primary,
			'--primary-foreground': '#ffffff',
			'--secondary': card,
			'--secondary-foreground': fg,
			'--accent': primary,
			'--link': primary,
			'--success': '#10b981',
			'--warning': '#f59e0b',
			'--error': '#ef4444',
			'--chart-1': '#3b82f6',
			'--chart-2': '#10b981',
			'--chart-3': '#f59e0b',
			'--chart-4': '#8b5cf6',
			'--chart-5': '#ec4899',
			'--chart-6': '#06b6d4',
		},
	};
}

let seq = 0;

export function installAgentEmbedRenderer(): () => void {
	if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.addEventListener !== 'function') {
		return () => {};
	}
	injectEmbedStyles();
	const frameMap = new Map<string, HTMLIFrameElement>();
	let scanTimer: ReturnType<typeof setTimeout> | null = null;

	const pruneDisconnected = () => {
		for (const [id, frame] of frameMap) {
			if (!frame.isConnected) frameMap.delete(id);
		}
	};

	const postThemeToAll = () => {
		pruneDisconnected();
		const payload = readThemePayload();
		for (const frame of frameMap.values()) {
			try {
				frame.contentWindow?.postMessage(payload, '*');
			} catch {
				// ignore detached frame
			}
		}
	};

	const scan = () => {
		if (isInteractionLocked()) return;
		pruneDisconnected();
		const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/plugins/agy-link/embed"]:not([data-agy-embed-scanned])');
		const origin = getOrigin();
		for (let i = 0; i < links.length; i++) {
			const link = links[i];
			if (!link) continue;
			link.dataset.agyEmbedScanned = 'true';
			const href = link.getAttribute('href') || link.href || '';
			let rawPath = '';
			try {
				const u = new URL(href, 'http://localhost');
				rawPath = u.searchParams.get('path') ?? '';
			} catch {
				continue;
			}
			if (!rawPath) continue;
			const embedId = `agy-embed-${++seq}`;
			const iframeSrc = `${origin}/plugins/agy-link/embed?path=${encodeURIComponent(rawPath)}&id=${encodeURIComponent(embedId)}`;
			const titleText = (link.textContent || 'Widget').replace(/^Widget:\s*/i, '').trim() || 'Widget';

			const card = document.createElement('div');
			card.className = 'agy-embed-card';

			const header = document.createElement('div');
			header.className = 'agy-embed-header';
			const title = document.createElement('span');
			title.className = 'agy-embed-title';
			title.textContent = titleText;
			title.title = rawPath;

			const actions = document.createElement('div');
			actions.className = 'agy-embed-actions';

			const iframe = document.createElement('iframe');
			iframe.className = 'agy-embed-frame';
			iframe.setAttribute('sandbox', 'allow-scripts');
			iframe.loading = 'lazy';
			iframe.src = iframeSrc;
			frameMap.set(embedId, iframe);

			iframe.addEventListener('load', () => {
				try {
					iframe.contentWindow?.postMessage(readThemePayload(), '*');
				} catch {
					// ignore
				}
			});

			const toggleBtn = document.createElement('button');
			toggleBtn.type = 'button';
			toggleBtn.className = 'agy-embed-btn';
			toggleBtn.textContent = translateOr('embed.collapse', 'Collapse');
			toggleBtn.onclick = () => {
				const collapsed = iframe.style.display === 'none';
				iframe.style.display = collapsed ? 'block' : 'none';
				toggleBtn.textContent = collapsed
					? translateOr('embed.collapse', 'Collapse')
					: translateOr('embed.expand', 'Expand');
			};

			const openBtn = document.createElement('button');
			openBtn.type = 'button';
			openBtn.className = 'agy-embed-btn';
			openBtn.textContent = translateOr('embed.source', 'Source');
			openBtn.onclick = () => {
				if (openInRightSidebar(rawPath)) {
					showToast(translateOr('file.openedInSidebar', 'Opened in the sidebar: {name}', { name: titleText }));
					return;
				}
				void openInSystem(rawPath, false).then((r) => {
					if (!r.ok) {
						showToast(translateOr('file.openFailed', 'Could not open: {error}', {
							error: r.error || translateOr('file.notFound', 'file not found'),
						}));
					}
				});
			};

			actions.appendChild(toggleBtn);
			actions.appendChild(openBtn);
			header.appendChild(title);
			header.appendChild(actions);
			card.appendChild(header);
			card.appendChild(iframe);

			link.style.display = 'none';
			link.insertAdjacentElement('afterend', card);
		}
	};

	const onMessage = (ev: MessageEvent) => {
		const data = ev.data as { type?: unknown; id?: unknown; height?: unknown } | null;
		if (!data || data.type !== 'agy-embed-resize' || typeof data.id !== 'string') return;
		const frame = frameMap.get(data.id);
		if (!frame || !frame.isConnected) {
			frameMap.delete(data.id);
			return;
		}
		if (ev.source !== frame.contentWindow) return;
		const h = Number(data.height);
		if (Number.isFinite(h) && h > 0) {
			frame.style.height = `${Math.max(80, Math.min(800, Math.ceil(h)))}px`;
		}
	};

	const scheduleScan = () => {
		if (isInteractionLocked() || scanTimer !== null) return;
		scanTimer = setTimeout(() => {
			scanTimer = null;
			scan();
		}, 100);
	};

	const domObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => scheduleScan()) : null;
	const themeObserver = typeof MutationObserver === 'function' ? new MutationObserver(() => postThemeToAll()) : null;
	const unbindSettle = onScrollSettle(() => scheduleScan());

	window.addEventListener('message', onMessage);
	if (document.body) {
		domObserver?.observe(document.body, { childList: true, subtree: true });
		scan();
	}
	if (document.documentElement) {
		themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
	}

	return () => {
		window.removeEventListener?.('message', onMessage);
		domObserver?.disconnect();
		themeObserver?.disconnect();
		unbindSettle();
		if (scanTimer !== null) clearTimeout(scanTimer);
		frameMap.clear();
	};
}

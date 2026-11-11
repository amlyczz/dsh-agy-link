// Modal machinery: the global open-state store, the multi-header host manager
// (exactly one mounted session header hosts the dialog), the body portal, and
// the generic overlay shell (escape + non-passive wheel/touch isolation).
//
// OVERLAY ISOLATION CONTRACT (2026-10-28 — "打开控制台后滚动闪屏"): an open
// console must FREEZE the page behind it, not merely draw on top. setOpen
// suspends the plugin's DOM scanners and toggles `agy-modal-open` on <html> so
// CSS locks the conversation scroller.

import { h, useEffect, reactDom } from '../react.ts';
import { win } from '../api.ts';
import { uiIcon } from '../icons.ts';
import { setOverlaySuspended } from '../scroll-guard.ts';

export const portalToBody = (node: unknown): unknown => {
	const body = win.document?.body ?? (typeof document !== 'undefined' ? document.body : null);
	if (body && reactDom && typeof reactDom.createPortal === 'function') {
		return reactDom.createPortal(node, body);
	}
	return node;
};

/** Global modal state for opening the Antigravity console dialog from the footer shortcut or header status. */
export const agyModalStore = {
	open: false,
	listeners: new Set<() => void>(),
	setOpen(v: boolean) {
		if (agyModalStore.open === v) return;
		agyModalStore.open = v;
		setOverlaySuspended(v);
		if (typeof document !== 'undefined' && document.documentElement) {
			document.documentElement.classList.toggle('agy-modal-open', v);
		}
		agyModalStore.listeners.forEach((fn) => fn());
	},
	subscribe(fn: () => void) {
		agyModalStore.listeners.add(fn);
		return () => {
			agyModalStore.listeners.delete(fn);
		};
	},
};

/**
 * Global modal host manager: ensures exactly one mounted session header hosts
 * the modal dialog portal reactively. The most recently focused or mounted
 * header is prioritized immediately to prevent host handoff flicker when
 * opened. If the primary header unmounts, the next available header is
 * seamlessly notified.
 */
export const modalHostManager = {
	listeners: new Map<string, (isPrimary: boolean) => void>(),
	activeId: null as string | null,

	register(id: string, onChange: (isPrimary: boolean) => void) {
		modalHostManager.listeners.set(id, onChange);
		// The first mounted session header takes priority as the active host.
		// Never steal activeId if a host is already assigned (prevents unmount/remount
		// thrashing during multi-header updates or quota sync).
		if (modalHostManager.activeId === null) {
			modalHostManager.activeId = id;
		}
		onChange(modalHostManager.activeId === id);

		return () => {
			modalHostManager.listeners.delete(id);
			if (modalHostManager.activeId === id) {
				const next = modalHostManager.listeners.keys().next().value ?? null;
				modalHostManager.activeId = next;
				if (next) {
					try { modalHostManager.listeners.get(next)?.(true); } catch {}
				}
			}
		};
	},

	claim(id: string) {
		if (modalHostManager.activeId !== id) {
			const prev = modalHostManager.activeId;
			modalHostManager.activeId = id;
			if (prev && prev !== id) {
				try { modalHostManager.listeners.get(prev)?.(false); } catch {}
			}
			try { modalHostManager.listeners.get(id)?.(true); } catch {}
		}
	},
};

export interface ModalProps {
	heading: unknown;
	closeLabel: string;
	onClose: () => void;
	ariaLabelledby?: string;
	children: unknown;
}

/** Generic full-screen console overlay: backdrop + panel + header + scroll body. */
export function Modal({ heading, closeLabel, onClose, ariaLabelledby, children }: ModalProps): unknown {
	useEffect(() => {
		const onKey = (e: any) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onClose();
			}
		};
		win.addEventListener?.('keydown', onKey, true);
		return () => win.removeEventListener?.('keydown', onKey, true);
	}, []);

	// The overlay owns the pointer. Wheel/touch over ANY part of the console that
	// is not its own scroll area must not reach the page behind it: React attaches
	// wheel passively, so preventDefault() inside onWheel is ignored — this is a
	// native NON-PASSIVE capture listener instead.
	useEffect(() => {
		if (typeof document === 'undefined') return;
		const block = (e: any): void => {
			const target = e?.target as { closest?: (selector: string) => unknown } | null;
			if (typeof target?.closest !== 'function') return;
			if (target.closest('.agy-modal-backdrop') === null) return;
			// The console's own scroller keeps its native scrolling.
			if (target.closest('.agy-modal-body') !== null) return;
			e.preventDefault?.();
		};
		document.addEventListener('wheel', block, { passive: false, capture: true });
		document.addEventListener('touchmove', block, { passive: false, capture: true });
		return () => {
			document.removeEventListener('wheel', block, true);
			document.removeEventListener('touchmove', block, true);
		};
	}, []);

	return h('div', {
		className: 'agy-modal-backdrop',
		onClick: (e: { target: unknown; currentTarget: unknown }) => {
			if (e.target === e.currentTarget) onClose();
		},
	},
		h('div', { className: 'agy-modal-panel', role: 'dialog', 'aria-modal': true, ...(ariaLabelledby ? { 'aria-labelledby': ariaLabelledby } : {}) },
			h('div', {
				className: 'agy-modal-head',
				style: {
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '14px 18px',
					borderBottom: '1px solid var(--agy-border-card)',
					background: 'var(--agy-bg-header)',
					color: 'var(--agy-text-primary)',
				},
			},
				heading,
				h('button', {
					type: 'button',
					title: closeLabel,
					'aria-label': closeLabel,
					style: {
						background: 'var(--agy-bg-btn)',
						border: '1px solid var(--agy-border-btn)',
						color: 'var(--agy-text-btn)',
						cursor: 'pointer',
						padding: '4px 8px',
						borderRadius: '6px',
						display: 'inline-flex',
						alignItems: 'center',
					},
					onClick: onClose,
				}, uiIcon('x', 14, 'var(--agy-text-btn)')),
			),
			h('div', { className: 'agy-modal-body', style: { overflowY: 'auto', overscrollBehavior: 'contain', padding: '18px', flex: '1', minHeight: 0, background: 'var(--agy-bg-panel)' } },
				children,
			),
		),
	);
}

// Transient toast banner. Type drives both the palette and the leading icon;
// the close button is a bare icon (this file lives under ui/, so a raw <button>
// with an inline style is allowed here).

import { h } from '../react.ts';
import { uiIcon } from '../icons.ts';
import { S } from '../styles.ts';

export interface ToastNotice {
	text: string;
	type: 'success' | 'info' | 'warn' | 'error';
	id: number;
}

export type ToastType = ToastNotice['type'];
export type ShowToast = (text: string, type?: ToastType) => void;

const TYPE_STYLES: Record<ToastNotice['type'], Record<string, unknown>> = {
	success: { background: 'var(--agy-toast-success-bg)', border: '1px solid var(--agy-toast-success-border)', color: 'var(--agy-toast-success-text)' },
	info: { background: 'var(--agy-toast-info-bg)', border: '1px solid var(--agy-toast-info-border)', color: 'var(--agy-toast-info-text)' },
	warn: { background: 'var(--agy-toast-warn-bg)', border: '1px solid var(--agy-toast-warn-border)', color: 'var(--agy-toast-warn-text)' },
	error: { background: 'var(--agy-toast-error-bg)', border: '1px solid var(--agy-toast-error-border)', color: 'var(--agy-toast-error-text)' },
};

export interface ToastProps {
	toast: ToastNotice | null;
	onClose: () => void;
	t: (key: any) => string;
}

export function Toast({ toast, onClose, t }: ToastProps): unknown {
	if (!toast) return null;
	const style = TYPE_STYLES[toast.type];
	return h('div', { style: { ...S.noticeBanner!, ...style } },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 } },
			uiIcon(toast.type === 'success' ? 'check' : toast.type === 'error' || toast.type === 'warn' ? 'alert' : 'globe', 14, style.color as string),
			h('span', null, toast.text),
		),
		h('button', {
			type: 'button',
			style: { background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px', opacity: 0.8, display: 'inline-flex', alignItems: 'center' },
			onClick: onClose,
			'aria-label': t('aria.closeToast'),
		}, uiIcon('x', 12)),
	);
}

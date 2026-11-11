// Shared button primitive.
//
// Variants map onto the existing S tokens so every console button keeps the
// exact type scale / borders / fills it shipped with:
//   default -> S.btn / S.btnSm      primary -> S.btnPrimary / S.btnSmPrimary
//   danger  -> S.btnDanger          ghost   -> transparent, inherited colour
// `size: 'sm' | 'md'` selects the small or regular token. A `style` overlay is
// accepted for the handful of genuinely bespoke buttons (micro move arrows,
// segmented controls, the pill badge) so NO raw <button> style lives outside
// this directory while the rendered pixels stay identical.

import { h } from '../react.ts';
import { S } from '../styles.ts';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost' | 'seg' | 'segActive' | 'pill' | 'dashed';
export type ButtonSize = 'sm' | 'md';

const ghostStyle: Record<string, unknown> = {
	background: 'transparent',
	border: 'none',
	color: 'inherit',
	cursor: 'pointer',
};

const pillStyle: Record<string, unknown> = {
	background: 'var(--agy-bg-header)',
	border: '1px solid var(--agy-border-card)',
	borderRadius: '999px',
	cursor: 'pointer',
	padding: '3px 10px',
	fontSize: '11.5px',
	fontWeight: 600,
	lineHeight: 1.5,
	color: 'var(--agy-text-primary)',
	display: 'inline-flex',
	alignItems: 'center',
	gap: '6px',
	boxShadow: 'var(--agy-shadow-card)',
	flexShrink: 0,
	whiteSpace: 'nowrap',
};

const dashedStyle: Record<string, unknown> = {
	width: '100%',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '5px',
	marginTop: '6px',
	padding: '5px 10px',
	fontSize: '11px',
	fontWeight: 600,
	cursor: 'pointer',
	background: 'var(--agy-bg-subbox)',
	border: '1px dashed var(--agy-border-box)',
	borderRadius: '6px',
};

const VARIANTS: Record<ButtonVariant, { md: Record<string, unknown>; sm: Record<string, unknown> }> = {
	default: { md: S.btn!, sm: S.btnSm! },
	primary: { md: S.btnPrimary!, sm: S.btnSmPrimary! },
	danger: { md: S.btnDanger!, sm: S.btnDanger! },
	ghost: { md: ghostStyle, sm: ghostStyle },
	seg: { md: S.segBtn!, sm: S.segBtn! },
	segActive: { md: S.segBtnActive!, sm: S.segBtnActive! },
	pill: { md: pillStyle, sm: pillStyle },
	dashed: { md: dashedStyle, sm: dashedStyle },
};

export interface ButtonProps {
	variant?: ButtonVariant;
	size?: ButtonSize;
	style?: Record<string, unknown>;
	className?: string;
	children?: unknown;
	[key: string]: unknown;
}

export function Button(props: ButtonProps): unknown {
	const { variant = 'default', size = 'md', style, className, children, ...rest } = props;
	const base = VARIANTS[variant][size];
	const merged: Record<string, unknown> = { ...base, ...(style ?? {}) };
	const attrs: Record<string, unknown> = { type: 'button', ...rest, style: merged };
	if (className !== undefined) attrs.className = className;
	return h('button', attrs, children);
}

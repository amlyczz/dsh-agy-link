// Quota presentation: the shared reset-countdown formatter and one family's
// 5h/weekly bars (brand mark, coloured progress, cooldown note). Module-level
// so the settings section and the Plugins-page dashboard render IDENTICAL
// quota visuals from one implementation.

import type { ManagedAccount } from '../../common/pool-types.ts';
import type { AgyLocaleKey } from '../locales.ts';
import { h } from '../react.ts';
import { brandIcon, FAMILY_BRAND } from '../icons.ts';
import { S } from '../styles.ts';

/**
 * Format reset timestamp into readable date/time + relative countdown.
 */
export function formatQuotaWindow(t: (key: AgyLocaleKey) => string, resetTimeStr?: string): {
	resetText: string;
	/** resetTime exists but is already in the past (window has rolled over). */
	expired: boolean;
} {
	if (!resetTimeStr) return { resetText: '', expired: false };
	try {
		const d = new Date(resetTimeStr);
		const diffMs = d.getTime() - Date.now();
		// A stale (already passed) resetTime means the window has ROLLED OVER —
		// the backend keeps reporting the previous boundary once the quota is
		// back at 100%, and a countdown into the past would be nonsense. Hide
		// the time but tell the caller so it can say "已重置" instead of a
		// mysterious blank (2026-10-16: every full 5h row lost its ↻ note).
		if (Number.isNaN(d.getTime()) || diffMs <= 0) return { resetText: '', expired: true };

		const totalMins = Math.ceil(diffMs / 60000);
		const days = Math.floor(totalMins / 1440);
		const hours = Math.floor((totalMins % 1440) / 60);
		const mins = totalMins % 60;
		const isWeekly = days >= 1;

		const countdown = days > 0
			? `${days}${t('duration.day')} ${hours}${t('duration.hour')}`
			: hours > 0 ? `${hours}${t('duration.hour')} ${mins}${t('duration.minute')}` : `${mins}${t('duration.minute')}`;
		const hh = d.getHours().toString().padStart(2, '0');
		const mm = d.getMinutes().toString().padStart(2, '0');
		const resetText = isWeekly
			? `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm} (${countdown})`
			: `${hh}:${mm} (${countdown})`;

		return { resetText, expired: false };
	} catch {
		return { resetText: '', expired: true };
	}
}

interface QuotaColors {
	bar: string;
	text: string;
	bg: string;
	border: string;
}

function getQuotaColors(pct: number): QuotaColors {
	if (pct < 0) {
		return {
			bar: 'var(--agy-quota-none-border)',
			text: 'var(--agy-quota-none-text)',
			bg: 'var(--agy-quota-none-bg)',
			border: 'var(--agy-quota-none-border)',
		};
	}
	if (pct <= 20) {
		return {
			bar: 'linear-gradient(90deg, #dc2626, #ef4444)',
			text: 'var(--agy-quota-low-text)',
			bg: 'var(--agy-quota-low-bg)',
			border: 'var(--agy-quota-low-border)',
		};
	}
	if (pct <= 50) {
		return {
			bar: 'linear-gradient(90deg, #d97706, #f59e0b)',
			text: 'var(--agy-quota-med-text)',
			bg: 'var(--agy-quota-med-bg)',
			border: 'var(--agy-quota-med-border)',
		};
	}
	return {
		bar: 'linear-gradient(90deg, #059669, #10b981)',
		text: 'var(--agy-quota-high-text)',
		bg: 'var(--agy-quota-high-bg)',
		border: 'var(--agy-quota-high-border)',
	};
}

const renderLine = (
	windowName: string,
	percent: number,
	c: QuotaColors,
	resetStr: string,
	rawFraction?: number,
	rawReset?: string,
	isRefreshing = false,
): unknown => {
	const isShimmer = percent < 0 || isRefreshing;
	const tooltipText = typeof rawFraction === 'number'
		? `${(rawFraction * 100).toFixed(1)}% (raw: ${rawFraction})${rawReset ? ` · reset: ${rawReset}` : ''}`
		: resetStr ? `↻ ${resetStr}` : undefined;
	return h('div', { className: 'agy-quota-line', style: { display: 'flex', alignItems: 'center', fontSize: '11.5px', margin: '2px 0' } },
		h('span', { style: { width: '64px', color: 'var(--agy-text-window-label)', fontSize: '11px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' } }, windowName),
		h('div', {
			className: isShimmer ? 'agy-shimmer-track' : '',
			style: S.progressBarBg,
		},
			h('div', {
				className: 'agy-progress-fill',
				style: {
					width: `${percent < 0 ? 100 : percent}%`,
					height: '100%',
					background: c.bar,
					borderRadius: '3px',
				},
			}),
		),
		h('span', {
			title: tooltipText,
			style: {
				padding: '1px 5px',
				borderRadius: '4px',
				background: c.bg,
				color: c.text,
				border: `1px solid ${c.border}`,
				fontWeight: 700,
				fontSize: '11px',
				lineHeight: 1.2,
				cursor: tooltipText ? 'help' : 'default',
				minWidth: '36px',
				textAlign: 'center',
				flexShrink: 0,
			},
		}, percent < 0 ? '—' : `${percent}%`),
		h('div', {
			style: {
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'flex-end',
				width: '150px',
				minWidth: '150px',
				flexShrink: 0,
				marginLeft: '6px',
			},
		},
			resetStr ? h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '10.5px', fontWeight: 500, whiteSpace: 'nowrap' } }, `↻ ${resetStr}`) : null,
		),
	);
};

/**
 * One family's quota block: brand mark + 5h/weekly bars with reset countdowns
 * and cooldown notes. Module-level so the settings section and the Plugins-page
 * dashboard render IDENTICAL quota visuals from one implementation.
 */
export function renderFamilyQuotaBar(
	t: (key: AgyLocaleKey) => string,
	label: string,
	familyKey: 'google' | 'argon' | 'anthropic' | 'openai',
	acc: ManagedAccount,
	isRefreshing = false,
): unknown {
	const info = acc.quotas[familyKey];
	const cd = acc.cooldowns[familyKey];
	const inCooldown = cd && cd.cooldownUntil > Date.now();

	// 5-Hour limit
	const has5h = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction);
	const pct5h = has5h ? Math.max(0, Math.min(100, Math.round(info!.remainingFraction! * 100))) : -1;
	const cdNote = inCooldown ? t('account.localCooldown') : '';
	const w5h = formatQuotaWindow(t, info?.resetTime);
	const expiredFull5h = w5h.expired && has5h && pct5h >= 100;

	// Weekly limit
	const hasWeekly = typeof info?.weeklyFraction === 'number' && Number.isFinite(info.weeklyFraction);
	const pctWeekly = hasWeekly ? Math.max(0, Math.min(100, Math.round(info!.weeklyFraction! * 100))) : -1;
	const wWeekly = formatQuotaWindow(t, info?.weeklyResetTime);
	const expiredFullWeekly = wWeekly.expired && hasWeekly && pctWeekly >= 100;

	const c5h = getQuotaColors(pct5h);
	const cWeekly = getQuotaColors(pctWeekly);

	const note5h = w5h.resetText ? w5h.resetText + cdNote : expiredFull5h ? t('quota.windowReset') + cdNote : cdNote.replace(/^ · /, '');
	const noteWeekly = wWeekly.resetText ? wWeekly.resetText : expiredFullWeekly ? t('quota.windowReset') : '';

	return h('div', { style: { margin: '4px 0', padding: '5px 8px', background: 'var(--agy-bg-subbox)', borderRadius: '6px', border: '1px solid var(--agy-border-box)' } },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700, fontSize: '12px', marginBottom: '3px', color: 'var(--agy-text-primary)' } },
			brandIcon(FAMILY_BRAND[familyKey], 13),
			h('span', null, label),
		),
		(familyKey !== 'argon' || has5h) ? renderLine(t('quota.fiveHour'), pct5h, c5h, note5h, info?.remainingFraction, info?.resetTime, isRefreshing) : null,
		renderLine(t('quota.weekly'), pctWeekly, cWeekly, noteWeekly, info?.weeklyFraction, info?.weeklyResetTime, isRefreshing),
	);
}

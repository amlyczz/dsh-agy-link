// Quota presentation: the shared reset-countdown formatter and one family's
// 5h/weekly bars (brand mark, coloured progress, cooldown note). Module-level
// so the settings section and the Plugins-page dashboard render IDENTICAL
// quota visuals from one implementation.

import type { ManagedAccount } from '../../common/pool-types.ts';
import { is5hQuotaBenched, isWeeklyQuotaBenched } from '../../common/quota-bench.ts';
import { computeQuotaPacing } from '../../common/quota-pacing.ts';
import type { AgyLocaleKey } from '../locales.ts';
import { h } from '../react.ts';
import { brandIcon, FAMILY_BRAND, uiIcon } from '../icons.ts';
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

const FIVE_H_MS = 5 * 3_600_000;
const SEVEN_D_MS = 7 * 24 * 3_600_000;

function describePacing(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	windowDurationMs: number,
	resetStr: string,
	rawFraction?: number,
	rawReset?: string,
) {
	const pacing = typeof rawFraction === 'number' ? computeQuotaPacing(rawFraction, rawReset, windowDurationMs) : null;
	const paceLabel = pacing === null ? ''
		: pacing.status === 'surplus' ? t('quota.paceSurplus', { pct: Math.round(Math.abs(pacing.surplus) * 100) })
		: pacing.status === 'burning_fast' ? t('quota.paceFast', { pct: Math.round(Math.abs(pacing.surplus) * 100) })
		: pacing.status === 'on_track' ? t('quota.paceOnTrack')
		: pacing.status === 'unactivated' ? t('quota.unactivated')
		: '';
	const tooltipText = typeof rawFraction === 'number'
		? `${(rawFraction * 100).toFixed(1)}%${paceLabel ? ` · ${paceLabel}` : ''}${rawReset ? ` · reset: ${rawReset}` : ''}`
		: resetStr ? `↻ ${resetStr}` : undefined;
	const showTimeMarker = pacing !== null && (pacing.status === 'surplus' || pacing.status === 'on_track' || pacing.status === 'burning_fast');
	const markerLeftPct = showTimeMarker ? Math.max(2, Math.min(98, Math.round(pacing.timeRemainingFraction * 100))) : 0;
	return { pacing, tooltipText, showTimeMarker, markerLeftPct };
}

const renderLine = (
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	windowName: string,
	percent: number,
	c: QuotaColors,
	resetStr: string,
	windowDurationMs: number,
	rawFraction?: number,
	rawReset?: string,
	isRefreshing = false,
): unknown => {
	// Only animate shimmer while an active quota refresh is running — never pin
	// infinite animations on every static `—` (unreported) bar, which caused
	// Chromium/Electron scroll flicker across multi-account lists.
	const isShimmer = isRefreshing;
	const { pacing, tooltipText, showTimeMarker, markerLeftPct } = describePacing(t, windowDurationMs, resetStr, rawFraction, rawReset);
	return h('div', { className: 'agy-quota-line', style: { display: 'flex', alignItems: 'center', fontSize: '11.5px', margin: '2px 0' } },
		h('span', { style: { width: '64px', color: 'var(--agy-text-window-label)', fontSize: '11px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap' } }, windowName),
		h('div', {
			className: isShimmer ? 'agy-shimmer-track' : '',
			style: { ...S.progressBarBg, position: 'relative' },
			title: tooltipText,
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
			showTimeMarker ? h('span', {
				title: t('quota.timeMarkerTitle'),
				style: {
					position: 'absolute',
					left: `${markerLeftPct}%`,
					top: '-1px',
					bottom: '-1px',
					width: '1.5px',
					background: 'var(--agy-text-primary)',
					opacity: 0.55,
					pointerEvents: 'none',
				},
			}) : null,
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
			resetStr
				? h('span', { style: { color: 'var(--agy-text-secondary)', fontSize: '10.5px', fontWeight: 500, whiteSpace: 'nowrap' } }, `↻ ${resetStr}`)
				: pacing?.status === 'unactivated'
					? h('span', { style: { color: 'var(--agy-text-tertiary)', fontSize: '10px', fontWeight: 500, whiteSpace: 'nowrap' } }, t('quota.unactivated'))
					: null,
		),
	);
};

/**
 * One family's quota block: brand mark + 5h/weekly bars with reset countdowns
 * and cooldown notes. Module-level so the settings section and the Plugins-page
 * dashboard render IDENTICAL quota visuals from one implementation.
 */
export function renderFamilyQuotaBar(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	label: string,
	familyKey: 'google' | 'argon' | 'anthropic' | 'openai',
	acc: ManagedAccount,
	isRefreshing = false,
): unknown {
	const info = acc.quotas[familyKey];
	const cd = acc.cooldowns[familyKey];
	const now = Date.now();
	const inCooldown = Boolean(cd && cd.cooldownUntil > now);
	const clearedAt = acc.quotaGateClearedAt?.[familyKey];
	const benched5h = !inCooldown && is5hQuotaBenched(info, clearedAt, now);
	const benchedWeekly = !inCooldown && isWeeklyQuotaBenched(info, clearedAt, now);

	// 5-Hour limit
	const has5h = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction);
	const pct5h = has5h ? Math.max(0, Math.min(100, Math.round(info!.remainingFraction! * 100))) : -1;
	const cdNote5h = inCooldown ? t('account.localCooldown') : benched5h ? t('account.quotaLimitedNote') : '';
	const w5h = formatQuotaWindow(t, info?.resetTime);
	const expiredFull5h = w5h.expired && has5h && pct5h >= 100;

	// Weekly limit
	const hasWeekly = typeof info?.weeklyFraction === 'number' && Number.isFinite(info.weeklyFraction);
	const pctWeekly = hasWeekly ? Math.max(0, Math.min(100, Math.round(info!.weeklyFraction! * 100))) : -1;
	const cdNoteWeekly = benchedWeekly ? t('account.quotaLimitedNote') : '';
	const wWeekly = formatQuotaWindow(t, info?.weeklyResetTime);
	const expiredFullWeekly = wWeekly.expired && hasWeekly && pctWeekly >= 100;

	const c5h = getQuotaColors(pct5h);
	const cWeekly = getQuotaColors(pctWeekly);

	const note5h = w5h.resetText ? w5h.resetText + cdNote5h : expiredFull5h ? t('quota.windowReset') + cdNote5h : cdNote5h.replace(/^ · /, '');
	const noteWeekly = wWeekly.resetText ? wWeekly.resetText + cdNoteWeekly : expiredFullWeekly ? t('quota.windowReset') + cdNoteWeekly : cdNoteWeekly.replace(/^ · /, '');

	return h('div', { style: { margin: '4px 0', padding: '5px 8px', background: 'var(--agy-bg-subbox)', borderRadius: '6px', border: '1px solid var(--agy-border-box)' } },
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', fontWeight: 700, fontSize: '12px', marginBottom: '3px', color: 'var(--agy-text-primary)' } },
			brandIcon(FAMILY_BRAND[familyKey], 13),
			h('span', null, label),
		),
		(familyKey !== 'argon' || has5h) ? renderLine(t, t('quota.fiveHour'), pct5h, c5h, note5h, FIVE_H_MS, info?.remainingFraction, info?.resetTime, isRefreshing) : null,
		renderLine(t, t('quota.weekly'), pctWeekly, cWeekly, noteWeekly, SEVEN_D_MS, info?.weeklyFraction, info?.weeklyResetTime, isRefreshing),
	);
}

/** Short absolute stamp for "this data is from …" notes (past tense). */
function formatSnapshotStamp(ms: number): string {
	const d = new Date(ms);
	const hh = d.getHours().toString().padStart(2, '0');
	const mm = d.getMinutes().toString().padStart(2, '0');
	return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/**
 * One-line "quota unavailable" note for an account whose last refresh produced
 * no authoritative snapshot.
 *
 * WHY (live 2026-11-19): `buildFamilyQuotas` deliberately keeps the previous
 * complete value when the summary failed — a partial fallback must never
 * overwrite good data — so a refused account renders yesterday's percentages
 * with nothing to say they are old. The user reported exactly that as "the
 * second account is stuck". The numbers stay honest; the freshness does not
 * get to hide.
 */
export function renderQuotaUnavailableNote(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	acc: ManagedAccount,
): unknown {
	const state = acc.quotaUnavailable;
	if (!state) return null;
	const stamps = Object.values(acc.quotas).map((q) => q?.updatedAt ?? 0).filter((ts) => ts > 0);
	const oldest = stamps.length > 0 ? Math.min(...stamps) : 0;
	const reason = t(`quota.unavailable.${state.reason}` as AgyLocaleKey);
	const isCritical = state.reason === 'validation_required' || state.reason === 'tos_violation';
	const toneText = isCritical ? 'var(--agy-quota-low-text)' : 'var(--agy-quota-med-text)';
	const toneBg = isCritical ? 'var(--agy-quota-low-bg)' : 'var(--agy-quota-med-bg)';
	const toneBorder = isCritical ? 'var(--agy-quota-low-border)' : 'var(--agy-quota-med-border)';
	const actionUrl = typeof state.actionUrl === 'string' && state.actionUrl.startsWith('https://') ? state.actionUrl : undefined;
	return h('div', {
		key: 'agy-quota-unavailable',
		style: {
			display: 'flex',
			alignItems: 'center',
			flexWrap: 'wrap',
			gap: '5px',
			margin: '2px 0 5px 0',
			padding: '3px 7px',
			borderRadius: '6px',
			fontSize: '11px',
			fontWeight: 600,
			color: toneText,
			background: toneBg,
			border: `1px solid ${toneBorder}`,
		},
	},
		uiIcon('alert', 10, toneText),
		h('span', null, `${t('quota.unavailableTitle')} · ${reason}`),
		actionUrl
			? h('a', {
				href: actionUrl,
				target: '_blank',
				rel: 'noopener noreferrer',
				style: { color: toneText, textDecoration: 'underline', fontWeight: 700 },
			}, t('quota.verifyNow'))
			: null,
		oldest > 0
			? h('span', { style: { fontWeight: 500, opacity: 0.85 } }, t('quota.unavailableSince', { time: formatSnapshotStamp(oldest) }))
			: null,
	);
}

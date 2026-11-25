// Quota presentation: the shared reset-countdown formatter and one family's
// 5h/weekly bars (brand mark, coloured progress, cooldown note). Module-level
// so the settings section and the Plugins-page dashboard render IDENTICAL
// quota visuals from one implementation.

import { effectiveFamilyCooldown, type ManagedAccount } from '../../common/pool-types.ts';
import { isFamilyCooling, isFamilyInCooldown } from '../../common/quota-bench.ts';
import { computeQuotaPacing } from '../../common/quota-pacing.ts';
import type { AgyLocaleKey } from '../locales.ts';
import { h } from '../react.ts';
import { brandIcon, FAMILY_BRAND, uiIcon } from '../icons.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import { Spinner } from '../ui/Spinner.ts';

export interface FamilyBarActions {
	isActive?: boolean;
	/** `isActive` came from the eligibility PREDICTION, not from a real use/pin. */
	predicted?: boolean;
	canSetActive?: boolean;
	settingActive?: boolean;
	clearingCooldown?: boolean;
	onSetActive?: () => void;
	onClearCooldown?: () => void;
}

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
	return h('div', { className: 'agy-quota-line', style: { display: 'flex', alignItems: 'center', fontSize: '11.5px', margin: '2px 0', minWidth: 0 } },
		h('span', { title: windowName, style: { width: '64px', color: 'var(--agy-text-window-label)', fontSize: '11px', fontWeight: 600, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, windowName),
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
				overflow: 'hidden',
			},
		},
			resetStr
				? h('span', { title: resetStr, style: { color: 'var(--agy-text-secondary)', fontSize: '10.5px', fontWeight: 500, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' } }, `↻ ${resetStr}`)
				: pacing?.status === 'unactivated'
					? h('span', { title: t('quota.unactivated'), style: { color: 'var(--agy-text-tertiary)', fontSize: '10px', fontWeight: 500, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' } }, t('quota.unactivated'))
					: null,
		),
	);
};

function formatCooldownTip(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	familyKey: 'google' | 'argon' | 'anthropic' | 'openai',
	acc: ManagedAccount,
	now: number,
): string {
	const cd = effectiveFamilyCooldown(acc, familyKey);
	if (cd && cd.cooldownUntil > now) {
		const mins = Math.max(1, Math.ceil((cd.cooldownUntil - now) / 60_000));
		const hours = Math.floor(mins / 60);
		const rem = mins % 60;
		const left = hours > 0 ? `${hours}${t('duration.hour')} ${rem}${t('duration.minute')}` : `${mins}${t('duration.minute')}`;
		return `${cd.reason} · ${left}`;
	}
	return t('status.cooldown');
}

function renderFamilyHeaderActions(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	cooling: boolean,
	cooldownTip: string,
	familyActions?: FamilyBarActions,
): unknown {
	if (cooling) {
		return h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 } },
			h('span', {
				key: 'cd-badge',
				title: cooldownTip,
				style: {
					...S.badgeTag!,
					background: 'rgba(245, 158, 11, 0.15)',
					color: '#f59e0b',
					borderColor: 'rgba(245, 158, 11, 0.4)',
					gap: '3px',
					fontSize: '10px',
					padding: '1px 5px',
					fontWeight: 700,
					whiteSpace: 'nowrap',
				},
			}, uiIcon('alert', 10, '#f59e0b'), t('status.cooldown')),
			familyActions?.onClearCooldown ? h(Button, {
				key: 'clear-cd',
				variant: 'default',
				size: 'sm',
				className: 'agy-btn',
				style: {
					color: 'var(--agy-warn-btn-text)',
					borderColor: 'var(--agy-warn-btn-border)',
					background: 'var(--agy-warn-btn-bg)',
					gap: '3px',
					fontSize: '10.5px',
					padding: '1px 6px',
					height: '20px',
				},
				disabled: familyActions.clearingCooldown,
				onClick: familyActions.onClearCooldown,
			}, ...(familyActions.clearingCooldown
				? [Spinner(), t('account.clearCooldown')]
				: [uiIcon('zap', 10, 'var(--agy-warn-btn-text)'), ` ${t('account.clearCooldown')}`])) : null,
		);
	}
	if (familyActions?.isActive) {
		// A family with no real pin resolves to "who WOULD be picked". Calling that
		// "当前使用" is what made the panel contradict the running session; the
		// predicted case says so explicitly, and offers the pin so it can be made real.
		const predicted = familyActions.predicted === true;
		const label = predicted ? t('account.predictedInUse') : t('status.inUse');
		const badge = h('span', {
			key: 'fam-active',
			title: label,
			style: {
				...S.badgeTag!,
				background: familyActions.predicted ? 'rgba(148, 163, 184, 0.14)' : 'rgba(16, 185, 129, 0.12)',
				color: familyActions.predicted ? 'var(--agy-text-secondary)' : '#10b981',
				borderColor: familyActions.predicted ? 'var(--agy-border-box)' : 'rgba(16, 185, 129, 0.45)',
				gap: '3px',
				fontSize: '10px',
				padding: '1px 5px',
				fontWeight: 700,
				whiteSpace: 'nowrap',
				flexShrink: 0,
			},
		}, uiIcon('zap', 10, predicted ? 'var(--agy-text-secondary)' : '#10b981'), label);
		if (!predicted) return badge;
		return h('div', { key: 'fam-predicted', style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flexShrink: 0 } },
			badge,
			familyActions.canSetActive && familyActions.onSetActive ? setActiveButton(t, familyActions) : null,
		);
	}
	if (familyActions?.canSetActive && familyActions.onSetActive) {
		return setActiveButton(t, familyActions);
	}
	return null;
}

/** The per-family "设为当前" pin, shared by the plain and predicted paths. */
function setActiveButton(
	t: (key: AgyLocaleKey) => string,
	familyActions: FamilyBarActions,
): unknown {
	return h(Button, {
		key: 'fam-set-active',
		variant: 'default',
		size: 'sm',
		className: 'agy-btn',
		style: { gap: '3px', fontSize: '10.5px', padding: '1px 6px', height: '20px', flexShrink: 0 },
		title: t('account.setActive'),
		disabled: familyActions.settingActive,
		onClick: familyActions.onSetActive,
	}, ...(familyActions.settingActive
		? [Spinner(), t('account.settingActive')]
		: [uiIcon('zap', 10), ` ${t('account.setActive')}`]));
}

/**
 * One family's quota block: brand mark, per-family active/cooling controls,
 * and 5h/weekly bars with reset countdowns. Module-level so the settings
 * section and the Plugins-page dashboard render IDENTICAL quota visuals.
 */
export function renderFamilyQuotaBar(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	label: string,
	familyKey: 'google' | 'argon' | 'anthropic' | 'openai',
	acc: ManagedAccount,
	isRefreshing = false,
	familyActions?: FamilyBarActions,
): unknown {
	const info = acc.quotas[familyKey];
	const now = Date.now();
	const cooling = isFamilyCooling(acc, familyKey, now);
	const inLocalCooldown = isFamilyInCooldown(acc, familyKey, now);
	const cooldownTip = inLocalCooldown ? formatCooldownTip(t, familyKey, acc, now) : t('status.cooldown');

	// 5-Hour limit
	const has5h = typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction);
	const pct5h = has5h ? Math.max(0, Math.min(100, Math.round(info!.remainingFraction! * 100))) : -1;
	const w5h = formatQuotaWindow(t, info?.resetTime);

	// Weekly limit
	const hasWeekly = typeof info?.weeklyFraction === 'number' && Number.isFinite(info.weeklyFraction);
	const pctWeekly = hasWeekly ? Math.max(0, Math.min(100, Math.round(info!.weeklyFraction! * 100))) : -1;
	const wWeekly = formatQuotaWindow(t, info?.weeklyResetTime);

	const c5h = getQuotaColors(pct5h);
	const cWeekly = getQuotaColors(pctWeekly);

	const note5h = w5h.resetText ? w5h.resetText : staleResetNote(t, w5h.expired, has5h, pct5h, info?.updatedAt);
	const noteWeekly = wWeekly.resetText ? wWeekly.resetText : staleResetNote(t, wWeekly.expired, hasWeekly, pctWeekly, info?.updatedAt);
	const isActive = Boolean(!cooling && familyActions?.isActive);
	const borderColor = isActive
		? 'var(--dsw-alias-state-business-primary, #3b82f6)'
		: cooling
			? 'rgba(245, 158, 11, 0.45)'
			: 'var(--agy-border-box)';

	return h('div', {
		// Stable hook: tests and diagnostics need to count rendered buckets without
		// matching localized label text.
		'data-family': familyKey,
		style: {
			margin: '4px 0',
			padding: '5px 8px',
			background: 'var(--agy-bg-subbox)',
			borderRadius: '6px',
			border: `1px solid ${borderColor}`,
		},
	},
		h('div', {
			style: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				flexWrap: 'wrap',
				gap: '6px',
				minWidth: 0,
				fontWeight: 700,
				fontSize: '12px',
				marginBottom: '3px',
				color: 'var(--agy-text-primary)',
			},
		},
			h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 } },
				brandIcon(FAMILY_BRAND[familyKey], 13),
				h('span', null, label),
			),
			renderFamilyHeaderActions(t, cooling, cooldownTip, familyActions),
		),
		// Hide the 5-hour row when a family is weekly-only (e.g. Free-tier Gemini or
		// dedicated Argon weekly bucket) so the card reflects the real quota structure.
		(has5h || (!hasWeekly && familyKey !== 'argon')) ? renderLine(t, t('quota.fiveHour'), pct5h, c5h, note5h, FIVE_H_MS, info?.remainingFraction, info?.resetTime, isRefreshing) : null,
		renderLine(t, t('quota.weekly'), pctWeekly, cWeekly, noteWeekly, SEVEN_D_MS, info?.weeklyFraction, info?.weeklyResetTime, isRefreshing),
		renderModelPauses(t, acc, now),
	);
}

/**
 * Model buckets that are paused while the family stays healthy — the image
 * model is the common case (`gemini-3.1-flash-image`). Shown under the family
 * bars so "76% but the image model is out" is legible instead of invisible.
 */
function renderModelPauses(t: (key: AgyLocaleKey) => string, acc: ManagedAccount, now: number): unknown {
	const paused = Object.entries(acc.modelCooldowns ?? {})
		.filter(([, cd]) => cd.cooldownUntil > now)
		.sort(([a], [b]) => a.localeCompare(b));
	if (paused.length === 0) return null;
	const label = paused
		.map(([model, cd]) => `${model} → ${new Date(cd.cooldownUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
		.join(' · ');
	return h('div', { style: { marginTop: '2px', fontSize: '10px', fontWeight: 600, color: '#f59e0b', wordBreak: 'break-word' } },
		`${t('quota.modelPaused')}: ${label}`);
}

/**
 * Note for a quota row whose reset boundary is ALREADY IN THE PAST.
 *
 * A passed boundary means the window rolled over, so the stored fraction
 * describes the PREVIOUS window, not the current one. At 100% that is exactly
 * "reset · available". Below 100% the row used to render a bare percentage with
 * no time marker at all, which reads as a live figure — reported 2026-11-23 on
 * an account stuck at 91% whose 5-hour boundary had passed 33 hours earlier.
 */
function staleResetNote(
	t: (key: AgyLocaleKey, vars?: Record<string, string | number>) => string,
	expired: boolean,
	hasValue: boolean,
	percent: number,
	updatedAt?: number,
): string {
	if (!expired || !hasValue) return '';
	if (percent >= 100) return t('quota.windowReset');
	return typeof updatedAt === 'number' && updatedAt > 0
		? t('quota.windowResetStale', { time: formatSnapshotStamp(updatedAt) })
		: '';
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
	// `no_summary_access` only DESCRIBES a free-tier shape when the account has no
	// 5-hour window at all. A paid account that already reported one is being
	// refused transiently; calling it "free-tier" contradicted its own Pro badge
	// and 5h bar in the SAME card (reported 2026-11-23).
	//
	// The 5h reading only counts as evidence while it is NEWER than the refusal:
	// a 5h bar frozen from before the account was refused says nothing about the
	// plan it has NOW (a lapsed Pro account keeps its old 100% row and would
	// otherwise be described as a refused paid account — reported 2026-11-23).
	const has5hEvidence = Object.values(acc.quotas).some(
		(q) => typeof q?.remainingFraction === 'number' && (q?.updatedAt ?? 0) > state.since,
	);
	const reasonKey = state.reason === 'no_summary_access' && has5hEvidence
		? 'quota.unavailable.no_summary_access_paid'
		: `quota.unavailable.${state.reason}`;
	const reason = t(reasonKey as AgyLocaleKey);
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

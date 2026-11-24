// Host-backed warmup progress and last-run summary indicator so status
// persists cleanly across closing and re-opening the console modal.

import type { ManagedAccount } from '../../common/pool-types.ts';
import type { WarmupStatusSnapshot } from '../../common/warmup-types.ts';
import { accountDisplayAlias } from './account-alias.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h } from '../react.ts';
import { S } from '../styles.ts';
import { Spinner } from '../ui/Spinner.ts';

function formatClock(ms: number): string {
	const d = new Date(ms);
	const hh = d.getHours().toString().padStart(2, '0');
	const mm = d.getMinutes().toString().padStart(2, '0');
	return `${hh}:${mm}`;
}

export function WarmupStatusBar(props: {
	t: Translator;
	warmupState: WarmupStatusSnapshot | null | undefined;
	accounts: readonly ManagedAccount[];
}): unknown {
	const { t, warmupState, accounts } = props;
	if (!warmupState) return null;

	if (warmupState.running) {
		const currentIdx = warmupState.currentAccountId
			? accounts.findIndex((a) => a.id === warmupState.currentAccountId)
			: -1;
		const current = currentIdx >= 0 ? accounts[currentIdx] : undefined;
		const accountLabel = current
			? accountDisplayAlias(t as never, current, currentIdx)
			: (warmupState.currentAccountId || '');
		const label = accountLabel
			? t('warmup.progressCurrent', {
				completed: warmupState.completed,
				total: warmupState.total,
				account: accountLabel,
			})
			: t('warmup.progress', {
				completed: warmupState.completed,
				total: warmupState.total,
			});
		return h('span', {
			key: 'warmup-running-badge',
			title: label,
			style: {
				...S.badgeTag!,
				fontSize: '11px',
				padding: '2px 7px',
				gap: '5px',
				color: '#f97316',
				borderColor: 'rgba(249, 115, 22, 0.35)',
				background: 'rgba(249, 115, 22, 0.08)',
				maxWidth: '100%',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
		}, Spinner(), label);
	}

	const last = warmupState.lastRun;
	if (!last) return null;
	const detail = last.accounts
		.map((a) => `${a.alias}: ok=${a.succeeded}, skip=${a.skipped}, fail=${a.failed}${a.lastError ? ` (${a.lastError.slice(0, 120)})` : ''}`)
		.join('\n');
	return h('span', {
		key: 'warmup-last-run',
		title: detail || undefined,
		style: {
			fontSize: '11px',
			color: last.failed > 0 ? 'var(--agy-warn-text)' : 'var(--agy-text-tertiary)',
			fontWeight: 500,
			maxWidth: '100%',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			whiteSpace: 'nowrap',
			cursor: detail ? 'help' : 'default',
		},
	}, t('warmup.lastRun', {
		time: formatClock(last.finishedAt),
		ok: last.succeeded,
		skipped: last.skipped,
		failed: last.failed,
	}));
}

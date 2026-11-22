// "Same Google account twice" badge. Split out of AccountsPanel so the panel
// stays under the module-size budget and the rule lives in one place.
import { siblingAliases } from '../../common/account-duplicates.ts'
import type { ManagedAccount } from '../../common/pool-types.ts'
import { h } from '../react.ts'
import { S } from '../styles.ts'
import { uiIcon } from '../icons.ts'
import type { Translator } from '../hooks/useTranslation.ts'

/**
 * Renders null unless another row in the pool carries the same Google email.
 * Two rows for one account share one quota and one credential identity, so the
 * pool over-reports capacity and the Windows credential slot thrashes between
 * them; the badge names the siblings instead of silently double-counting.
 */
export function renderDuplicateBadge(t: Translator, acc: ManagedAccount, accounts: readonly ManagedAccount[]): unknown {
	const siblings = siblingAliases(acc, accounts)
	if (siblings.length === 0) return null
	return h('span', {
		style: {
			...S.badgeTag!,
			background: 'var(--agy-badge-email-bg)',
			color: '#b45309',
			borderColor: '#fcd34d',
			gap: '3px',
			fontSize: '10px',
			padding: '1px 5px',
			fontWeight: 700,
			whiteSpace: 'nowrap',
			flexShrink: 0,
		},
		title: t('status.duplicateTitle') + ': ' + siblings.join(', '),
	}, uiIcon('alert', 10, '#b45309'), t('status.duplicate'))
}

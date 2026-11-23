// ONE rule for rendering an account label, shared by the console card, the
// account-action toasts and the session header badge.
//
// WHY: three copies drifted. Each detected a "generated default" alias by
// comparing the STORED string with the old Chinese literal
// `主账号 (系统登录)`, so an account created by a newer version (which stores the
// English label, or a localized one) fell through to its raw stored text on
// the card and in the badge while another surface rendered the localized
// default — the same account reading differently in two places.
// A row is a generated label when the flag says so, or when the flag predates
// the row and the row is the machine-wide primary slot.
import type { ManagedAccount } from '../../common/pool-types.ts'
import type { AgyLocaleKey } from '../locales/zh.ts'

export type AliasTranslator = (key: AgyLocaleKey, vars?: Record<string, string | number>) => string

export function accountDisplayAlias(
	t: AliasTranslator,
	acc: ManagedAccount | undefined,
	index: number,
): string {
	if (acc === undefined) return ''
	const generated = acc.defaultAlias === true || (acc.defaultAlias === undefined && acc.systemHome === true)
	if (!generated) return acc.alias ?? ''
	if (acc.systemHome === true) return t('account.defaultAlias')
	if (index < 0) return acc.alias ?? ''
	return t('account.aliasDefault', { number: index + 1 })
}
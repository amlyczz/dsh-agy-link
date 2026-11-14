// Issue #107: opt-in pool-wide model catalog. Extracted from the runtime
// settings rows so the panel stays within the file/function size budget.
import { h } from '../react.ts';
import { S } from '../styles.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import type { StatusPayload } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { Row } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';

export function renderPoolWideCatalogRow(args: {
	t: Translator;
	status: StatusPayload;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}): unknown {
	const { t, status, loadingAction, setCfg } = args;
	const on = status.poolWideCatalog === true;
	return h(Row, {
		left: h('div', { style: { display: 'flex', flexDirection: 'column' } },
			h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, t('config.poolWideCatalog')),
			h('span', { style: S.muted }, t('config.poolWideCatalogDesc')),
		),
		right: segGroup([
			h(Button, {
				variant: on ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:poolWideCatalog',
				onClick: () => void setCfg('poolWideCatalog', true),
			}, t('config.on')),
			h(Button, {
				variant: !on ? 'segActive' : 'seg',
				disabled: loadingAction === 'config:poolWideCatalog',
				onClick: () => void setCfg('poolWideCatalog', false),
			}, t('config.off')),
		]),
	});
}

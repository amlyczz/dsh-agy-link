// Issue #105: the two user-hideable affordances. Extracted from the runtime
// settings rows so both the panel and its row builder stay under the size
// budget; the switches are pure presentation — the single source of truth is
// the /status snapshot (see .spec/ui-visibility.md).
import { h } from '../react.ts';
import { S } from '../styles.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import type { StatusPayload } from '../status.ts';
import { Button } from '../ui/Button.ts';
import { Row } from '../ui/Row.ts';
import { segGroup } from '../ui/SegGroup.ts';

interface VisibilityRowOptions {
	t: Translator;
	label: Parameters<Translator>[0];
	desc: Parameters<Translator>[0];
	key: 'showHeaderBadge' | 'showTranslateAction';
	visible: boolean;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}

function visibilityRow(o: VisibilityRowOptions): unknown {
	return h(Row, {
		left: h('div', { style: { display: 'flex', flexDirection: 'column' } },
			h('span', { style: { color: 'var(--agy-text-primary)', fontWeight: 600, fontSize: '12.5px' } }, o.t(o.label)),
			h('span', { style: S.muted }, o.t(o.desc)),
		),
		right: segGroup([
			h(Button, {
				variant: o.visible ? 'segActive' : 'seg',
				disabled: o.loadingAction === 'config:' + o.key,
				onClick: () => void o.setCfg(o.key, true),
			}, o.t('config.on')),
			h(Button, {
				variant: !o.visible ? 'segActive' : 'seg',
				disabled: o.loadingAction === 'config:' + o.key,
				onClick: () => void o.setCfg(o.key, false),
			}, o.t('config.off')),
		]),
	});
}

/** Returns two rows; React flattens the array inside the parent's children. */
export function renderVisibilityRows(args: {
	t: Translator;
	status: StatusPayload;
	loadingAction: string | null;
	setCfg: (key: string, value: unknown) => Promise<void>;
}): unknown[] {
	const common = { t: args.t, loadingAction: args.loadingAction, setCfg: args.setCfg };
	return [
		visibilityRow({
			...common,
			label: 'config.showHeaderBadge',
			desc: 'config.showHeaderBadgeDesc',
			key: 'showHeaderBadge',
			visible: args.status.showHeaderBadge !== false,
		}),
		visibilityRow({
			...common,
			label: 'config.showTranslateAction',
			desc: 'config.showTranslateActionDesc',
			key: 'showTranslateAction',
			visible: args.status.showTranslateAction !== false,
		}),
	];
}

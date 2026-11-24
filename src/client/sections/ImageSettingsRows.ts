// Image generation settings row + CLI command copy box. Extracted from
// SettingsSection.ts to keep the console well under the module size budget.
import { geminiCatalogModels, translateEffortOptions, translateModelOptions, type EffortLabels } from '../config-options.ts';
import type { Translator } from '../hooks/useTranslation.ts';
import { h } from '../react.ts';
import type { CatalogModelView, StatusPayload } from '../status.ts';
import { S } from '../styles.ts';
import { Button } from '../ui/Button.ts';
import { Row, rowCaption } from '../ui/Row.ts';
import { Select } from '../ui/Select.ts';

export const IMAGE_CLI_SAMPLE = 'dsh-agy-image -p "…" -a 16:9 -o ./image.jpg';

export function renderImageRow(
	t: Translator,
	status: StatusPayload,
	catalogModels: ReadonlyArray<CatalogModelView>,
	loadingAction: string | null,
	setCfg: (key: string, value: unknown) => Promise<void>,
	copyImageCommand: () => void,
	labels: EffortLabels,
): unknown {
	return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
		h(Row, {
			style: { padding: 0, borderBottom: 'none', gap: '8px 10px' },
			left: rowCaption(t('config.image'), t('config.imageDesc')),
			right: h('div', { style: S.cfgRowRight },
				h(Select, {
					value: status.imageModel ?? '',
					ariaLabel: t('config.imageModel'),
					title: t('config.imageModelDesc'),
					disabled: loadingAction === 'config:imageModel',
					onChange: (e: { target?: { value?: string } }) => void setCfg('imageModel', e?.target?.value ?? ''),
					options: translateModelOptions(status.imageModel ?? '', geminiCatalogModels(catalogModels), t('config.translateModelAuto')),
				}),
				h(Select, {
					value: status.imageEffort ?? '',
					ariaLabel: t('config.imageEffort'),
					title: t('config.imageEffortDesc'),
					style: { minWidth: '78px', maxWidth: '110px' },
					disabled: loadingAction === 'config:imageEffort',
					onChange: (e: { target?: { value?: string } }) => void setCfg('imageEffort', e?.target?.value ?? ''),
					options: translateEffortOptions(status.imageEffort ?? '', labels, status.imageModel ?? '', catalogModels),
				}),
			),
		}),
		h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
			h('code', {
				style: {
					flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
					fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px',
					color: 'var(--agy-text-secondary)', background: 'var(--agy-bg-subbox)',
					border: '1px solid var(--agy-border-subbox)', borderRadius: '5px', padding: '3px 7px',
				},
			}, IMAGE_CLI_SAMPLE),
			h(Button, {
				variant: 'default', size: 'sm', className: 'agy-btn',
				style: { flex: '0 0 auto', whiteSpace: 'nowrap' },
				onClick: copyImageCommand,
			}, t('config.imageCopy')),
		),
	);
}

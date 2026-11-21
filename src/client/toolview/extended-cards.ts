// Structured body renderer for swarm, run_workflow, schedule, manage_task, subagent, and browser cards.
import { translateOr } from '../i18n-bridge.ts';
import { buildMediaUrl, openLightbox } from '../images.ts';
import { clip, trimTrailingBlankLines, tr, type Translate } from './format.ts';
import { ensureExtendedToolStyles } from './extended-styles.ts';
import { hx } from './runtime.ts';
import type { MirrorCardModel } from './types.ts';

export function ExtendedCardBody({ model, t }: { model: MirrorCardModel; t?: Translate }): unknown {
	ensureExtendedToolStyles();
	const h = hx;
	const badges = model.badges ?? [];
	const outText = model.output !== undefined && model.output !== ''
		? trimTrailingBlankLines(model.output)
		: undefined;
	const shot = model.imagePath || model.imagePaths?.[0];
	const shotUrl = shot ? buildMediaUrl(shot) : null;

	return h('div', { className: 'agy-tv-ext-wrap' },
		badges.length > 0
			? h('div', { className: 'agy-tv-ext-badges' },
				...badges.map((b, i) => h('span', {
					key: 'b-' + i,
					className: 'agy-tv-ext-badge',
					'data-tone': b.tone ?? 'neutral',
				}, b.label)),
			)
			: null,
		model.url
			? h('div', { className: 'agy-tv-ext-url' }, model.url)
			: null,
		model.brief
			? h('pre', { className: 'agy-tv-ext-brief' }, clip(model.brief, 8000))
			: null,
		shotUrl && shot
			? h('div', { className: 'agy-tv-ext-shot' },
				h('div', {
					className: 'agy-tv-img-preview-box',
					onClick: (e: { stopPropagation: () => void }) => {
						e.stopPropagation();
						openLightbox(shotUrl, model.title, shot);
					},
					title: translateOr('image.lightboxHint', 'Click to open lightbox'),
				},
					h('img', {
						className: 'agy-tv-img-thumb',
						src: shotUrl,
						alt: model.title,
						loading: 'lazy',
					}),
				),
			)
			: null,
		outText !== undefined
			? h('pre', { className: 'agy-tv-card-content' }, clip(outText, 16000))
			: (!model.brief && !shotUrl
				? h('pre', { className: 'agy-tv-card-content' }, tr(t, 'tv.noDetail', '(no detail)'))
				: null),
	);
}

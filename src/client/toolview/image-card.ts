// Image-generation card body (thumbnail + lightbox).

import { translateOr } from '../i18n-bridge.ts';
import { buildMediaUrl, openLightbox } from '../images.ts';
import { hx } from './runtime.ts';
import type { MirrorCardModel } from './types.ts';

export function ImageCardBody({ model }: { model: MirrorCardModel }): unknown {
	const h = hx;
	const prompt = model.prompt || '';
	const name = model.imageName || 'image';
	const ratio = model.aspectRatio || '1:1';
	const primary = model.imagePath || model.path || '';
	const paths = (model.imagePaths && model.imagePaths.length > 0)
		? model.imagePaths
		: (primary ? [primary] : []);
	const mediaUrls = paths.map((p) => ({ path: p, url: buildMediaUrl(p) }));

	return h('div', { className: 'agy-tv-img-wrap' },
		h('div', { className: 'agy-tv-img-meta' },
			h('div', { className: 'agy-tv-img-prompt', title: prompt || name }, prompt ? `"${prompt}"` : name),
			h('div', { className: 'agy-tv-img-badges' },
				h('span', { className: 'agy-tv-img-badge' }, ratio),
				...(paths.map((p, idx) => h('span', { key: 'path-' + idx, className: 'agy-tv-img-badge', title: p }, p.split(/[/\\]/).pop())))
			)
		),
		...mediaUrls.map((item, idx) =>
			h('div', {
				key: 'img-' + idx,
				className: 'agy-tv-img-preview-box',
				onClick: (e: { stopPropagation: () => void }) => {
					e.stopPropagation();
					openLightbox(item.url, prompt || name, item.path);
				},
				title: translateOr('image.lightboxHint', 'Click to open lightbox')
			},
				h('img', {
					className: 'agy-tv-img-thumb',
					src: item.url,
					alt: prompt || name,
					loading: 'lazy',
				})
			)
		),
		...(mediaUrls.length === 0 && model.output
			? [h('pre', { key: 'out', className: 'agy-tv-card-content' }, model.output)]
			: [])
	);
}

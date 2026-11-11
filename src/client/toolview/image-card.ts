// Image-generation card body (thumbnail + lightbox).

import { buildMediaUrl, openLightbox } from '../images.ts';
import { hx } from './runtime.ts';
import type { MirrorCardModel } from './types.ts';

export function ImageCardBody({ model }: { model: MirrorCardModel }): unknown {
	const h = hx;
	const prompt = model.prompt || '';
	const name = model.imageName || 'image';
	const ratio = model.aspectRatio || '1:1';
	const path = model.imagePath || model.path || '';
	const mediaUrl = path ? buildMediaUrl(path) : null;

	return h('div', { className: 'agy-tv-img-wrap' },
		h('div', { className: 'agy-tv-img-meta' },
			h('div', { className: 'agy-tv-img-prompt', title: prompt || name }, prompt ? `"${prompt}"` : name),
			h('div', { className: 'agy-tv-img-badges' },
				h('span', { className: 'agy-tv-img-badge' }, ratio),
				...(path ? [h('span', { key: 'path', className: 'agy-tv-img-badge', title: path }, path.split(/[/\\]/).pop())] : [])
			)
		),
		mediaUrl ? h('div', {
			className: 'agy-tv-img-preview-box',
			onClick: (e: { stopPropagation: () => void }) => {
				e.stopPropagation();
				openLightbox(mediaUrl, prompt || name, path);
			},
			title: '点击放大预览 / Click to open lightbox'
		},
			h('img', {
				className: 'agy-tv-img-thumb',
				src: mediaUrl,
				alt: prompt || name,
				loading: 'lazy',
			})
		) : null
	);
}

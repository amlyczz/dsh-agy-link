// Interactive ask_question card body.

import { insertTextIntoChatComposer } from '../decisions.ts';
import { cls } from './format.ts';
import { hx, react } from './runtime.ts';
import type { MirrorCardModel } from './types.ts';

export function QuestionCardBody({ model }: { model: MirrorCardModel }): unknown {
	const h = hx;
	const questions = model.questions ?? [];
	const [selectedMap, setSelectedMap] = react().useState<Record<number, Set<string>>>({});
	const [inserted, setInserted] = react().useState(false);

	const toggleOption = (qIdx: number, opt: string, isMulti?: boolean) => {
		setSelectedMap((prev) => {
			const next = { ...prev };
			const current = new Set(next[qIdx] ?? []);
			if (isMulti) {
				if (current.has(opt)) current.delete(opt);
				else current.add(opt);
			} else {
				current.clear();
				current.add(opt);
			}
			next[qIdx] = current;
			return next;
		});
	};

	const onInsert = () => {
		const parts: string[] = [];
		for (let i = 0; i < questions.length; i++) {
			const sel = Array.from(selectedMap[i] ?? []);
			if (sel.length > 0) {
				parts.push(sel.join('; '));
			}
		}
		if (parts.length > 0) {
			const text = parts.join('\n');
			insertTextIntoChatComposer(text);
			setInserted(true);
			setTimeout(() => setInserted(false), 1500);
		}
	};

	const qNodes: unknown[] = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		if (!q) continue;
		const options = q.options ?? [];
		const isMulti = q.is_multi_select === true;
		const sel = selectedMap[i] ?? new Set();

		const optNodes = options.map((opt, oIdx) => {
			const isChecked = sel.has(opt);
			return h('button', {
				key: 'opt-' + oIdx,
				type: 'button',
				className: cls('agy-tv-q-opt', isChecked && 'selected'),
				onClick: (e: { stopPropagation: () => void }) => {
					e.stopPropagation();
					toggleOption(i, opt, isMulti);
				},
			},
				h('span', { className: cls('agy-tv-q-check', isMulti ? 'checkbox' : 'radio', isChecked && 'checked') }),
				h('span', { className: 'agy-tv-q-opt-text' }, opt)
			);
		});

		qNodes.push(h('div', { key: 'q-' + i, className: 'agy-tv-q-item' },
			h('div', { className: 'agy-tv-q-prompt' }, q.question || 'Please select:'),
			h('div', { className: 'agy-tv-q-opts' }, ...optNodes)
		));
	}

	const hasSelection = Object.values(selectedMap).some((s) => s.size > 0);

	return h('div', { className: 'agy-tv-question-wrap' },
		...qNodes,
		h('div', { className: 'agy-tv-q-footer' },
			h('button', {
				type: 'button',
				className: cls('agy-tv-q-insert-btn', hasSelection && 'active'),
				disabled: !hasSelection,
				onClick: (e: { stopPropagation: () => void }) => {
					e.stopPropagation();
					onInsert();
				},
			},
				inserted ? '✓ 已填入对话框' : '💬 填入对话框 / Insert into Chat'
			),
			model.output ? h('div', { className: 'agy-tv-q-answered' }, `已记录: ${model.output}`) : null
		)
	);
}

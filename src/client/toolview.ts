// Native tool-card toolview for the agy_tool mirror (DSH >= 0.1.5).
//
// Matches the official DSH tool row and card presentation:
// - Collapsed state: clean, borderless 24px row with official tool SVG icon,
//   tool title, separator dot, and summary/preview.
// - Mouse hover on small icon: smoothly transitions to the chevron down arrow.
// - Expanded state: leading icon is the chevron down arrow.
// - Expanded card: rounded 12px card with header (prompt/cwd/path + Copy button)
//   and scrollable content (max-height with custom scrollbars) for long outputs.

type ReactApi = {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
	useState: <S>(initial: S) => [S, (next: S | ((prev: S) => S)) => void];
};

function react(): ReactApi {
	const mod = require('react') as unknown;
	if (mod === undefined || mod === null) {
		throw new Error('dsh-agy-link toolview requires react at render time (browser host)');
	}
	return mod as ReactApi;
}

export function makeToggle(setValue: (next: boolean | ((prev: boolean) => boolean)) => void): () => void {
	return () => setValue((prev: boolean) => !prev);
}

export function useToggle(initial: boolean = false): [boolean, () => void] {
	const R2 = react();
	const [value, setValue] = R2.useState(initial) as [boolean, (next: boolean | ((prev: boolean) => boolean)) => void];
	return [value, makeToggle(setValue)];
}

function hx(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown {
	return react().createElement(type, props, ...children);
}

// ---- Official DSH SVGs (100% faithful to native DSH client-ui) ----------

export function IconChevronDownOutline14(size = 14, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 14 14',
		fill: 'none',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	}, hx('path', {
		d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
		fill: 'currentColor',
	}));
}

export function IconApiOutline14(size = 14, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 14 14',
		fill: 'none',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	},
		hx('path', {
			transform: 'translate(0.6689 1.073)',
			d: 'M11.4818 5.57813C11.4818 4.45301 11.4807 3.66237 11.4075 3.05908C11.3359 2.46953 11.2024 2.13852 10.9939 1.89441C10.9247 1.81341 10.8493 1.73801 10.7683 1.66882C10.5242 1.46033 10.1932 1.32686 9.60364 1.25525C9.00034 1.18198 8.20974 1.18091 7.0846 1.18091L5.57813 1.18091C4.45301 1.18091 3.66238 1.18198 3.05908 1.25525C2.46953 1.32686 2.13852 1.46033 1.89441 1.66882C1.81341 1.73801 1.73801 1.81341 1.66882 1.89441C1.46033 2.13852 1.32686 2.46953 1.25525 3.05908C1.18198 3.66238 1.18091 4.45301 1.18091 5.57813L1.18091 6.2771C1.18091 7.40218 1.18197 8.19288 1.25525 8.79614C1.32687 9.38553 1.46036 9.71674 1.66882 9.96082C1.73797 10.0417 1.81347 10.1173 1.89441 10.1864C2.13851 10.3948 2.46965 10.5275 3.05908 10.5991C3.66238 10.6724 4.45298 10.6735 5.57813 10.6735L7.0846 10.6735C8.20977 10.6735 9.00033 10.6724 9.60364 10.5991C10.1931 10.5275 10.5242 10.3948 10.7683 10.1864C10.8493 10.1173 10.9247 10.0417 10.9939 9.96082C11.2024 9.71674 11.3358 9.38553 11.4075 8.79614C11.4808 8.19288 11.4818 7.40218 11.4818 6.2771L11.4818 5.57813ZM12.6627 6.2771C12.6627 7.37222 12.6637 8.247 12.5798 8.93799C12.4942 9.64284 12.3133 10.2359 11.8928 10.7282C11.7834 10.8562 11.6637 10.9751 11.5356 11.0845C11.0434 11.5049 10.4511 11.6867 9.74634 11.7723C9.05525 11.8563 8.17999 11.8552 7.0846 11.8552L5.57813 11.8552C4.48273 11.8552 3.60747 11.8563 2.91638 11.7723C2.21157 11.6867 1.61933 11.5049 1.12708 11.0845C0.99901 10.9751 0.879281 10.8562 0.769898 10.7282C0.349454 10.2359 0.168506 9.64284 0.0828864 8.93799C-0.00101964 8.247 4.88512e-07 7.37222 6.47206e-07 6.2771L6.47206e-07 5.57813C6.47206e-07 4.48273 -0.00106163 3.60747 0.0828864 2.91638C0.168502 2.21168 0.349594 1.61928 0.769898 1.12708C0.879302 0.998981 0.998981 0.879302 1.12708 0.769898C1.61928 0.349594 2.21168 0.168502 2.91638 0.0828864C3.60747 -0.00106163 4.48273 6.47206e-07 5.57813 6.47206e-07L7.0846 6.47206e-07C8.17999 6.47206e-07 9.05525 -0.00106163 9.74634 0.0828864C10.451 0.168505 11.0434 0.349587 11.5356 0.769898C11.6637 0.879302 11.7834 0.998981 11.8928 1.12708C12.3131 1.61928 12.4942 2.21169 12.5798 2.91638C12.6638 3.60747 12.6627 4.48273 12.6627 5.57813L12.6627 6.2771Z',
			fill: 'currentColor',
		}),
		hx('path', {
			transform: 'translate(0.6689 1.073)',
			d: 'M6.02607 5.50955L6.44306 5.9274L3.84284 8.52762L3.425 8.11063L3.00715 7.69278L4.77253 5.9274L3.00715 4.16202L3.84284 3.32633L6.02607 5.50955Z',
			fill: 'currentColor',
		}),
		hx('path', {
			transform: 'translate(0.6689 1.073)',
			d: 'M9.23789 7.35397L9.23789 8.53488L6.96238 8.53488L6.96238 7.35397L9.23789 7.35397Z',
			fill: 'currentColor',
		}),
	);
}

export function IconEditOutline16(size = 14, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 16 16',
		fill: 'none',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	}, hx('path', {
		d: 'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z',
		fill: 'currentColor',
	}));
}

export function IconBrowseOutline16(size = 14, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 16 16',
		fill: 'none',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	},
		hx('path', { d: 'M11.2426 4.80473V6.10551H4.75819V4.80473H11.2426Z', fill: 'currentColor' }),
		hx('path', { d: 'M9.40858 7.84478V9.14557H4.75819V7.84478H9.40858Z', fill: 'currentColor' }),
		hx('path', {
			d: 'M9.23438 0.546389C10.1941 0.546389 10.9683 0.544914 11.5859 0.611819C12.2161 0.680096 12.7634 0.825745 13.2393 1.17139C13.5172 1.3733 13.7619 1.61812 13.9639 1.896C14.3096 2.37183 14.4551 2.91922 14.5234 3.54932C14.5903 4.16686 14.5889 4.94133 14.5889 5.90088V10.0981C14.5889 11.0576 14.5903 11.8321 14.5234 12.4497C14.4552 13.0798 14.3094 13.6272 13.9639 14.103C13.7619 14.381 13.5172 14.6257 13.2393 14.8276C12.7633 15.1734 12.2163 15.3189 11.5859 15.3872C10.9683 15.4541 10.1942 15.4536 9.23438 15.4536H6.76563C5.80591 15.4536 5.03168 15.4541 4.41407 15.3872C3.78385 15.3189 3.23665 15.1734 2.76074 14.8276C2.48291 14.6257 2.23802 14.3809 2.03614 14.103C1.69066 13.6272 1.54483 13.0798 1.47657 12.4497C1.40973 11.8321 1.41114 11.0576 1.41114 10.0981V5.90088C1.41113 4.94132 1.40966 4.16686 1.47657 3.54932C1.54488 2.91921 1.69042 2.37184 2.03614 1.896C2.2381 1.61807 2.4828 1.37333 2.76074 1.17139C3.23665 0.825682 3.78386 0.680109 4.41407 0.611819C5.03168 0.544905 5.80591 0.546389 6.76563 0.546389H9.23438ZM6.76563 1.896C5.77586 1.896 5.0876 1.89738 4.55957 1.95459C4.0443 2.01043 3.76214 2.11349 3.55469 2.26416C3.39135 2.38284 3.24761 2.52662 3.12891 2.68994C2.97821 2.89736 2.8752 3.17967 2.81934 3.69483C2.76214 4.22279 2.76075 4.91131 2.76074 5.90088V10.0981C2.76074 11.0876 2.76221 11.7762 2.81934 12.3042C2.87516 12.8194 2.97829 13.1026 3.12891 13.3101C3.24754 13.4733 3.39147 13.6172 3.55469 13.7358C3.76213 13.8865 4.04438 13.9896 4.55957 14.0454C5.0876 14.1026 5.77586 14.103 6.76563 14.103H9.23438C10.2242 14.103 10.9124 14.1026 11.4404 14.0454C11.9556 13.9896 12.2379 13.8865 12.4453 13.7358C12.6086 13.6172 12.7525 13.4733 12.8711 13.3101C13.0217 13.1026 13.1248 12.8195 13.1807 12.3042C13.2378 11.7762 13.2393 11.0876 13.2393 10.0981V5.90088C13.2393 4.91131 13.2379 4.22279 13.1807 3.69483C13.1248 3.17969 13.0218 2.89736 12.8711 2.68994C12.7524 2.52667 12.6086 2.38281 12.4453 2.26416C12.2379 2.11355 11.9556 2.01041 11.4404 1.95459C10.9124 1.8974 10.2241 1.896 9.23438 1.896H6.76563Z',
			fill: 'currentColor',
		}),
	);
}

export function IconSearchOutline16(size = 14, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 16 16',
		fill: 'none',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	},
		hx('path', {
			d: 'M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z',
			fill: 'currentColor',
		}),
		hx('path', {
			d: 'M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z',
			fill: 'currentColor',
		}),
	);
}

export function IconCodeOutline16(size = 14, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 16 16',
		fill: 'none',
		style: { display: 'block', flexShrink: 0 },
		'aria-hidden': true,
	}, hx('path', {
		fillRule: 'evenodd',
		clipRule: 'evenodd',
		d: 'M12.3368 1.53569L11.931 4.43172H14.8086V5.79673H11.7404L11.1962 9.67859H14.2839V11.0436H11.0056L10.4994 14.6529L9.14873 14.4643L9.62731 11.0436H5.75876L5.25252 14.6529L3.90186 14.4643L4.38043 11.0436H1.69141V9.67859H4.57104L5.11417 5.79673H2.21609V4.43172H5.30581L5.73724 1.34713L7.08995 1.53569L6.68414 4.43172H10.5527L10.9841 1.34713L12.3368 1.53569ZM5.94937 9.67859H9.81791L10.361 5.79673H6.49353L5.94937 9.67859Z',
		fill: 'currentColor',
	}));
}

export function IconInspectOutline12(size = 12, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 16 16',
		fill: 'none',
		style: { display: 'inline-block', verticalAlign: '-1.5px', flexShrink: 0 },
		'aria-hidden': true,
	}, hx('path', {
		d: 'M16 8L10.8571 12V10.552L14.1383 8L10.8571 5.448V4L16 8ZM5.14286 10.552L1.86171 8L5.14286 5.448V4L0 8L5.14286 12V10.552ZM9.02514 4L5.59657 12H6.84057L10.2691 4H9.02514Z',
		fill: 'currentColor',
	}));
}

export function IconCopyOutline16(size = 12, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 16 16',
		fill: 'none',
		style: { display: 'inline-block', verticalAlign: '-1.5px', flexShrink: 0 },
		'aria-hidden': true,
	}, hx('path', {
		d: 'M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909',
		fill: 'currentColor',
	}));
}

export function IconCheckOutline14(size = 12, className = ''): unknown {
	return hx('svg', {
		width: size,
		height: size,
		className: className || undefined,
		viewBox: '0 0 14 14',
		fill: 'none',
		style: { display: 'inline-block', verticalAlign: '-1.5px', flexShrink: 0 },
		'aria-hidden': true,
	}, hx('path', {
		d: 'M11.5635 4.58984L7.61426 9.07715C7.35154 9.37561 7.11346 9.64812 6.89453 9.84668C6.66593 10.054 6.38519 10.2506 6.01465 10.3164C5.82079 10.3508 5.62207 10.3529 5.42773 10.3213C5.0561 10.2609 4.77266 10.0674 4.54102 9.86328C4.31926 9.66791 4.07752 9.39911 3.81055 9.10449L2.44531 7.59863L3.55664 6.59082L4.92188 8.09766C5.21256 8.41844 5.38878 8.61191 5.53223 8.73828C5.61022 8.80699 5.65253 8.83192 5.66895 8.83984C5.69648 8.84429 5.72449 8.84467 5.75195 8.83984C5.72657 8.84451 5.75564 8.85422 5.88672 8.73535C6.02833 8.60692 6.20225 8.41088 6.48828 8.08594L10.4385 3.59961L11.5635 4.58984Z',
		fill: 'currentColor',
	}));
}

function toolIconFor(kind: CardKind, size = 14): unknown {
	switch (kind) {
		case 'terminal':
			return IconApiOutline14(size);
		case 'diff':
		case 'delete':
			return IconEditOutline16(size);
		case 'read':
			return IconBrowseOutline16(size);
		case 'search':
		case 'list':
			return IconSearchOutline16(size);
		default:
			return IconCodeOutline16(size);
	}
}

// ---- Structural types -----------------------------------------------------

type ToolResultBlock = {
	call: { name: string; argsRaw: string } | null;
	content: readonly { type?: string; text?: string }[];
	isError: boolean;
	error?: { name?: string; code?: string };
	parentCallId?: string;
	subCalls?: readonly unknown[];
};

type RunningCallBlock = {
	name: string;
	argsRaw: string;
	parentCallId?: string;
	subCalls?: readonly unknown[];
	call?: { name: string; argsRaw: string };
};

export type ToolBlock = (ToolResultBlock | RunningCallBlock) & { kind?: string };

export interface AgyToolViewProps {
	callId: string;
	toolName: string;
	block: ToolBlock;
	cwd?: string;
	home?: string;
	openFile?: (path: string, opts?: unknown) => void;
	inspect?: () => void;
	loadImage?: unknown;
}

// ---- argument parsing -----------------------------------------------------

function parsedArgsRaw(block: ToolBlock): string {
	const settled = block as ToolResultBlock;
	if ('call' in settled && settled.call !== null && typeof settled.call.argsRaw === 'string') {
		return settled.call.argsRaw;
	}
	const running = block as RunningCallBlock;
	if (typeof running.argsRaw === 'string') return running.argsRaw;
	return '';
}

function parseArgs(block: ToolBlock): Record<string, unknown> | null {
	const raw = parsedArgsRaw(block);
	if (raw === '') return null;
	try {
		const v = JSON.parse(raw) as unknown;
		return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function mirrorInfo(block: ToolBlock): { tool: string; input: Record<string, unknown> } | null {
	const a = parseArgs(block);
	if (a === null) return null;
	const tool = typeof a.tool === 'string' ? a.tool : '';
	if (tool === '') return null;
	let input: Record<string, unknown> = {};
	const raw = a.input;
	if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) input = raw as Record<string, unknown>;
	else if (typeof raw === 'string') {
		try {
			const p = JSON.parse(raw) as unknown;
			if (typeof p === 'object' && p !== null && !Array.isArray(p)) input = p as Record<string, unknown>;
			else input = { value: raw };
		} catch {
			input = { value: raw };
		}
	}
	return { tool, input };
}

function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === 'string' && v !== '') return v;
	}
	return undefined;
}

function num(input: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
	}
	return undefined;
}

function resultText(block: ToolBlock): string {
	const settled = block as ToolResultBlock;
	if (!Array.isArray(settled.content)) return '';
	const parts: string[] = [];
	for (const b of settled.content) {
		if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
			parts.push((b as { text: string }).text);
		}
	}
	return parts.join('\n');
}

function isSettled(block: ToolBlock): boolean {
	return block.kind === 'tool-result' || 'content' in block;
}

function isError(block: ToolBlock): boolean {
	const settled = block as ToolResultBlock;
	return settled.isError === true || (settled.error !== undefined && settled.error !== null);
}

// ---- Card classification --------------------------------------------------

const TERMINAL_TOOLS = new Set(['run_command', 'bash', 'execute_command']);
const DIFF_TOOLS = new Set(['replace_file_content', 'edit_file', 'replace_in_file', 'edit', 'write_to_file', 'write_file', 'create_file']);
const READ_TOOLS = new Set(['read_file', 'view_file', 'read', 'open_file']);
const SEARCH_TOOLS = new Set(['find_by_name', 'glob', 'search_files', 'grep_search', 'search', 'search_file_content', 'grep']);
const LIST_TOOLS = new Set(['list_dir', 'ls']);
const DELETE_TOOLS = new Set(['delete_file', 'remove_file', 'rm']);

export type CardKind = 'terminal' | 'diff' | 'read' | 'search' | 'list' | 'delete' | 'generic';

export interface MirrorCardModel {
	kind: CardKind;
	tool?: string;
	title: string;
	command?: string;
	cwd?: string;
	output?: string;
	path?: string;
	oldText?: string | null;
	newText?: string;
	location?: { path: string; line?: number };
	raw?: string;
}

export function mirrorCardModel(block: ToolBlock, cwd?: string, home?: string): MirrorCardModel {
	const info = mirrorInfo(block);
	const out = resultText(block);
	if (info === null) {
		return { kind: 'generic', title: 'agy_tool', output: out, raw: parsedArgsRaw(block) };
	}
	const { tool, input } = info;
	const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary', 'Instruction', 'instruction');

	if (TERMINAL_TOOLS.has(tool)) {
		const command = pick(input, 'CommandLine', 'command_line', 'command', 'cmd', 'Cmd') ?? JSON.stringify(input);
		const cwdVal = pick(input, 'Cwd', 'cwd', 'WorkingDirectory', 'working_directory') ?? cwd;
		return {
			kind: 'terminal',
			tool,
			title: desc !== undefined ? desc + ' · ' + command : command,
			command,
			...(cwdVal !== undefined ? { cwd: cwdVal } : {}),
			output: out,
		};
	}
	if (DIFF_TOOLS.has(tool)) {
		const rawPath = pick(input, 'TargetFile', 'target_file', 'path', 'file_path', 'Path', 'FilePath', 'AbsolutePath', 'targetFile', 'filename', 'FileName') ?? 'file';
		const path = relativize(rawPath, cwd, home);
		const oldText = pick(input, 'TargetContent', 'target_content', 'old_string', 'oldText', 'OldString', 'OldText', 'targetContent') ?? null;
		const newText = pick(input, 'ReplacementContent', 'replacement_content', 'new_string', 'newText', 'content', 'NewString', 'NewText', 'Content', 'replacementContent', 'CodeContent', 'code_content', 'contents', 'FileContents', 'codeContent') ?? '';
		const action = (tool === 'write_to_file' || tool === 'write_file' || tool === 'create_file') ? 'Write' : 'Edit';
		const isGenericDesc = desc !== undefined && /^(file edit|editing file|write file|writing file|file write|edit file|editing|writing|file create|creating file)$/i.test(desc.trim());
		const title = desc !== undefined && !isGenericDesc && !desc.includes(path)
			? `${action} ${path} · ${desc}`
			: `${action} ${path}`;
		return { kind: 'diff', tool, title, path: rawPath, oldText, newText, output: out };
	}
	if (READ_TOOLS.has(tool)) {
		const path = pick(input, 'AbsolutePath', 'absolute_path', 'TargetFile', 'target_file', 'path', 'file_path', 'filename', 'Path', 'FilePath', 'FileName', 'targetFile') ?? '';
		const offset = num(input, 'offset', 'Offset') ?? num(input, 'StartLine', 'start_line');
		const line = offset !== undefined ? (offset > 0 && (tool === 'view_file' || tool === 'read_file') ? offset : offset + 1) : undefined;
		return {
			kind: 'read',
			tool,
			title: desc ? `${desc} · ${path}` : path !== '' ? 'Read ' + path : 'Read',
			path,
			output: out,
			...(path !== '' ? { location: { path, ...(line !== undefined ? { line } : {}) } } : {}),
		};
	}
	if (SEARCH_TOOLS.has(tool)) {
		const q = pick(input, 'query', 'Query', 'pattern', 'Pattern', 'regex', 'Regex', 'QueryString') ?? '';
		return { kind: 'search', tool, title: desc ?? (q !== '' ? 'Search ' + q : 'Search'), output: out };
	}
	if (LIST_TOOLS.has(tool)) {
		const path = pick(input, 'DirectoryPath', 'directory_path', 'path', 'directory', 'Path', 'Directory', 'SearchDirectory', 'search_directory', 'AbsolutePath') ?? '';
		return { kind: 'list', tool, title: desc ?? (path !== '' ? 'List ' + path : 'List directory'), output: out };
	}
	if (DELETE_TOOLS.has(tool)) {
		const path = pick(input, 'TargetFile', 'target_file', 'path', 'file_path', 'Path', 'FilePath', 'AbsolutePath') ?? '';
		return { kind: 'delete', tool, title: desc ?? 'Delete ' + path, output: out };
	}
	const title = desc ?? (tool !== '' ? tool : 'agy_tool');
	return { kind: 'generic', tool, title, output: out, raw: parsedArgsRaw(block) };
}

// ---- Helpers --------------------------------------------------------------

function relativize(p: string, cwd?: string, home?: string): string {
	if (cwd && p.startsWith(cwd)) {
		const rel = p.slice(cwd.length).replace(/^[/\\]+/, '');
		return rel !== '' ? rel : p;
	}
	if (home && p.startsWith(home)) return '~' + p.slice(home.length);
	return p;
}

function clip(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + '\n… (+' + (s.length - max) + ' chars)' : s;
}

export function trimTrailingBlankLines(s: string): string {
	return s.replace(/[\t ]*\r?\n[\t ]*(\r?\n[\t ]*)*$/, '\n');
}

export function previewLine(model: MirrorCardModel, cwd?: string, home?: string): string | undefined {
	if (model.kind === 'diff') {
		const raw = model.path ?? 'file';
		const rel = relativize(raw, cwd, home);
		const display = rel.length > 40 ? '…' + rel.slice(-40) : rel;
		return model.oldText != null ? `± ${display}` : `+ ${display}`;
	}
	const out = model.output;
	if (out !== undefined && out !== '') {
		const first = out.split('\n').find((l) => l.trim() !== '');
		if (first !== undefined && first.trim() !== '') return first.trim().slice(0, 80);
	}
	return undefined;
}

function cls(...names: Array<string | false | null | undefined>): string {
	return names.filter((n): n is string => typeof n === 'string' && n !== '').join(' ');
}

function displayTitle(model: MirrorCardModel): string {
	switch (model.kind) {
		case 'terminal':
			return 'Command';
		case 'diff':
			return (model.tool === 'write_to_file' || model.tool === 'write_file' || model.tool === 'create_file') ? 'Write' : 'Edit';
		case 'read':
			return 'Read';
		case 'search':
			return 'Search';
		case 'list':
			return 'List';
		case 'delete':
			return 'Delete';
		default:
			return model.tool ? model.tool.replace(/_/g, ' ') : 'Tool';
	}
}

function displaySummary(model: MirrorCardModel, cwd?: string, home?: string): string {
	if (model.kind === 'terminal') {
		return model.command ?? model.title;
	}
	if (model.kind === 'diff') {
		const rawPath = model.path ?? 'file';
		return relativize(rawPath, cwd, home);
	}
	if (model.kind === 'read') {
		const rawPath = model.path ?? '';
		return rawPath !== '' ? relativize(rawPath, cwd, home) : model.title;
	}
	if (model.kind === 'search') {
		return model.title.replace(/^Search\s*/i, '') || model.title;
	}
	if (model.kind === 'list') {
		return model.title.replace(/^List\s*(directory\s*)?/i, '') || model.title;
	}
	return model.title;
}

function diffStat(model: MirrorCardModel): string | null {
	if (model.kind !== 'diff') return null;
	const oldText = model.oldText ?? '';
	const newText = model.newText ?? '';
	const oldLines = oldText === '' ? 0 : oldText.split('\n').length;
	const newLines = newText === '' ? 0 : newText.split('\n').length;
	if (oldLines === 0 && newLines === 0) return null;
	if (oldLines === 0) return `+${newLines}`;
	return `+${newLines} -${oldLines}`;
}

// ---- Copy button component ------------------------------------------------

function CopyButton({ text }: { text: string }): unknown {
	const [copied, setCopied] = react().useState(false);
	const onCopy = (e: { stopPropagation: () => void }) => {
		e.stopPropagation();
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(text).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}).catch(() => {});
		}
	};
	return hx('button', {
		type: 'button',
		className: 'agy-tv-copy-btn',
		onClick: onCopy,
		title: copied ? '已复制' : '复制内容',
	},
		copied ? IconCheckOutline14(11) : IconCopyOutline16(11),
		hx('span', null, copied ? '已复制' : '复制')
	);
}

// ---- Diff body renderer ---------------------------------------------------

function DiffBody({ model }: { model: MirrorCardModel; openFile?: (p: string, o?: unknown) => void; cwd?: string; home?: string }): unknown {
	const h = hx;
	const oldText = model.oldText ?? '';
	const newText = model.newText ?? '';
	const rows: unknown[] = [];
	if (oldText !== '') {
		const lines = oldText.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			rows.push(h('div', { key: 'del-' + i, className: 'agy-tv-diff-line agy-tv-diff-del' },
				h('span', { className: 'agy-tv-diff-marker' }, '-'),
				h('span', { style: { flex: 1 } }, line === '' ? ' ' : line)
			));
		}
	}
	if (newText !== '') {
		const lines = newText.split('\n');
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			rows.push(h('div', { key: 'add-' + i, className: 'agy-tv-diff-line agy-tv-diff-add' },
				h('span', { className: 'agy-tv-diff-marker' }, '+'),
				h('span', { style: { flex: 1 } }, line === '' ? ' ' : line)
			));
		}
	}
	if (rows.length === 0) {
		rows.push(h('div', { key: 'empty', className: 'agy-tv-diff-line', style: { color: 'var(--dsw-alias-label-tertiary)' } }, '(no textual changes)'));
	}
	return h('div', { className: 'agy-tv-diff-list' }, ...rows);
}

// ---- Card body renderer ---------------------------------------------------

function CardBody({ model, openFile, cwd, home, inspect }: {
	model: MirrorCardModel;
	openFile?: (p: string, o?: unknown) => void;
	cwd?: string;
	home?: string;
	inspect?: () => void;
}): unknown {
	const h = hx;
	const inspectNode = inspect !== undefined
		? h('div', { key: 'ins', style: { padding: '4px 8px 6px' } },
			h('button', {
				type: 'button',
				className: 'agy-tv-inspect-btn',
				onClick: inspect,
			}, IconInspectOutline12(12), '检查')
		)
		: null;

	switch (model.kind) {
		case 'terminal': {
			const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : '(no output)';
			const copyText = model.output !== undefined && model.output !== '' ? model.output : (model.command ?? '');
			return h('div', { className: 'agy-tv-card' },
				h('div', { className: 'agy-tv-card-header' },
					h('div', { className: 'agy-tv-card-header-left' },
						h('span', { className: 'agy-tv-prompt-glyph' }, '❯'),
						...(model.cwd ? [h('span', { key: 'cwd', className: 'agy-tv-card-cwd' }, model.cwd)] : []),
						h('span', { className: 'agy-tv-card-cmd', title: model.command }, model.command ?? '')
					),
					h(CopyButton, { text: copyText })
				),
				h('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)),
				inspectNode
			);
		}
		case 'diff': {
			const path = model.path ?? 'file';
			const pathLabel = relativize(path, cwd, home);
			const stat = diffStat(model);
			const copyText = model.newText ?? '';
			return h('div', { className: 'agy-tv-card' },
				h('div', { className: 'agy-tv-card-header' },
					h('div', { className: 'agy-tv-card-header-left' },
						IconEditOutline16(13),
						h('span', { className: 'agy-tv-card-path' }, pathLabel),
						...(stat ? [h('span', { key: 's', className: 'agy-tv-diff-stat' }, stat)] : [])
					),
					h(CopyButton, { text: copyText })
				),
				h(DiffBody, { model, openFile, cwd, home }),
				inspectNode
			);
		}
		case 'read': {
			const path = model.path ?? 'file';
			const pathLabel = relativize(path, cwd, home);
			const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : '(no output)';
			return h('div', { className: 'agy-tv-card' },
				h('div', { className: 'agy-tv-card-header' },
					h('div', { className: 'agy-tv-card-header-left' },
						IconBrowseOutline16(13),
						h('span', { className: 'agy-tv-card-path' }, pathLabel)
					),
					h(CopyButton, { text: model.output ?? '' })
				),
				h('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)),
				inspectNode
			);
		}
		case 'search': {
			const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : '(no matches)';
			return h('div', { className: 'agy-tv-card' },
				h('div', { className: 'agy-tv-card-header' },
					h('div', { className: 'agy-tv-card-header-left' },
						IconSearchOutline16(13),
						h('span', { className: 'agy-tv-card-path' }, model.title)
					),
					h(CopyButton, { text: model.output ?? '' })
				),
				h('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)),
				inspectNode
			);
		}
		case 'list': {
			const rawBody = model.output !== undefined && model.output !== '' ? trimTrailingBlankLines(model.output) : '(empty directory)';
			return h('div', { className: 'agy-tv-card' },
				h('div', { className: 'agy-tv-card-header' },
					h('div', { className: 'agy-tv-card-header-left' },
						IconBrowseOutline16(13),
						h('span', { className: 'agy-tv-card-path' }, model.title)
					),
					h(CopyButton, { text: model.output ?? '' })
				),
				h('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)),
				inspectNode
			);
		}
		default: {
			const copyText = model.output !== undefined && model.output !== '' ? model.output : (model.raw ?? '');
			const rawBody = model.output !== undefined && model.output !== ''
				? trimTrailingBlankLines(model.output)
				: (model.raw !== undefined && model.raw !== '' ? clip(model.raw, 4000) : '(no detail)');
			return h('div', { className: 'agy-tv-card' },
				h('div', { className: 'agy-tv-card-header' },
					h('div', { className: 'agy-tv-card-header-left' },
						IconCodeOutline16(13),
						h('span', { className: 'agy-tv-card-path' }, model.tool || 'Tool')
					),
					h(CopyButton, { text: copyText })
				),
				h('pre', { className: 'agy-tv-card-content' }, clip(rawBody, 16000)),
				inspectNode
			);
		}
	}
}

// ---- Main ToolView Component ----------------------------------------------

export function AgyMirrorToolView(props: AgyToolViewProps): unknown {
	const [open, setOpen] = useToggle(false);
	const h = hx;
	const { block, cwd, home, openFile, inspect } = props;
	const settle = isSettled(block);
	const err = isError(block);
	const model = mirrorCardModel(block, cwd, home);
	const state: 'ok' | 'err' | 'run' = !settle ? 'run' : err ? 'err' : 'ok';
	const title = displayTitle(model);
	const summary = displaySummary(model, cwd, home);
	const stat = diffStat(model);
	const preview = !open && model.kind !== 'diff' ? previewLine(model, cwd, home) : undefined;
	const hasFileLink = (model.kind === 'diff' || model.kind === 'read') && model.path && openFile !== undefined;

	const onFileClick = (e: { stopPropagation: () => void }) => {
		e.stopPropagation();
		if (model.path && openFile) {
			if (model.location?.line !== undefined) openFile(model.path, { line: model.location.line });
			else openFile(model.path);
		}
	};

	const leading = open
		? h('span', { className: 'agy-tv-chevron-open' }, IconChevronDownOutline14(14))
		: h('span', { className: 'agy-tv-leading' },
			h('span', { className: 'agy-tv-icon-idle' }, toolIconFor(model.kind, 14)),
			h('span', { className: 'agy-tv-chevron-hover' }, IconChevronDownOutline14(14)),
		);

	const summaryNode = hasFileLink
		? h('button', {
			type: 'button',
			className: 'agy-tv-file-link',
			onClick: onFileClick,
			title: model.path,
		}, summary)
		: h('span', {
			className: cls('agy-tv-summary', err && 'agy-tv-summary-err'),
			title: summary,
		}, summary);

	const header = h('div', {
		className: 'agy-tv-row',
		role: 'button',
		tabIndex: 0,
		'aria-expanded': open,
		onClick: (e: { stopPropagation: () => void }) => {
			e.stopPropagation();
			setOpen();
		},
		onKeyDown: (e: { key: string; preventDefault: () => void }) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				setOpen();
			}
		},
		title: inspect !== undefined
			? (open ? 'Click to collapse · right-click to inspect' : 'Click to expand · right-click to inspect')
			: (open ? 'Click to collapse' : 'Click to expand'),
		onContextMenu: inspect !== undefined ? (e: { preventDefault: () => void }) => { e.preventDefault(); inspect(); } : undefined,
	},
		leading,
		h('span', { className: 'agy-tv-title' }, title),
		h('span', { className: 'agy-tv-sep', 'aria-hidden': true }),
		summaryNode,
		...(stat !== null ? [h('span', { key: 'stat', className: 'agy-tv-diff-stat' }, stat)] : []),
		...(preview !== undefined ? [h('span', { key: 'prev', className: 'agy-tv-preview', title: preview }, preview)] : []),
	);

	return h('div', {
		className: cls('agy-tv-root', open && 'agy-tv-open'),
		'data-state': state,
		'data-kind': model.kind,
	},
		header,
		...(open ? [h('div', { key: 'wrap', className: 'agy-tv-body-wrap' },
			h(CardBody, { model, openFile, cwd, home, inspect })
		)] : [])
	);
}

// ---- Register into DSH slots ----------------------------------------------

export function installAgyToolView(ctx: {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(opts: { name: string; key?: string; id: string; order?: number; label?: string | (() => string); locale?: string }, C: (p: unknown) => unknown): () => void;
	};
}): void {
	ctx.slots.inject('tool.call.toolview', () =>
		ctx.slots.register(
			{ name: 'tool.call.toolview', key: 'agy_tool', id: 'agy-tool-view', label: 'Antigravity tool' },
			AgyMirrorToolView as (p: unknown) => unknown,
		),
	);
}

// ---- Official CSS Styles --------------------------------------------------

const ROW_CSS = `
/* Container */
.agy-tv-root {
	display: flex;
	flex-direction: column;
	width: 100%;
	min-width: 0;
	position: relative;
	font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif);
	margin: 2px 0;
}

/* Collapsed Header Row */
.agy-tv-row {
	display: flex;
	align-items: center;
	height: calc(24px + var(--dsh-content-font-delta, 0px));
	min-width: 0;
	position: relative;
	overflow: hidden;
	cursor: pointer;
	user-select: none;
	background: transparent;
	border: none;
	padding: 0;
	width: 100%;
	text-align: left;
	color: var(--dsw-alias-label-primary, #0f172a);
}

/* Running sweep shimmer animation */
.agy-tv-root[data-state="run"] .agy-tv-row:after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 300px;
	background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 60%, transparent) 55%, transparent 100%);
	pointer-events: none;
	animation: 2.6s ease-out infinite agy-tv-sweep;
}
@keyframes agy-tv-sweep {
	0% { left: -300px; }
	90%, 100% { left: 100%; }
}

/* Leading Icon with Hover-to-Arrow transition */
.agy-tv-leading {
	position: relative;
	flex: none;
	width: calc(16px + var(--dsh-content-font-delta, 0px));
	height: calc(16px + var(--dsh-content-font-delta, 0px));
	display: inline-flex;
	align-items: center;
	justify-content: center;
	margin-right: 6px;
	color: var(--dsw-alias-label-tertiary, #64748b);
}
.agy-tv-leading svg {
	width: calc(14px + var(--dsh-content-font-delta, 0px));
	height: calc(14px + var(--dsh-content-font-delta, 0px));
}
.agy-tv-icon-idle {
	display: inline-flex;
	opacity: 1;
	transition: opacity 0.1s ease;
}
.agy-tv-chevron-hover {
	position: absolute;
	inset: 0;
	margin: auto;
	opacity: 0;
	transition: opacity 0.1s ease;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	color: var(--dsw-alias-label-secondary, #334155);
}
.agy-tv-row:hover .agy-tv-icon-idle {
	opacity: 0;
}
.agy-tv-row:hover .agy-tv-chevron-hover {
	opacity: 1;
}
.agy-tv-chevron-open {
	position: relative;
	flex: none;
	width: calc(16px + var(--dsh-content-font-delta, 0px));
	height: calc(16px + var(--dsh-content-font-delta, 0px));
	display: inline-flex;
	align-items: center;
	justify-content: center;
	margin-right: 6px;
	color: var(--dsw-alias-label-secondary, #334155);
}
.agy-tv-chevron-open svg {
	width: calc(14px + var(--dsh-content-font-delta, 0px));
	height: calc(14px + var(--dsh-content-font-delta, 0px));
}

/* Title */
.agy-tv-title {
	flex: none;
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(24px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-secondary, #334155);
	font-weight: 400;
}

/* Dot separator */
.agy-tv-sep {
	background: var(--dsw-alias-label-caption, #94a3b8);
	border-radius: 1px;
	flex: none;
	width: 2px;
	height: 2px;
	margin: 0 8px;
}

/* Summary */
.agy-tv-summary {
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(24px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-tertiary, #64748b);
	flex: auto;
	overflow: hidden;
}
.agy-tv-summary-err {
	color: var(--dsw-alias-state-error-primary, #dc2626);
}

/* File link button */
.agy-tv-file-link {
	text-overflow: ellipsis;
	white-space: nowrap;
	min-width: 0;
	font: inherit;
	text-align: left;
	font-size: var(--dsh-content-font-size-secondary, 13px);
	line-height: calc(24px + var(--dsh-content-font-delta, 0px));
	color: var(--dsw-alias-label-secondary, #334155);
	text-decoration: underline dotted;
	text-decoration-color: var(--dsw-alias-label-tertiary, #64748b);
	text-underline-offset: 3px;
	cursor: pointer;
	background: none;
	border: none;
	flex: 0 auto;
	margin: 0;
	padding: 0;
	text-decoration-thickness: 1px;
	overflow: hidden;
}
.agy-tv-file-link:hover {
	color: var(--dsw-alias-label-primary, #0f172a);
	text-decoration-color: currentColor;
}

/* Diff stat badge (+10 -2) */
.agy-tv-diff-stat {
	font-family: var(--dsw-font-family-code, ui-monospace, monospace);
	font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 2px);
	color: var(--dsw-alias-label-caption, #94a3b8);
	margin-left: 10px;
	flex: none;
}

/* Preview text */
.agy-tv-preview {
	font-family: var(--dsw-font-family-code, ui-monospace, monospace);
	font-size: 11px;
	color: var(--dsw-alias-label-caption, #94a3b8);
	margin-left: 8px;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 35%;
	flex: none;
}

/* Body wrap */
.agy-tv-body-wrap {
	display: flex;
	flex-direction: column;
}

/* Card container */
.agy-tv-card {
	border: 0.5px solid var(--dsw-alias-border-l1, #e2e8f0);
	background: var(--dsw-alias-markdown-code-block, #f8fafc);
	font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
	font-size: 12px;
	line-height: 1.55;
	border-radius: 12px;
	margin: 4px 0 4px 4px;
	display: flex;
	flex-direction: column;
	overflow: hidden;
}

/* Card Header */
.agy-tv-card-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 8px 12px;
	background: var(--dsw-alias-markdown-code-block-banner, rgba(0, 0, 0, 0.02));
	border-bottom: 0.5px solid var(--dsw-alias-border-l2, #e2e8f0);
}
.agy-tv-card-header-left {
	display: flex;
	align-items: baseline;
	gap: 8px;
	min-width: 0;
	flex: 1;
	overflow: hidden;
}
.agy-tv-prompt-glyph {
	color: var(--dsw-alias-label-caption, #94a3b8);
	flex: none;
	font-weight: 700;
}
.agy-tv-card-cwd {
	color: var(--dsw-alias-label-tertiary, #64748b);
	flex: none;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.agy-tv-card-cmd {
	color: var(--dsw-alias-label-primary, #0f172a);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: pre;
	font-weight: 600;
}
.agy-tv-card-path {
	color: var(--dsw-alias-label-primary, #0f172a);
	font-weight: 600;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* Copy button */
.agy-tv-copy-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	background: transparent;
	border: none;
	padding: 2px 6px;
	margin: 0;
	color: var(--dsw-alias-label-secondary, #334155);
	cursor: pointer;
	font-size: 11px;
	line-height: 16px;
	border-radius: 4px;
	transition: background-color 0.1s ease, color 0.1s ease;
	flex: none;
}
.agy-tv-copy-btn:hover {
	background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
	color: var(--dsw-alias-label-primary, #0f172a);
}

/* Card scrollable content */
.agy-tv-card-content {
	max-height: 260px;
	overflow-y: auto;
	overflow-x: auto;
	padding: 10px 14px;
	white-space: pre-wrap;
	word-break: break-word;
	color: var(--dsw-alias-label-secondary, #334155);
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
.agy-tv-card-content::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
.agy-tv-card-content::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
	background-clip: padding-box;
}
.agy-tv-card-content::-webkit-scrollbar-track {
	background: transparent;
	margin: 6px 0;
}

/* Diff lines */
.agy-tv-diff-list {
	display: flex;
	flex-direction: column;
	padding: 6px 0;
	max-height: 280px;
	overflow-y: auto;
	overflow-x: auto;
	scrollbar-width: thin;
	scrollbar-color: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.2)) transparent;
}
.agy-tv-diff-list::-webkit-scrollbar {
	width: 6px;
	height: 6px;
}
.agy-tv-diff-list::-webkit-scrollbar-thumb {
	background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.18));
	border-radius: 6px;
}
.agy-tv-diff-list::-webkit-scrollbar-track {
	background: transparent;
	margin: 4px 0;
}
.agy-tv-diff-line {
	display: flex;
	gap: 8px;
	padding: 0 12px;
	min-height: 20px;
	line-height: 20px;
	white-space: pre-wrap;
	word-break: break-word;
}
.agy-tv-diff-del {
	background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #dc2626) 10%, transparent);
	color: var(--dsw-alias-state-error-primary, #dc2626);
}
.agy-tv-diff-add {
	background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #059669) 10%, transparent);
	color: var(--dsw-alias-state-success-primary, #059669);
}
.agy-tv-diff-marker {
	flex: none;
	width: 14px;
	font-weight: 700;
	user-select: none;
}

/* Inspect button */
.agy-tv-inspect-btn {
	border: 0.5px solid var(--dsw-alias-border-l3, #cbd5e1);
	background: var(--dsw-alias-bg-base, #ffffff);
	color: var(--dsw-alias-label-secondary, #334155);
	cursor: pointer;
	opacity: 0;
	border-radius: 999px;
	align-self: flex-start;
	align-items: center;
	gap: 4px;
	margin: 4px 0 2px 4px;
	padding: 2px 8px;
	font-size: 11px;
	line-height: 16px;
	transition: opacity 0.1s;
	display: inline-flex;
}
.agy-tv-root:hover .agy-tv-inspect-btn,
.agy-tv-inspect-btn:focus-visible {
	opacity: 1;
}
.agy-tv-inspect-btn:hover {
	background: var(--dsw-alias-interactive-bg-hover-solid, #f1f5f9);
	color: var(--dsw-alias-label-primary, #0f172a);
}
`;

// Insert toolview stylesheet into document
const gDoc = (globalThis as unknown as {
	document?: {
		getElementById(id: string): unknown;
		createElement(tag: string): { id?: string; textContent?: string };
		head?: unknown;
		documentElement?: { appendChild(n: unknown): void };
	};
}).document;

if (gDoc !== undefined && gDoc !== null) {
	const styleId = 'dsh-agy-link-toolview-css';
	if (gDoc.getElementById(styleId) === null) {
		const st = gDoc.createElement('style');
		st.id = styleId;
		st.textContent = ROW_CSS;
		const host = (gDoc.head ?? gDoc.documentElement) as unknown as { appendChild(n: unknown): void };
		if (host) host.appendChild(st);
	}
}
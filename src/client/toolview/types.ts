// Structural types shared by the mirror card model and renderers.

export type ToolResultBlock = {
	call: { name: string; argsRaw: string } | null;
	content: readonly { type?: string; text?: string }[];
	isError: boolean;
	error?: { name?: string; code?: string };
	parentCallId?: string;
	subCalls?: readonly unknown[];
};

export type RunningCallBlock = {
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
	/** Standard locale seat, supplied when the registration declares a namespace. */
	t?: (key: string, params?: Record<string, unknown>) => string;
}

export type CardKind = 'terminal' | 'diff' | 'read' | 'search' | 'list' | 'delete' | 'question' | 'image' | 'generic';

export interface MirrorCardModel {
	kind: CardKind;
	tool?: string;
	server?: string;
	title: string;
	command?: string;
	cwd?: string;
	output?: string;
	path?: string;
	oldText?: string | null;
	newText?: string;
	location?: { path: string; line?: number };
	raw?: string;
	questions?: Array<{ question?: string; options?: string[]; is_multi_select?: boolean }>;
	prompt?: string;
	imageName?: string;
	aspectRatio?: string;
	isImage?: boolean;
	imagePath?: string;
}

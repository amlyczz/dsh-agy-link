// Map an agy_tool mirror step onto the card model the renderers consume.

import { isImageFile } from '../images.ts';
import { mirrorInfo, num, parsedArgsRaw, pick, resultText } from './args.ts';
import { relativize } from './format.ts';
import type { CardKind, MirrorCardModel, ToolBlock } from './types.ts';

const TERMINAL_TOOLS = new Set(['run_command', 'bash', 'execute_command', 'ops_bash', 'sh', 'shell']);
const DIFF_TOOLS = new Set(['replace_file_content', 'edit_file', 'replace_in_file', 'edit', 'write_to_file', 'write_file', 'create_file']);
const READ_TOOLS = new Set(['read_file', 'view_file', 'read', 'open_file']);
const SEARCH_TOOLS = new Set(['find_by_name', 'glob', 'ops_glob', 'search_files', 'grep_search', 'search', 'ops_grep', 'search_file_content', 'grep', 'search_web', 'web_search']);
const LIST_TOOLS = new Set(['list_dir', 'ls']);
const DELETE_TOOLS = new Set(['delete_file', 'remove_file', 'rm']);
const QUESTION_TOOLS = new Set(['ask_question', 'ask', 'question']);
const IMAGE_TOOLS = new Set(['generate_image', 'create_image', 'render_image']);

export function mirrorCardModel(block: ToolBlock, cwd?: string, home?: string): MirrorCardModel {
	const info = mirrorInfo(block);
	const out = resultText(block);
	if (info === null) {
		return { kind: 'generic', title: 'agy_tool', output: out, raw: parsedArgsRaw(block) };
	}
	const { tool, input } = info;
	const desc = pick(input, 'Description', 'description', 'toolAction', 'toolSummary', 'Instruction', 'instruction');

	if (tool === 'invoke_subagent') {
		const directRole = pick(input, 'Role', 'role');
		const directTypeName = pick(input, 'TypeName', 'typeName');
		const effRole = directRole && directTypeName ? `${directRole} (${directTypeName})` : (directRole ?? directTypeName);
		const prompt = pick(input, 'Prompt', 'prompt');
		return {
			kind: 'generic',
			tool,
			server: info.server,
			title: desc ?? (effRole ? `Subagent · ${effRole}` : 'Invoke Subagent'),
			command: prompt,
			output: out,
			raw: parsedArgsRaw(block),
		};
	}
	if (QUESTION_TOOLS.has(tool)) {
		const questionsRaw = (input as Record<string, unknown>).questions ?? (input as Record<string, unknown>).Questions;
		const questions = Array.isArray(questionsRaw) ? (questionsRaw as Array<{ question?: string; options?: string[]; is_multi_select?: boolean }>) : [];
		const firstQ = questions[0];
		const qTitle = firstQ?.question ?? desc ?? 'Ask Question';
		return {
			kind: 'question',
			tool,
			server: info.server,
			title: qTitle,
			output: out,
			questions,
			raw: parsedArgsRaw(block),
		};
	}
	if (IMAGE_TOOLS.has(tool)) {
		const prompt = pick(input, 'Prompt', 'prompt') ?? '';
		const name = pick(input, 'ImageName', 'image_name', 'name') ?? 'image';
		const ratio = pick(input, 'AspectRatio', 'aspect_ratio') ?? '1:1';
		return {
			kind: 'image',
			tool,
			server: info.server,
			title: desc ?? `Generate Image · ${name}`,
			prompt,
			imageName: name,
			aspectRatio: ratio,
			output: out,
			raw: parsedArgsRaw(block),
		};
	}
	if (TERMINAL_TOOLS.has(tool)) {
		const command = pick(input, 'CommandLine', 'command_line', 'command', 'cmd', 'Cmd')
			?? (desc && desc.startsWith('$ ') ? desc.replace(/\s*·\s*.*$/, '').replace(/^\$\s*/, '') : undefined)
			?? JSON.stringify(input);
		const cwdVal = pick(input, 'Cwd', 'cwd', 'WorkingDirectory', 'working_directory', 'workdir', 'WorkDir') ?? cwd;
		const rowTitle = desc !== undefined && !desc.startsWith('$ ') && desc !== command ? desc + ' · ' + command : command;
		return {
			kind: 'terminal',
			tool,
			server: info.server,
			title: rowTitle,
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
		return { kind: 'diff', tool, server: info.server, title, path: rawPath, oldText, newText, output: out };
	}
	if (READ_TOOLS.has(tool)) {
		const path = pick(input, 'AbsolutePath', 'absolute_path', 'TargetFile', 'target_file', 'path', 'file_path', 'filename', 'Path', 'FilePath', 'FileName', 'targetFile') ?? '';
		const offset = num(input, 'offset', 'Offset') ?? num(input, 'StartLine', 'start_line');
		const line = offset !== undefined ? (offset > 0 && (tool === 'view_file' || tool === 'read_file') ? offset : offset + 1) : undefined;
		const isImg = isImageFile(path);
		return {
			kind: isImg ? 'image' : 'read',
			tool,
			server: info.server,
			title: desc ? `${desc} · ${path}` : path !== '' ? 'Read ' + path : 'Read',
			path,
			output: out,
			isImage: isImg,
			imagePath: isImg ? path : undefined,
			prompt: desc,
			imageName: path.split(/[/\\]/).pop() || 'image',
			...(path !== '' ? { location: { path, ...(line !== undefined ? { line } : {}) } } : {}),
		};
	}
	if (SEARCH_TOOLS.has(tool)) {
		const rawPat = input.query ?? input.Query ?? input.pattern ?? input.Pattern ?? input.regex ?? input.Regex ?? input.QueryString;
		const q = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat : (pick(input, 'query', 'Query', 'pattern', 'Pattern', 'regex', 'Regex', 'QueryString') ?? ''));
		return { kind: 'search', tool, server: info.server, title: desc ?? (q !== '' ? 'Search ' + q : 'Search'), output: out };
	}
	if (LIST_TOOLS.has(tool)) {
		const path = pick(input, 'DirectoryPath', 'directory_path', 'path', 'directory', 'Path', 'Directory', 'SearchDirectory', 'search_directory', 'AbsolutePath') ?? '';
		return { kind: 'list', tool, server: info.server, title: desc ?? (path !== '' ? 'List ' + path : 'List directory'), output: out };
	}
	if (DELETE_TOOLS.has(tool)) {
		const path = pick(input, 'TargetFile', 'target_file', 'path', 'file_path', 'Path', 'FilePath', 'AbsolutePath') ?? '';
		return { kind: 'delete', tool, server: info.server, title: desc ?? 'Delete ' + path, output: out };
	}
	const defaultTitle = info.server ? `${info.server}: ${tool}` : (tool !== '' ? tool : 'agy_tool');
	const title = desc ?? defaultTitle;
	return { kind: 'generic', tool, server: info.server, title, output: out, raw: parsedArgsRaw(block) };
}

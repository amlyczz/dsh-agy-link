// Card classification for agy's advanced orchestration & browser tools:
// swarm, run_workflow, schedule, manage_task, subagent lifecycle, and browser/devtools.
import { extractImagePathsFromText, num, pick } from './args.ts';
import type { CardBadge, MirrorCardModel } from './types.ts';

const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'define_subagent', 'manage_subagents', 'send_message']);
const BROWSER_TOOLS = new Set([
	'open_browser_url', 'navigate_page', 'take_screenshot', 'capture_browser_screenshot',
	'read_browser_page', 'click', 'click_element', 'fill', 'fill_form', 'type_text',
	'press_key', 'evaluate_script', 'list_pages', 'new_page', 'select_page', 'close_page',
	'wait_for', 'hover', 'drag', 'scroll', 'browser_subagent',
]);

function badge(label: string | undefined, tone: CardBadge['tone'] = 'neutral'): CardBadge[] {
	return label && label.trim() !== '' ? [{ label: label.trim(), tone }] : [];
}

export function classifyExtendedCard(
	tool: string,
	input: Record<string, unknown>,
	desc: string | undefined,
	out: string,
	raw: string,
	server?: string,
): MirrorCardModel | null {
	if (tool === 'swarm') {
		const action = pick(input, 'action', 'Action') ?? 'status';
		const name = pick(input, 'name', 'Name', 'title', 'Title');
		const model = pick(input, 'model', 'Model');
		const workspace = pick(input, 'workspace', 'Workspace');
		const n = num(input, 'n', 'N');
		const tasks = Array.isArray(input.tasks) ? input.tasks : undefined;
		const brief = pick(input, 'brief', 'Brief', 'title', 'Title');
		const badges: CardBadge[] = [
			...badge(action, 'accent'),
			...badge(name, 'ok'),
			...badge(workspace),
			...badge(model),
			...(n !== undefined ? badge(`×${n}`) : tasks ? badge(`${tasks.length} tasks`) : []),
		];
		return {
			kind: 'swarm',
			tool,
			server,
			title: desc ?? (name ? `${action} · ${name}` : `swarm · ${action}`),
			badges,
			...(brief ? { brief } : {}),
			output: out,
			raw,
		};
	}

	if (tool === 'run_workflow') {
		const scriptPath = pick(input, 'ScriptPath', 'script_path', 'scriptPath');
		const cwd = pick(input, 'Cwd', 'cwd');
		const script = pick(input, 'Script', 'script');
		const wfDesc = pick(input, 'Description', 'description') ?? desc;
		const fileName = scriptPath ? scriptPath.split(/[/\\]/).pop() : undefined;
		const badges: CardBadge[] = [
			...badge(fileName ?? (script ? 'inline python' : undefined), 'accent'),
			...badge(cwd),
		];
		return {
			kind: 'workflow',
			tool,
			server,
			title: wfDesc ?? fileName ?? 'Python workflow',
			badges,
			...(script ? { brief: script } : {}),
			...(scriptPath ? { path: scriptPath } : {}),
			output: out,
			raw,
		};
	}

	if (tool === 'schedule') {
		const cron = pick(input, 'CronExpression', 'cron_expression', 'cron');
		const secs = num(input, 'DurationSeconds', 'duration_seconds');
		const isDaemon = input.IsDaemon === true || input.is_daemon === true;
		const cond = pick(input, 'TimerCondition', 'timer_condition');
		const prompt = pick(input, 'Prompt', 'prompt');
		const when = cron ? `cron: ${cron}` : (secs !== undefined ? `${secs}s timer` : 'schedule');
		const badges: CardBadge[] = [
			...badge(when, 'accent'),
			...(isDaemon ? badge('daemon', 'ok') : []),
			...badge(cond && cond !== 'never' ? `cancel: ${cond}` : undefined),
		];
		return {
			kind: 'schedule',
			tool,
			server,
			title: desc ?? when,
			badges,
			...(prompt ? { brief: prompt } : {}),
			output: out,
			raw,
		};
	}

	if (tool === 'manage_task') {
		const action = pick(input, 'Action', 'action') ?? 'list';
		const taskId = pick(input, 'TaskId', 'task_id');
		const taskInput = pick(input, 'Input', 'input');
		const badges: CardBadge[] = [
			...badge(action, action === 'kill' ? 'warn' : 'accent'),
			...badge(taskId),
		];
		return {
			kind: 'task',
			tool,
			server,
			title: desc ?? (taskId ? `${action} · ${taskId}` : action),
			badges,
			...(taskInput ? { brief: taskInput } : {}),
			output: out,
			raw,
		};
	}

	if (SUBAGENT_TOOLS.has(tool)) {
		const role = pick(input, 'Role', 'role', 'Name', 'name');
		const typeName = pick(input, 'TypeName', 'typeName');
		const action = pick(input, 'Action', 'action');
		const recipient = pick(input, 'Recipient', 'recipient');
		const model = pick(input, 'Model', 'model');
		const workspace = pick(input, 'Workspace', 'workspace');
		const body = pick(input, 'Prompt', 'prompt', 'Message', 'message', 'Description', 'description');
		const title = desc
			?? (role && typeName ? `${role} (${typeName})`
				: role ?? typeName ?? (recipient ? `→ ${recipient}` : action ? `${tool} · ${action}` : tool));
		const badges: CardBadge[] = [
			...badge(tool === 'invoke_subagent' ? undefined : tool, 'accent'),
			...badge(action),
			...badge(typeName),
			...badge(model && model !== 'inherit' ? model : undefined),
			...badge(workspace && workspace !== 'inherit' ? workspace : undefined, 'ok'),
			...badge(recipient),
		];
		return {
			kind: 'subagent',
			tool,
			server,
			title,
			badges,
			...(body ? { brief: body } : {}),
			output: out,
			raw,
		};
	}

	const isBrowserServer = server !== undefined && /browser|chrome|playwright|puppeteer/i.test(server);
	if (BROWSER_TOOLS.has(tool) || isBrowserServer) {
		const url = pick(input, 'Url', 'url', 'PageUrl', 'pageUrl');
		const selector = pick(input, 'Selector', 'selector', 'Element', 'element', 'Text', 'text', 'Value', 'value');
		const script = pick(input, 'Script', 'script', 'Function', 'function', 'Expression', 'expression');
		const images = extractImagePathsFromText(out);
		const badges: CardBadge[] = [
			...badge(tool, 'accent'),
			...badge(server),
		];
		return {
			kind: 'browser',
			tool,
			server,
			title: desc ?? url ?? selector ?? tool.replace(/_/g, ' '),
			badges,
			...(url ? { url } : {}),
			...(script || selector ? { brief: script ?? selector } : {}),
			...(images[0] ? { imagePath: images[0], imagePaths: images } : {}),
			output: out,
			raw,
		};
	}

	return null;
}

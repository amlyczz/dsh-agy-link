// agy_tool argument/result parsing.

import type { RunningCallBlock, ToolBlock, ToolResultBlock } from './types.ts';

export function parsedArgsRaw(block: ToolBlock): string {
	const settled = block as ToolResultBlock;
	if ('call' in settled && settled.call !== null && typeof settled.call.argsRaw === 'string') {
		return settled.call.argsRaw;
	}
	const running = block as RunningCallBlock;
	if (typeof running.argsRaw === 'string') return running.argsRaw;
	return '';
}

export function parseArgs(block: ToolBlock): Record<string, unknown> | null {
	const raw = parsedArgsRaw(block);
	if (raw === '') return null;
	try {
		const v = JSON.parse(raw) as unknown;
		return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function cleanString(val: unknown): string {
	if (typeof val !== 'string') return '';
	let s = val.trim();
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1).trim();
	}
	return s;
}

export function parseInnerArgs(raw: unknown): Record<string, unknown> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
	if (typeof raw === 'string') {
		let s = raw.trim();
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
			try {
				const unquoted = JSON.parse(s) as unknown;
				if (typeof unquoted === 'string') s = unquoted.trim();
			} catch {
				// ignore
			}
		}
		try {
			const parsed = JSON.parse(s) as unknown;
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return { value: parsed };
		} catch {
			return { value: raw };
		}
	}
	return { value: raw };
}

export function cleanResultText(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
		try {
			const obj = JSON.parse(trimmed) as { content?: unknown };
			if (Array.isArray(obj?.content)) {
				const parts: string[] = [];
				for (const item of obj.content) {
					const blk = item as { type?: string; text?: unknown };
					if (blk?.type === 'text' && typeof blk.text === 'string') {
						parts.push(blk.text);
					}
				}
				if (parts.length > 0) return parts.join('\n');
			}
		} catch {
			// not JSON
		}
	}
	return text;
}

export function mirrorInfo(block: ToolBlock): { tool: string; input: Record<string, unknown>; server?: string } | null {
	const a = parseArgs(block);
	if (a === null) return null;
	let tool = typeof a.tool === 'string' ? a.tool : '';
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
	let server = typeof a.server === 'string' && a.server !== '' ? cleanString(a.server) : undefined;

	// Unwrap MCP meta-tools: call_mcp_tool, callMcpTool, call_mcp, mcp_call
	if (/^(call_mcp_tool|callMcpTool|call_mcp|mcp_call)$/i.test(tool)) {
		const s = pick(input, 'ServerName', 'server_name', 'serverName', 'server');
		if (s) server = cleanString(s);
		const innerTool = pick(input, 'ToolName', 'tool_name', 'toolName', 'name', 'tool');
		const rawInner = input.Arguments ?? input.arguments ?? input.args ?? input.parameters ?? input.params ?? input.input;
		if (innerTool) {
			tool = cleanString(innerTool);
			input = parseInnerArgs(rawInner);
		}
	} else if (tool.startsWith('mcp__')) {
		const parts = tool.slice(5).split('__');
		if (parts.length >= 2) {
			server = parts[0];
			tool = parts.slice(1).join('__');
		}
	}

	return { tool, input, ...(server ? { server } : {}) };
}

export function pick(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === 'string' && v !== '') return v;
	}
	return undefined;
}

export function num(input: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === 'number' && Number.isFinite(v)) return v;
	}
	return undefined;
}

export function resultText(block: ToolBlock): string {
	const settled = block as ToolResultBlock;
	if (!Array.isArray(settled.content)) return '';
	const parts: string[] = [];
	for (const b of settled.content) {
		if (b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
			parts.push((b as { text: string }).text);
		}
	}
	const text = parts.join('\n');
	return cleanResultText(text);
}

export function isSettled(block: ToolBlock): boolean {
	return block.kind === 'tool-result' || 'content' in block;
}

export function isError(block: ToolBlock): boolean {
	const settled = block as ToolResultBlock;
	return settled.isError === true || (settled.error !== undefined && settled.error !== null);
}

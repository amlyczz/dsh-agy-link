import { renderToStaticMarkup } from './helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatElapsed, groupSubagents, renderSubagentList, type SubagentItem } from '../src/client/sections/SubagentPanel.ts'

const t = ((key: string) => key) as never

const words = { day: 'd', hour: 'h', minute: 'm', second: 's' }

function item(over: Partial<SubagentItem> & { conversationId: string }): SubagentItem {
	return {
		role: 'Builder',
		typeName: 'godot-game-builder',
		running: true,
		lastAction: '正在执行终端命令: build',
		startedAt: 1_000,
		lastAt: 1_000,
		...over,
	}
}

test('groupSubagents splits running from finished, preserving order', () => {
	const { running, finished } = groupSubagents([
		item({ conversationId: 'a' }),
		item({ conversationId: 'b', running: false, state: 'DONE' }),
		item({ conversationId: 'c' }),
	])
	assert.deepEqual(running.map((i) => i.conversationId), ['a', 'c'])
	assert.deepEqual(finished.map((i) => i.conversationId), ['b'])
})

test('formatElapsed picks the coarsest useful unit', () => {
	assert.equal(formatElapsed(0, words), '0s')
	assert.equal(formatElapsed(9_000, words), '9s')
	assert.equal(formatElapsed(4 * 60_000 + 12_000, words), '4m 12s')
	assert.equal(formatElapsed(3_600_000 + 5 * 60_000, words), '1h 05m')
	assert.equal(formatElapsed(2 * 86_400_000 + 3 * 3_600_000, words), '2d 3h')
})

test('renderSubagentList shows role, current action and both sections', () => {
	const now = 1_000 + 4 * 60_000
	const html = renderToStaticMarkup(renderSubagentList(t, [
		item({ conversationId: 'a', role: 'Builder 3', lastAction: '正在执行终端命令: bash ls' }),
		item({ conversationId: 'b', role: 'Concept Artist', running: false, lastAt: now - 60_000, lastAction: '已停止 (DONE)' }),
	], now, true))
	assert.ok(html.includes('Builder 3'))
	assert.ok(html.includes('正在执行终端命令: bash ls'))
	assert.ok(html.includes('Concept Artist'))
	assert.ok(html.includes('subagent.running'))
	assert.ok(html.includes('subagent.finished'))
})

test('renderSubagentList collapses the finished section and shows an empty state', () => {
	const collapsed = renderToStaticMarkup(renderSubagentList(t, [
		item({ conversationId: 'b', running: false, lastAt: 2_000 }),
	], 10_000, false))
	assert.equal(collapsed.includes('已停止'), false, 'rows are hidden while collapsed')

	const empty = renderToStaticMarkup(renderSubagentList(t, [], 10_000, false))
	assert.ok(empty.includes('subagent.empty'))
})

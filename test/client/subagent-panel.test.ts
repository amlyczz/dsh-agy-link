import { renderToStaticMarkup } from '../helpers/client-render.ts'
import test from 'node:test'
import assert from 'node:assert/strict'

import { formatElapsed, renderSubagentList, type SubagentItem } from '../../src/client/sections/SubagentPanel.ts'

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

test('formatElapsed picks the coarsest useful unit', () => {
	assert.equal(formatElapsed(0, words), '0s')
	assert.equal(formatElapsed(9_000, words), '9s')
	assert.equal(formatElapsed(4 * 60_000 + 12_000, words), '4m 12s')
	assert.equal(formatElapsed(3_600_000 + 5 * 60_000, words), '1h 05m')
	assert.equal(formatElapsed(2 * 86_400_000 + 3 * 3_600_000, words), '2d 3h')
})

test('renderSubagentList shows ONLY live subagents (agy keeps finished descriptors forever)', () => {
	const now = 1_000 + 4 * 60_000
	const html = renderToStaticMarkup(renderSubagentList(t, [
		item({ conversationId: 'a', role: 'Builder 3', lastAction: '正在执行终端命令: bash ls' }),
		item({ conversationId: 'b', role: 'Concept Artist', running: false, lastAt: now - 60_000, lastAction: '已停止 (DONE)' }),
	], now))
	assert.ok(html.includes('Builder 3'))
	assert.ok(html.includes('正在执行终端命令: bash ls'))
	assert.equal(html.includes('Concept Artist'), false, 'finished rows must not render')
	assert.equal(html.includes('subagent.finished'), false, 'no history section')
	assert.ok(html.includes('subagent.running 1'))
})

test('renderSubagentList falls back to the empty state', () => {
	const html = renderToStaticMarkup(renderSubagentList(t, [], 10_000))
	assert.ok(html.includes('subagent.empty'))
})

// agy leaves a FINISHED subagent's descriptor at `SUBAGENT_STATE_ALIVE`
// (verified on this machine: 28 + 15 + 12 descriptors all ALIVE for turns that
// had long since ended). So "ALIVE" can never mean "still running". Liveness is
// established by the ROUND: a resumed conversation's pre-existing descriptors
// are history, and the round ending settles whatever is still open.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SubagentTracker } from '../../../src/features/subagent/tracker.ts'
import { snapshotSubagents } from '../../../src/features/subagent/live.ts'
import { setAgyDbDir } from '../../../src/runtime/agy/db/paths.ts'

function fixture(descriptorAgeMs = 0): { root: string; mainConvId: string; mainSubagentsDir: string; subConvId: string; subLogsDir: string } {
	const root = mkdtempSync(join(tmpdir(), 'agy-liveness-'))
	const convDir = join(root, '.gemini', 'antigravity-cli', 'conversations')
	mkdirSync(convDir, { recursive: true })
	setAgyDbDir(convDir)
	const mainConvId = 'conv-main'
	const mainSubagentsDir = join(root, '.gemini', 'antigravity-cli', 'brain', mainConvId, '.system_generated', 'subagents')
	mkdirSync(mainSubagentsDir, { recursive: true })
	const subConvId = 'sub-1'
	const subLogsDir = join(root, '.gemini', 'antigravity-cli', 'brain', subConvId, '.system_generated', 'logs')
	mkdirSync(subLogsDir, { recursive: true })
	const descriptorPath = join(mainSubagentsDir, `${subConvId}.json`)
	writeFileSync(
		descriptorPath,
		JSON.stringify({
			conversationId: subConvId,
			subagentDescriptor: { typeName: 'image-generator', role: 'Concept Artist' },
			state: 'SUBAGENT_STATE_ALIVE',
		}),
	)
	if (descriptorAgeMs > 0) {
		const when = new Date(Date.now() - descriptorAgeMs)
		utimesSync(descriptorPath, when, when)
	}
	return { root, mainConvId, mainSubagentsDir, subConvId, subLogsDir }
}

test('a resumed conversation treats pre-existing ALIVE descriptors as history, not running work', async () => {
	// agy never flips a finished descriptor off ALIVE, so an OLD descriptor is the
	// normal shape of finished work — the panel must not call it running.
	const f = fixture(30 * 60_000)
	try {
		const tracker = new SubagentTracker({
			conversationId: f.mainConvId,
			accountHome: f.root,
			resumed: true,
			pollIntervalMs: 50,
			onEvent: () => {},
		})
		tracker.start()
		await new Promise((r) => setTimeout(r, 120))
		const snap = tracker.snapshot()
		assert.equal(snap.total, 1, 'the historical subagent is still listed')
		assert.equal(snap.running, 0, 'but never as running')
		tracker.stop()
	} finally {
		rmSync(f.root, { recursive: true, force: true })
	}
})

test('the round ending settles every open subagent and detaches it from the live registry', async () => {
	const f = fixture()
	try {
		const tracker = new SubagentTracker({
			conversationId: f.mainConvId,
			accountHome: f.root,
			sessionKey: 'sess-1',
			pollIntervalMs: 50,
			onEvent: () => {},
		})
		tracker.start()
		await new Promise((r) => setTimeout(r, 120))
		assert.equal(tracker.snapshot().running, 1, 'a fresh ALIVE descriptor is reported as running')
		assert.ok(snapshotSubagents().some((s) => s.session === 'sess-1'), 'registered while live')

		tracker.stop()
		const after = tracker.snapshot()
		assert.equal(after.running, 0, 'stop() settles what is still open')
		assert.ok(after.items[0]?.lastAction.includes('已结束'))
		assert.equal(
			snapshotSubagents().some((s) => s.session === 'sess-1'),
			false,
			'and the header control disappears with the round',
		)
	} finally {
		rmSync(f.root, { recursive: true, force: true })
	}
})

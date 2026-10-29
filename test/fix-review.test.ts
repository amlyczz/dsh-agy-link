// Regression tests for the 2026-10 adversarial review fixes.
// Each test names the defect it pins: without it the bug walks back in.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPoolManager } from '../src/host/pool.ts'
import { RunRecording } from '../src/host/recording.ts'
import { EventMapper, suffixDelta } from '../src/host/mapper.ts'
import { conversationsDirFor, snapshotConversations, diffConversations } from '../src/host/discovery.ts'
import { redactLine, redactProxyUrl } from '../src/host/diagnostics.ts'
import { AuthHelper } from '../src/host/auth.ts'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { AgyEvent } from '../src/common/types.ts'

function step(partial: Partial<Extract<AgyEvent, { kind: 'step' }>> & { stepKey: string }): AgyEvent {
	return { kind: 'step', stepKind: 'text', text: '', raw: {}, ...partial } as AgyEvent
}

function userText(text: string): Message {
	return { role: 'user', content: [{ type: 'text', text }] } as unknown as Message
}

describe('recording token-speed stats', () => {
	test('per-step samples with a measurable window produce tps; sub-500ms windows stay excluded', async () => {
		const rec = new RunRecording()
		rec.append(step({ stepKey: '0', usage: { output_tokens: 100 } }))
		await new Promise((r) => setTimeout(r, 20))
		rec.append(step({ stepKey: '0', usage: { output_tokens: 300 } }))
		rec.append(step({ stepKey: '1', usage: { output_tokens: 5 } }))
		const stats = rec.speedStats()
		assert.equal(stats.measuredSteps, 0, '20ms window is below the 500ms floor')
		assert.equal(stats.avgTps, null)
		assert.equal(stats.outputTokens, 305, 'token totals still accumulate')
	})

	test('step usage replaces (not accumulates) the cumulative snapshot sample', () => {
		const rec = new RunRecording()
		rec.append(step({ stepKey: '0', usage: { output_tokens: 10 } }))
		rec.append(step({ stepKey: '0', usage: { output_tokens: 25 } }))
		assert.equal(rec.speedStats().outputTokens, 25, 'last per-call sample wins')
	})

	test('a measurable window yields finite tps values', async () => {
		const rec = new RunRecording()
		rec.append(step({ stepKey: 's', usage: { output_tokens: 10 } }))
		await new Promise((r) => setTimeout(r, 550))
		rec.append(step({ stepKey: 's', usage: { output_tokens: 55 } }))
		const stats = rec.speedStats()
		assert.equal(stats.measuredSteps, 1)
		assert.ok(stats.avgTps !== null && Number.isFinite(stats.avgTps))
		assert.ok(stats.avgTps! > 0 && stats.avgTps! < 500, 'tps is plausible for a ~0.55s window')
		assert.ok(stats.lastTps !== null)
	})
})

describe('mapper fixes', () => {
	test('subagent snapshots emit only the grown suffix, banner once', () => {
		const mapper = new EventMapper({ runId: 'r', cutOnTool: false })
		const out1 = [...mapper.map(step({ stepKey: 's1', stepKind: 'subagent', text: 'alpha' }), 0)]
		const out2 = [...mapper.map(step({ stepKey: 's1', stepKind: 'subagent', text: 'alpha beta' }), 1)]
		const text1 = out1.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
		const text2 = out2.filter((c) => c.type === 'reasoning-delta').map((c) => (c as { text: string }).text).join('')
		assert.equal(text1, '[agy subagent] alpha')
		assert.equal(text2, ' beta', 'only the grown suffix is emitted')
	})

	test('ACTIVE tool steps emit a pending reasoning note once', () => {
		const rec = new RunRecording()
		rec.append(step({ stepKey: 't0', stepKind: 'tool', state: 'ACTIVE', tool: { name: 'run_command' } }))
		rec.append(step({ stepKey: 't0', stepKind: 'tool', state: 'ACTIVE', tool: { name: 'run_command' } }))
		const mapper = new EventMapper({ runId: 'r', cutOnTool: true, usage: rec })
		const notes = [...mapper.map(rec.eventAt(0)!, 0), ...mapper.map(rec.eventAt(1)!, 1)]
			.filter((c) => c.type === 'reasoning-delta')
		assert.equal(notes.length, 1, 'pending note deduped per stepKey')
	})

	test('DONE tool cut forwards the last per-call usage sample, not 0/0', () => {
		const rec = new RunRecording()
		rec.append(step({ stepKey: 'u0', usage: { output_tokens: 500, input_tokens: 1200 } }))
		rec.append(step({ stepKey: 't1', stepKind: 'tool', state: 'DONE', tool: { name: 'run_command', output: 'ok' } }))
		const mapper = new EventMapper({ runId: 'r', cutOnTool: true, usage: rec })
		const chunks = [...mapper.map(rec.eventAt(0)!, 0), ...mapper.map(rec.eventAt(1)!, 1)]
		const usage = chunks.find((c) => c.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } } | undefined
		assert.ok(usage, 'usage chunk emitted at the cut')
		assert.equal(usage!.usage.outputTokens, 500, 'cut usage forwards the last per-call sample, not 0/0')
		assert.equal(usage!.usage.inputTokens, 1200)
		assert.ok(chunks.some((c) => c.type === 'finish' && (c as { reason: { kind: string } }).reason.kind === 'tool-calls'))
	})

	test('suffixDelta contract unchanged', () => {
		assert.equal(suffixDelta('', 'abc'), 'abc')
		assert.equal(suffixDelta('abc', 'abcd'), 'd')
		assert.equal(suffixDelta('abc', 'xyz'), '\nxyz')
	})
})

describe('discovery follows pool account homes', () => {
	test('conversationsDirFor uses the isolated HOME and diff sees new dbs there', () => {
		const home = mkdtempSync(join(tmpdir(), 'agy-disc-'))
		const dir = conversationsDirFor(home)
		assert.equal(dir, join(home, '.gemini', 'antigravity-cli', 'conversations'))
		mkdirSync(dir, { recursive: true })
		const before = snapshotConversations(dir)
		writeFileSync(join(dir, 'conv-abc.db'), 'x')
		const after = diffConversations(before, dir)
		assert.equal(after.conversationId, 'conv-abc', 'isolated-HOME db is discovered')
		// No writes to the system dir → its own snapshot must diff to nothing.
		const sysDir = conversationsDirFor(undefined)
		const sysBefore = snapshotConversations(sysDir)
		assert.equal(diffConversations(sysBefore, sysDir).conversationId, null)
		rmSync(home, { recursive: true, force: true })
	})
})

describe('pool hardening', () => {
	test('deleteAccount refuses to rm directories outside baseDir', () => {
		const base = mkdtempSync(join(tmpdir(), 'agy-pool-'))
		const outside = mkdtempSync(join(tmpdir(), 'agy-pool-outside-'))
		writeFileSync(join(outside, 'precious.txt'), 'keep me')
		const pool = new AccountPoolManager(base)
		const acc = pool.createAccountSlot('evil')
		// Simulate a hand-edited pool.json record pointing anywhere.
		acc.dir = outside
		pool.deleteAccount(acc.id)
		assert.ok(existsSync(join(outside, 'precious.txt')), 'out-of-base dir must survive account deletion')
		// In-base dirs still get cleaned.
		const acc2 = pool.createAccountSlot('good')
		assert.ok(existsSync(acc2.dir!))
		pool.deleteAccount(acc2.id)
		assert.ok(!existsSync(acc2.dir!), 'in-base dir is removed')
		rmSync(base, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	})

	test('persist merges accounts written by another host process', () => {
		const base = mkdtempSync(join(tmpdir(), 'agy-pool-merge-'))
		const poolA = new AccountPoolManager(base)
		const poolB = new AccountPoolManager(base)
		const a = poolA.createAccountSlot('from-a')
		const b = poolB.createAccountSlot('from-b')
		// Both persist their own create; the merge must keep BOTH accounts.
		const ids = new AccountPoolManager(base).getAccounts().map((x) => x.id)
		assert.ok(ids.includes(a.id), 'account from process A survives')
		assert.ok(ids.includes(b.id), 'account from process B survives')
		// A process can only delete ids it knows; deleting the KNOWN id
		// propagates (and is not resurrected by the other process's file).
		poolB.deleteAccount(b.id)
		const after = new AccountPoolManager(base).getAccounts().map((x) => x.id)
		assert.ok(!after.includes(b.id), 'deletion propagates')
		assert.ok(after.includes(a.id), 'unrelated account survives the merge')
		rmSync(base, { recursive: true, force: true })
	})

	test('entry points quarantine add-account slots until login verifies them', () => {
		const base = mkdtempSync(join(tmpdir(), 'agy-pool-authflag-'))
		const pool = new AccountPoolManager(base)
		const acc = pool.createAccountSlot('fresh')
		// The factory itself stays neutral (scheduling tests rely on that);
		// /agy add-account and POST /pool/add mark the slot after creation.
		pool.markAuthRequired(acc.id, 'not signed in yet — complete the terminal login')
		assert.equal(pool.isAccountEligible(acc, 'google'), false, 'unlogged account stays out of rotation')
		// A successful run clears the flag and rejoins rotation.
		pool.recordSuccess(acc.id, 'google')
		assert.equal(pool.getAccount(acc.id)?.authRequired, undefined)
		assert.equal(pool.isAccountEligible(acc, 'google'), true)
		rmSync(base, { recursive: true, force: true })
	})

	test('exhausted quota with an INVALID resetTime still counts as drained', () => {
		const base = mkdtempSync(join(tmpdir(), 'agy-pool-reset-'))
		const pool = new AccountPoolManager(base)
		const acc = pool.getAccounts().find((x) => x.systemHome)!
		pool.updateAccountQuotas(acc.id, {
			google: { remainingFraction: 0.01, resetTime: 'not-a-date', updatedAt: Date.now() },
		})
		assert.equal(pool.isAccountEligible(pool.getAccount(acc.id)!, 'google'), false, 'NaN reset must behave like an absent (pending) reset')
		rmSync(base, { recursive: true, force: true })
	})
})

describe('diagnostics redaction', () => {
	test('redacts Google refresh tokens, AIza keys and credentialed proxy URLs', () => {
		const line = 'refresh_token=1//0abcDEFghiJKLmnoPQRstu flow; key=AIzaSyA1234567890abcdefghijklmnopqrstuvw; POST https://user:secret@proxy.example.com:8080 x'
		const out = redactLine(line)
		assert.ok(!out.includes('1//0abcDEF'), 'refresh token redacted')
		assert.ok(!out.includes('AIzaSyA'), 'API key redacted')
		assert.ok(!out.includes('user:secret'), 'proxy credentials redacted')
	})
	test('redacts OIDC/JWT id_tokens, sk- keys and Google client secrets; keeps ordinary text', () => {
		const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl'
		const line = 'id_token=' + jwt + ' grant=sk-proj-AbCdEf0123456789abcdefgh client_secret=GOCSPX-abcdef123456789 ok=hello world'
		const out = redactLine(line)
		assert.ok(!out.includes(jwt), 'JWT id_token redacted')
		assert.ok(!out.includes('sk-proj-AbCdEf0123456789abcdefgh'), 'sk- API key redacted')
		assert.ok(!out.includes('GOCSPX-abcdef123456789'), 'Google client secret redacted')
		assert.ok(out.includes('ok=hello world'), 'ordinary text preserved')
	})
	test('redacts Basic/Cookie authorization headers', () => {
		const line = 'GET /x  Authorization: Basic dXNlcjpwYXNz  Cookie: session=abc123secret; theme=dark  X-Api-Key: topsecretvalue'
		const out = redactLine(line)
		assert.ok(!out.includes('dXNlcjpwYXNz'), 'Basic auth token redacted')
		assert.ok(!out.includes('abc123secret'), 'cookie value redacted')
		assert.ok(!out.includes('topsecretvalue'), 'x-api-key header redacted')
		assert.ok(out.includes('GET /x'), 'non-secret text preserved')
	})
	test('redactProxyUrl hides credentials, keeps shape', () => {
		assert.equal(redactProxyUrl('http://user:pass@127.0.0.1:7890'), 'http://***:***@127.0.0.1:7890/')
		assert.equal(redactProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
		assert.equal(redactProxyUrl('not a url'), '<proxy-url-redacted>')
	})
})

describe('auth helper lifecycle', () => {
	test('cancel() on an idle helper stays safe; missing bin fails fast', async () => {
		const helper = new AuthHelper(() => null)
		const st = await helper.begin()
		assert.equal(st.phase, 'failed', 'no binary -> failed start')
		helper.cancel()
		assert.ok(['idle', 'failed', 'signed-out'].includes(helper.status().phase))
	})

	test('a superseded begin() cannot clobber the newer flow state', { timeout: 10_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agy-authtest-'))
		const script = join(dir, 'agy')
		writeFileSync(script, '#!/bin/sh\nsleep 30\n')
		const helper = new AuthHelper(() => script)
		const p1 = helper.begin()
		// Let begin #1 install its URL waiter, then start #2 — which cancels
		// #1's probe and resolves #1's waiter with null.
		await new Promise((r) => setTimeout(r, 30))
		const p2 = helper.begin()
		await p1
		// Give the stale continuation a chance to (wrongly) write state.
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(helper.status().phase, 'pending', 'newer flow stays pending')
		// dispose() cancels #2 so the test does not wait out the 20s URL window.
		helper.dispose()
		await p2
		rmSync(dir, { recursive: true, force: true })
	})
})

describe('models: fallback probe throttle', () => {
	test('refreshIfNeeded while on fallback re-probes at most once per window', async () => {
		const { ModelCatalog } = await import('../src/host/models.ts')
		let calls = 0
		const cat = new ModelCatalog(async () => {
			calls++
			throw new Error('offline')
		}, [{ id: 'm1', name: 'M1' }], 5)
		await cat.refreshIfNeeded()
		await cat.refreshIfNeeded()
		await cat.refreshIfNeeded()
		assert.equal(calls, 1, 'fallback source re-probes are throttled to the retry window')
	})
})

describe('adapter: synthetic-message fallback', () => {
	test('a pasted reminder block is forwarded when it is the only user content', async () => {
		const mod = await import('../src/host/adapter.ts')
		const messages: Message[] = [
			userText('<system-reminder>\nA skill is a reusable set of task-specific instructions\n</system-reminder>'),
		]
		assert.equal(mod.latestUserTaskText(messages), '', 'sniffing still filters synthetic-looking text')
		assert.ok(mod.latestUserMessageAny(messages).includes('A skill is a reusable'), 'fallback forwards the only user message')
	})

	test('a real task still wins, and an image-only turn does not rescue older questions', async () => {
		const mod = await import('../src/host/adapter.ts')
		const withReal: Message[] = [
			userText('<system-reminder>noise</system-reminder>'),
			userText('帮我修这个 bug'),
		]
		assert.equal(mod.latestUserTaskText(withReal), '帮我修这个 bug')

		// Image-only trailing turn: no text in the span → NO fallback (the
		// image-only fix must survive); the older question stays buried.
		const imageOnly: Message[] = [
			userText('older question'),
			{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] } as unknown as Message,
			{ role: 'user', content: [{ type: 'image', attachmentId: 'att1' }] } as unknown as Message,
		]
		assert.equal(mod.latestUserMessageAny(imageOnly), '', 'image-only turn never digs up an older question')
	})
})

describe('mirror callId protocol', () => {
	test('mirrorCallId round-trips through parseMirrorCallId', async () => {
		const { mirrorCallId, parseMirrorCallId } = await import('../src/host/recording.ts')
		const id = mirrorCallId('550e8400-e29b-41d4-a716-446655440000', 12)
		assert.deepEqual(parseMirrorCallId(id), { runId: '550e8400-e29b-41d4-a716-446655440000', eventIndex: 12 })
		assert.equal(parseMirrorCallId('not-ours-1'), null)
	})
})

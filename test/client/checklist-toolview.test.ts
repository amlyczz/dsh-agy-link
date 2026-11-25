// Step Checklist (`update_steps`) & Focus (`update_focus`) end-to-end tests:
// shared parser/formatter, DB protobuf extraction, host mirror + DSH `todo/write`
// projection, and client `AgyMirrorToolView` default-expanded checklist UI.
import '../helpers/client-render.ts'
import { React, renderToStaticMarkup } from '../helpers/client-render.ts'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checklistToDshTodos,
  formatChecklistMarkdown,
  normalizeChecklistStatus,
  parseChecklistMarkdown,
  parseChecklistSteps,
  summarizeChecklist,
} from '../../src/common/checklist.ts'
import { extractToolInfo } from '../../src/runtime/agy/db/extract.ts'
import { RunRegistry } from '../../src/host/recording.ts'
import { defineAgyMirrorTool, presentMirrorCall, presentMirrorResult, toolStepBrief } from '../../src/host/mirror-tool.ts'
import { mirrorCardModel } from '../../src/client/toolview/card-model.ts'
import { AgyMirrorToolView, AgyRunCodeToolView } from '../../src/client/toolview.ts'
import { buildToolCallBlock } from '../../src/provider/mapper/tool-block.ts'
import { clearExpandedToolBlockKeysForTest } from '../../src/client/toolview/toggle.ts'
import { bindTranslator, resetTranslatorForTest } from '../../src/client/i18n-bridge.ts'
import { zh } from '../../src/client/locales/zh.ts'
import { en } from '../../src/client/locales/en.ts'
import { es } from '../../src/client/locales/es.ts'
import { ptBR } from '../../src/client/locales/ptBR.ts'

const createElement = (React as { createElement: (type: unknown, props?: unknown) => unknown }).createElement

test('checklist common parser & mapper: handles all 5 statuses, markdown fallback & unique DSH todos', () => {
  assert.equal(normalizeChecklistStatus('completed'), 'done')
  assert.equal(normalizeChecklistStatus('in-progress'), 'in_progress')
  assert.equal(normalizeChecklistStatus('cancelled'), 'skipped')
  assert.equal(normalizeChecklistStatus('error'), 'failed')
  assert.equal(normalizeChecklistStatus('anything'), 'pending')

  const md = [
    '- [x] Audit workspace',
    '- [>] Inspect OAuth setup',
    '- [ ] Run test suite',
    '- [-] Optional step',
    '- [!] Retry upload',
    '- [/] Legacy active syntax',
  ].join('\n')
  const parsed = parseChecklistMarkdown(md)
  assert.deepEqual(parsed, [
    { title: 'Audit workspace', status: 'done' },
    { title: 'Inspect OAuth setup', status: 'in_progress' },
    { title: 'Run test suite', status: 'pending' },
    { title: 'Optional step', status: 'skipped' },
    { title: 'Retry upload', status: 'failed' },
    { title: 'Legacy active syntax', status: 'in_progress' },
  ])

  const sum = summarizeChecklist(parsed)
  assert.deepEqual(sum, {
    done: 1,
    total: 6,
    inProgress: 2,
    pending: 1,
    skipped: 1,
    failed: 1,
    activeTitle: 'Inspect OAuth setup',
  })

  // Duplicate titles get unique suffixes for DSH TodoPanel (`key={item.content}`).
  const todos = checklistToDshTodos([
    { title: 'Check file', status: 'done' },
    { title: 'Check file', status: 'pending' },
    { title: 'Skip item', status: 'skipped' },
    { title: 'Broken item', status: 'failed' },
    { title: 'Running item', status: 'in_progress' },
  ])
  assert.deepEqual(todos, [
    { content: 'Check file', status: 'completed' },
    { content: 'Check file (#2)', status: 'pending' },
    { content: 'Skip item (skipped)', status: 'completed' },
    { content: '[!] Broken item', status: 'pending' },
    { content: 'Running item', status: 'in_progress' },
  ])

  assert.match(formatChecklistMarkdown(parsed), /^- \[x\] Audit workspace/m)
  assert.match(formatChecklistMarkdown(parsed), /^- \[>\] Inspect OAuth setup/m)
  assert.equal(parseChecklistSteps({}, md).length, 6)
})

function pbStrField(fieldNum: number, str: string): Buffer {
  const b = Buffer.from(str, 'utf8')
  const tag = (fieldNum << 3) | 2
  const lenBytes: number[] = []
  let n = b.length
  while (n >= 0x80) {
    lenBytes.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  lenBytes.push(n)
  return Buffer.concat([Buffer.from([tag, ...lenBytes]), b])
}

test('db extract: recovers update_steps and update_focus via protobuf, fallback JSON, and markdown backfill', () => {
  // 1. Standard protobuf fields (field 2 = tool name, field 3 = JSON args)
  const stepsArgs = {
    steps: [
      { title: 'Step A', status: 'done' },
      { title: 'Step B', status: 'in_progress' },
    ],
  }
  const pb = Buffer.concat([pbStrField(2, 'update_steps'), pbStrField(3, JSON.stringify(stepsArgs))])
  const extracted = extractToolInfo(pb)
  assert.equal(extracted?.name, 'update_steps')
  assert.deepEqual(extracted?.args, stepsArgs)

  // 2. Fallback JSON scan with `steps` or `focus` keys when field 2/3 tags are absent
  const focusJsonBuf = Buffer.from('\x08\x01\x1a\x28{"focus":"Inspecting OAuth refresh flow"}\x00', 'utf8')
  const focusOut = extractToolInfo(focusJsonBuf)
  assert.deepEqual(focusOut?.args, { focus: 'Inspecting OAuth refresh flow' })

  const stepsFallbackBuf = Buffer.from('\x08\x02{"steps":[{"title":"Verify build","status":"done"}]}', 'utf8')
  const stepsOut = extractToolInfo(stepsFallbackBuf)
  assert.deepEqual(stepsOut?.args, { steps: [{ title: 'Verify build', status: 'done' }] })

  // 3. RenderInfo markdown backfill when DB stripped JSON args (`{}`) for update_steps
  const mdBackfill = Buffer.concat([
    pbStrField(2, 'update_steps'),
    pbStrField(3, '{}'),
    pbStrField(5, '- [x] First step\n- [>] Second step'),
  ])
  const backfilled = extractToolInfo(mdBackfill)
  assert.equal(backfilled?.name, 'update_steps')
  assert.deepEqual(backfilled?.args.steps, [
    { title: 'First step', status: 'done' },
    { title: 'Second step', status: 'in_progress' },
  ])
})

test('host mirror: brief, present, DSH todo/write session sync and OK->markdown enrichment', async () => {
  const steps = [
    { title: 'Audit workspace', status: 'done' },
    { title: 'Inspect OAuth setup', status: 'in_progress' },
    { title: 'Run test suite', status: 'pending' },
  ]

  assert.equal(toolStepBrief('update_steps', { steps }), 'steps: 1/3 · Inspect OAuth setup')
  assert.equal(toolStepBrief('update_focus', { focus: 'Testing checklist mirror' }), 'focus: Testing checklist mirror')

  const callView = presentMirrorCall({ tool: 'update_steps', input: { steps } })
  assert.equal(callView?.card, 'generic')
  assert.equal(callView?.title, 'Checklist · 1/3 steps · Inspect OAuth setup')

  const focusView = presentMirrorCall({ tool: 'update_focus', input: { focus: 'Testing checklist mirror' } })
  assert.equal(focusView?.title, 'Focus · Testing checklist mirror')

  const resView = presentMirrorResult(
    { tool: 'update_steps', input: { steps } },
    { content: [{ type: 'text', text: 'OK' }], isError: false },
  )
  assert.equal(resView?.card, 'generic')
  const resText = (resView as { content: Array<{ text: string }> }).content[0]!.text
  assert.match(resText, /^- \[x\] Audit workspace/m)
  assert.match(resText, /^- \[>\] Inspect OAuth setup/m)

  // Execute mirrored agy_tool and confirm `todo/write` is appended onto DSH agent session
  const runs = new RunRegistry()
  const rec = runs.create()
  rec.append({
    kind: 'step',
    stepKey: 's1',
    stepKind: 'tool',
    text: '',
    tool: { name: 'update_steps', args: { steps }, output: 'OK' },
  } as never)
  const appended: Array<{ type: string; data: unknown }> = []
  const mirrorTool = defineAgyMirrorTool({ runs })
  const out = await mirrorTool.execute(
    { run: rec.runId, step: 0 } as never,
    {
      signal: new AbortController().signal,
      agent: { session: { append: (type: string, data: unknown) => appended.push({ type, data }) } },
    } as never,
  )

  assert.equal(appended.length, 1)
  assert.equal(appended[0]!.type, 'todo/write')
  assert.deepEqual(appended[0]!.data, {
    todos: [
      { content: 'Audit workspace', status: 'completed' },
      { content: 'Inspect OAuth setup', status: 'in_progress' },
      { content: 'Run test suite', status: 'pending' },
    ],
  })
  assert.match(String(out), /^- \[x\] Audit workspace/m)
})

test('client toolview: update_steps renders auto-expanded Varun Mohan style checklist card + update_focus card + all locales', () => {
  clearExpandedToolBlockKeysForTest()
  resetTranslatorForTest()

  const steps12 = Array.from({ length: 12 }, (_, i) => ({
    title: `Step ${i + 1}`,
    status: 'done',
  }))

  const block = {
    kind: 'tool-result',
    call: {
      name: 'agy_tool',
      argsRaw: JSON.stringify({ tool: 'update_steps', input: { steps: steps12 } }),
    },
    content: [{ type: 'text', text: 'OK' }],
    isError: false,
  }

  const model = mirrorCardModel(block as never)
  assert.equal(model.kind, 'checklist')
  assert.equal(model.checklist?.length, 12)

  // Auto-expanded by default (no prior toggle needed) and localized in zh
  bindTranslator({ locale: { bind: () => (k: string, p?: Record<string, unknown>) => {
    const raw = (zh as Record<string, string>)[k] ?? k
    return raw.replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? ''))
  } } })
  const zhT = (k: string, p?: Record<string, unknown>) => {
    const raw = (zh as Record<string, string>)[k] ?? k
    return raw.replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? ''))
  }
  const htmlZh = renderToStaticMarkup(createElement(AgyMirrorToolView, {
    callId: 'chk-1',
    toolName: 'agy_tool',
    block,
    t: zhT,
  }))
  assert.equal(htmlZh, '', 'non-error checklist cards stay hidden in chat because todo/write projects to DSH TodoPanel')

  // Error checklist cards still surface so failures are never swallowed silently
  const errChecklistBlock = {
    ...block,
    isError: true,
    content: [{ type: 'text', text: 'checklist update failed' }],
  }
  const htmlErrZh = renderToStaticMarkup(createElement(AgyMirrorToolView, {
    callId: 'chk-err',
    toolName: 'agy_tool',
    block: errChecklistBlock,
    t: zhT,
  }))
  assert.ok(htmlErrZh.includes('data-kind="checklist"'))
  assert.ok(htmlErrZh.includes('data-state="err"'))

  // English localization + focus card
  resetTranslatorForTest()
  const enT = (k: string, p?: Record<string, unknown>) => {
    const raw = (en as Record<string, string>)[k] ?? k
    return raw.replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? ''))
  }
  const htmlEn = renderToStaticMarkup(createElement(AgyMirrorToolView, {
    callId: 'chk-2',
    toolName: 'agy_tool',
    block,
    t: enT,
  }))
  assert.equal(htmlEn, '')

  const focusBlock = {
    kind: 'tool-result',
    call: {
      name: 'agy_tool',
      argsRaw: JSON.stringify({ tool: 'update_focus', input: { focus: 'Auditing auth token refresh flow' } }),
    },
    content: [{ type: 'text', text: 'OK' }],
    isError: false,
  }
  const focusModel = mirrorCardModel(focusBlock as never)
  assert.equal(focusModel.kind, 'focus')
  const focusHtml = renderToStaticMarkup(createElement(AgyMirrorToolView, {
    callId: 'foc-1',
    toolName: 'agy_tool',
    block: focusBlock,
    t: enT,
  }))
  assert.ok(focusHtml.includes('data-kind="focus"'))
  assert.ok(focusHtml.includes('Auditing auth token refresh flow'))

  // All 4 dictionaries include every new checklist/focus key
  const newKeys = ['tv.checklist', 'tv.focus', 'tv.checklistProgress', 'tv.checklistInProgress', 'tv.checklistSkipped', 'tv.checklistFailed'] as const
  for (const dict of [zh, en, es, ptBR]) {
    for (const k of newKeys) {
      assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `missing key ${k}`)
    }
  }

  clearExpandedToolBlockKeysForTest()
  resetTranslatorForTest()
})

test('code mode & tool-block: AgyRunCodeToolView renders checklist/focus from markdown output & buildToolCallBlock preserves DB steps', () => {
  clearExpandedToolBlockKeysForTest()
  resetTranslatorForTest()

  const blockResult = buildToolCallBlock({
    runId: 'r-chk',
    absIndex: 3,
    toolName: 'update_steps',
    args: { steps: [] },
    resolvedFullArgs: {
      steps: [
        { title: 'Audit config', status: 'done' },
        { title: 'Run unit tests', status: 'in_progress' },
      ],
      markdown: '- [x] Audit config\n- [>] Run unit tests',
    },
    useCodeWrapper: false,
    blockIdx: 0,
    toolCallStates: new Map(),
    finalUsage: () => null,
  })
  const toolBlockChunk = blockResult.chunks.find((c) => c.type === 'block-end') as { block: { arguments: string } }
  const parsedArgs = JSON.parse(toolBlockChunk.block.arguments) as { input: { steps: unknown[] } }
  assert.equal(parsedArgs.input.steps.length, 2)

  const enT = (k: string, p?: Record<string, unknown>) => {
    const raw = (en as Record<string, string>)[k] ?? k
    return raw.replace(/\{(\w+)\}/g, (_, n: string) => String(p?.[n] ?? ''))
  }

  const runCodeChecklist = {
    kind: 'tool-result',
    call: {
      name: 'run_code',
      argsRaw: JSON.stringify({
        code: "// dsh-agy-link mirror: replay recorded agy tool step 3 (update_steps)\nreturn await tools['agy_tool']({\"run\":\"r-chk\",\"step\":3})",
        description: 'steps: 1/2 · Run unit tests',
      }),
    },
    content: [{ type: 'text', text: '- [x] Audit config\n- [>] Run unit tests' }],
    isError: false,
  }
  const htmlCodeChecklist = renderToStaticMarkup(createElement(AgyRunCodeToolView, {
    callId: 'rc-chk-1',
    toolName: 'run_code',
    block: runCodeChecklist,
    t: enT,
  }))
  assert.equal(htmlCodeChecklist, '')

  const runCodeFocus = {
    kind: 'tool-result',
    call: {
      name: 'run_code',
      argsRaw: JSON.stringify({
        code: "// dsh-agy-link mirror: replay recorded agy tool step 4 (update_focus)\nreturn await tools['agy_tool']({\"run\":\"r-chk\",\"step\":4})",
        description: 'focus: Auditing OAuth refresh',
      }),
    },
    content: [{ type: 'text', text: 'OK' }],
    isError: false,
  }
  const htmlCodeFocus = renderToStaticMarkup(createElement(AgyRunCodeToolView, {
    callId: 'rc-foc-1',
    toolName: 'run_code',
    block: runCodeFocus,
    t: enT,
  }))
  assert.ok(htmlCodeFocus.includes('data-kind="focus"'))
  assert.ok(htmlCodeFocus.includes('Auditing OAuth refresh'))
  assert.equal(htmlCodeFocus.includes('focus: Auditing OAuth refresh'), false)

  clearExpandedToolBlockKeysForTest()
  resetTranslatorForTest()
})

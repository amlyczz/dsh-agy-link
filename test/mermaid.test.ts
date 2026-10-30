// Mermaid fence classification (client-side). The scanner keys off the
// md-code-block banner infostring, which is the raw fence language.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMermaidFence, looksLikeMermaidSource, isMermaidBlock } from '../src/client/mermaid.ts'

test('isMermaidFence accepts the mermaid fence aliases', () => {
  assert.equal(isMermaidFence('mermaid'), true)
  assert.equal(isMermaidFence('Mermaid'), true)
  assert.equal(isMermaidFence('  MERMAID  '), true)
  assert.equal(isMermaidFence('mermaidjs'), true)
  assert.equal(isMermaidFence('mermaid-x'), true)
})

test('isMermaidFence rejects ordinary languages', () => {
  for (const lang of ['typescript', 'js', 'json', 'bash', 'text', '', 'python']) {
    assert.equal(isMermaidFence(lang), false, lang)
  }
})

test('looksLikeMermaidSource sniffs diagram syntax off the first line', () => {
  assert.equal(looksLikeMermaidSource('flowchart TD\n  A --> B'), true)
  assert.equal(looksLikeMermaidSource('graph LR\n  A --> B'), true)
  assert.equal(looksLikeMermaidSource('sequenceDiagram\n  A->>B: hi'), true)
  assert.equal(looksLikeMermaidSource('\n\n  erDiagram\n    USER ||--o{ POST : has'), true)
  assert.equal(looksLikeMermaidSource('const x = 1'), false)
  assert.equal(looksLikeMermaidSource(''), false)
  assert.equal(looksLikeMermaidSource('graphite plot'), false, 'graph alone is not mermaid')
})

test('isMermaidBlock recognizes mermaid fence or sniffs unrecognized code blocks', () => {
  assert.equal(isMermaidBlock('mermaid', 'flowchart TD\n  A --> B'), true)
  assert.equal(isMermaidBlock('代码块', 'flowchart TD\n  A --> B'), true)
  assert.equal(isMermaidBlock('code', 'flowchart TD\n  A --> B'), true)
  assert.equal(isMermaidBlock('', 'sequenceDiagram\n  Alice->>Bob: Hello'), true)
  assert.equal(isMermaidBlock('typescript', 'flowchart TD\n  A --> B'), false)
  assert.equal(isMermaidBlock('python', 'graph LR\n  A --> B'), false)
  assert.equal(isMermaidBlock('代码块', 'const foo = "bar"'), false)
})

test('MERMAID_CSS suppresses leaked mermaid error elements and bomb SVGs at body level', async () => {
  const { MERMAID_CSS } = await import('../src/client/mermaid.ts')
  assert.match(MERMAID_CSS, /body > \[id\^="dagy-mmd"\]/)
  assert.match(MERMAID_CSS, /body > \[id\^="iagy-mmd"\]/)
  assert.match(MERMAID_CSS, /\.error-icon/)
  assert.match(MERMAID_CSS, /\.error-text/)
  assert.match(MERMAID_CSS, /display:\s*none\s*!important/)
})

test('cleanupTempElements sweeps leaked temp containers from DOM', async () => {
  const { cleanupTempElements } = await import('../src/client/mermaid.ts')
  const removed: string[] = []
  const elements = new Map<string, { remove: () => void }>()

  const makeEl = (id: string) => {
    const el = {
      id,
      remove: () => {
        removed.push(id)
        elements.delete(id)
      },
    }
    elements.set(id, el)
    return el
  }

  makeEl('dagy-mmd-1')
  makeEl('iagy-mmd-1')
  makeEl('agy-mmd-1')
  makeEl('dagy-mmd-stray')

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  try {
    ;(globalThis as unknown as { document: unknown }).document = {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: (sel: string) => {
        if (sel.includes('body >')) {
          return Array.from(elements.values())
        }
        return []
      },
    }
    cleanupTempElements('agy-mmd-1')
    assert.ok(removed.includes('dagy-mmd-1'))
    assert.ok(removed.includes('iagy-mmd-1'))
    assert.ok(removed.includes('agy-mmd-1'))
    assert.ok(removed.includes('dagy-mmd-stray'))
  } finally {
    ;(globalThis as unknown as { document?: unknown }).document = origDoc
  }
})

test('cleanupTempElements preserves active rendered diagram inside data-agy-mermaid-svg mount', async () => {
  const { cleanupTempElements } = await import('../src/client/mermaid.ts')
  const removed: string[] = []
  const elements = new Map<string, { id: string; remove: () => void; closest: (sel: string) => unknown }>()

  const makeActiveEl = (id: string, inMount: boolean) => {
    const el = {
      id,
      remove: () => {
        removed.push(id)
        elements.delete(id)
      },
      closest: (sel: string) => (inMount && sel === '[data-agy-mermaid-svg]' ? {} : null),
    }
    elements.set(id, el)
    return el
  }

  makeActiveEl('dagy-mmd-2', false)
  makeActiveEl('agy-mmd-2', true) // Active SVG inside mount!

  const origDoc = (globalThis as unknown as { document?: unknown }).document
  try {
    ;(globalThis as unknown as { document: unknown }).document = {
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: () => [],
    }
    cleanupTempElements('agy-mmd-2')
    assert.ok(removed.includes('dagy-mmd-2'))
    assert.ok(!removed.includes('agy-mmd-2'), 'Active SVG inside mount must never be removed!')
  } finally {
    ;(globalThis as unknown as { document?: unknown }).document = origDoc
  }
})

test('repairMermaidSource heals common LLM syntax flaws in flowcharts', async () => {
  const { repairMermaidSource } = await import('../src/client/mermaid.ts')

  // 1. Plus between nodes converted to ampersand
  assert.equal(
    repairMermaidSource('graph LR\n  A[石] + B[石] --> C[斧] + D[碎屑]'),
    'graph LR\n  A[石] & B[石] --> C[斧] & D[碎屑]',
  )

  // 2. Plus inside label or string or pipe preserved
  assert.equal(
    repairMermaidSource('graph TD\n  A["1 + 1"] + B[2] -->|3 + 4| C[5 + 6]'),
    'graph TD\n  A["1 + 1"] & B[2] -->|3 + 4| C[5 + 6]',
  )

  // 3. Subgraph with colon or spaces quoted
  assert.equal(
    repairMermaidSource('graph TD\n  subgraph 链条1: 工具打制与机械剥离\n    A --> B\n  end'),
    'graph TD\n  subgraph "链条1: 工具打制与机械剥离"\n    A --> B\n  end',
  )

  // 4. Node brackets with unquoted >, <, : wrapped in quotes
  assert.equal(
    repairMermaidSource('flowchart LR\n  T[人口 > 12] --> S[私有制: 守罐人霸占]'),
    'flowchart LR\n  T["人口 > 12"] --> S["私有制: 守罐人霸占"]',
  )

  // 5. Sequence diagram and others untouched
  const seq = 'sequenceDiagram\n  Alice->>Bob: 1 + 1\n  Bob-->>Alice: OK'
  assert.equal(repairMermaidSource(seq), seq)

  // 6. Complete reproduction of user incident
  const incident = `graph LR
    subgraph 链条1: 工具打制与机械剥离
        A[卵石] + B[卵石] -->|敲击| C[石片] + D[碎屑]
        C[石片] + E[木棒] -->|绑合| F[石矛]
    end

    subgraph 链条2: 热力相变与化学跃迁
        G[篝火] + H[生肉] -->|火烹| I[熟肉] + J[灵感]
        G[篝火] + K[软泥] -->|烧制| L[陶罐]
        G[陶窑] + M[孔雀石] -->|冶炼| N[红铜]
    end

    subgraph 链条3: 农业存储与剩余异化
        O[草籽] + P[草木灰] -->|刀耕火种| Q[粟米]
        Q[粟米] + L[陶罐] -->|收纳| R[剩余口粮]
        R[剩余口粮] -->|满10份触发| S[私有制: 守罐人霸占]
    end

    subgraph 链条4: 虚构共识与大他者
        T[人口 > 12] -->|邓巴数危机| U[内讧卡]
        V[奇石] + W[祭司] -->|立起神权| X[图腾光环: 消除内讧]
    end`

  const repaired = repairMermaidSource(incident)
  assert.ok(!repaired.includes('A[卵石] + B[卵石]'))
  assert.ok(repaired.includes('A[卵石] & B[卵石]'))
  assert.ok(repaired.includes('subgraph "链条1: 工具打制与机械剥离"'))
  assert.ok(repaired.includes('T["人口 > 12"]'))
  assert.ok(repaired.includes('S["私有制: 守罐人霸占"]'))
  assert.ok(repaired.includes('X["图腾光环: 消除内讧"]'))
})

test('MERMAID_CSS includes source-view toggle support and responsive toolbar', async () => {
  const { MERMAID_CSS } = await import('../src/client/mermaid.ts')
  assert.match(MERMAID_CSS, /data-agy-mermaid-view="source"/)
  assert.match(MERMAID_CSS, /\.agy-mermaid-toolbar/)
  assert.match(MERMAID_CSS, /\.agy-mermaid-toggle/)
  assert.match(MERMAID_CSS, /\.agy-mermaid-warn/)
  assert.match(MERMAID_CSS, /\.agy-mermaid-body/)
})

test('isInvalidOrCollapsedSvg detects empty, error, and 0x0 collapsed SVG artifacts', async () => {
  const { isInvalidOrCollapsedSvg } = await import('../src/client/mermaid.ts')

  // Empty / nil
  assert.equal(isInvalidOrCollapsedSvg(''), true)
  assert.equal(isInvalidOrCollapsedSvg('   '), true)
  assert.equal(isInvalidOrCollapsedSvg(null), true)
  assert.equal(isInvalidOrCollapsedSvg(undefined), true)

  // Internal error shapes
  assert.equal(isInvalidOrCollapsedSvg('<svg><g class="error-icon"></g></svg>'), true)
  assert.equal(isInvalidOrCollapsedSvg('<svg><text class="error-text">Syntax error</text></svg>'), true)
  assert.equal(isInvalidOrCollapsedSvg('<svg aria-roledescription="error"></svg>'), true)

  // 0x0 / off-screen collapsed artifacts (16x16 dagre collapse)
  assert.equal(isInvalidOrCollapsedSvg('<svg id="agy-mmd-1" viewBox="0 0 0 0"></svg>'), true)
  assert.equal(isInvalidOrCollapsedSvg('<svg id="agy-mmd-1" width="100%" style="max-width: 16px;" viewBox="-8 -8 16 16"></svg>'), true)
  assert.equal(isInvalidOrCollapsedSvg('<svg id="agy-mmd-1" style="max-width: 0px;" viewBox="0 0 100 100"></svg>'), true)

  // Valid diagram SVGs
  assert.equal(
    isInvalidOrCollapsedSvg('<svg id="agy-mmd-1" width="100%" style="max-width: 1272.45px;" viewBox="-35 0 1272.45 913"><g class="root"></g></svg>'),
    false,
  )
  assert.equal(
    isInvalidOrCollapsedSvg('<svg id="agy-mmd-2" width="100%" style="max-width: 480px;" viewBox="0 0 480 320"><g></g></svg>'),
    false,
  )
})

test('repairMermaidSource heals latest 4-subgraph decomposition pipeline diagram', async () => {
  const { repairMermaidSource } = await import('../src/client/mermaid.ts')
  const src = `flowchart TD
    subgraph M1["机制一：解构剥离管线 (借鉴Card Survival)"]
        A1["兽尸 (carcass)"] + A2["石片 (sharp_flake)"] --> A3["生肉 (raw_meat)"]
        A1 + A2 --> A4["兽骨 (bone)"]
        A1 + A2 --> A5["生皮 (hide)"]
        A1 + A2 --> A6["兽筋 (sinew, 绳索原料)"]
        A1 + A2 --> A7["骨髓 (marrow, 高脂健脑)"]
    end

    subgraph M2["机制二：微观容器环境 (借鉴Stacklands与Card Survival)"]
        B1["陶罐 (pottery_jar)"] --> B2["内部密封空间 (30容量)"]
        B2 --> B3["放入【草木灰/盐】 -> 生成【腌肉】(永不腐烂)"]
        B2 --> B4["放入【野果+水】置于火旁 -> 自然发酵成【原始果酒】"]
    end

    subgraph M3["机制三：精神状态与唯物异化 (我们的原创升华)"]
        C1["剩余熟食过剩"] --> C2["普通族人 -> 变异为【护食者】"]
        C2 --> C3["自私锁：死抱陶罐，拒绝伐木，争抢斗殴"]
        C3 --> C4["【公社粮仓】+【赋税泥板】化解危机 -> 诞生国家文书制度"]
    end

    subgraph M4["机制四：时代探索卡包与物理弹跳 (借鉴Stacklands)"]
        D1["旧石器探索包: 【荒原馈赠】"] --> D2["开出新资源/奇石/野兽"]
        D3["新石器探索包: 【泥土与火】"] --> D4["开出黏土/谷种/野猪"]
        D5["青铜时代探索包: 【地底矿脉】"] --> D6["开出孔雀石/锡石/沥青"]
    end`

  const repaired = repairMermaidSource(src)
  assert.ok(repaired.includes('A1["兽尸 (carcass)"] & A2["石片 (sharp_flake)"] --> A3["生肉 (raw_meat)"]'))
  assert.ok(repaired.includes('A1 & A2 --> A4["兽骨 (bone)"]'))
  assert.ok(!repaired.includes('A1 + A2 -->'))
})

test('enqueueMermaidRender serializes concurrent diagram renders', async () => {
  const { enqueueMermaidRender } = await import('../src/client/mermaid.ts')
  const order: string[] = []
  const mk = (name: string, delay: number) => async () => {
    order.push('start:' + name)
    await new Promise((r) => setTimeout(r, delay))
    order.push('end:' + name)
    return name
  }
  // Queued in order even though b/c would resolve far sooner than a.
  const results = await Promise.all([
    enqueueMermaidRender(mk('a', 30)),
    enqueueMermaidRender(mk('b', 1)),
    enqueueMermaidRender(mk('c', 1)),
  ])
  assert.deepEqual(results, ['a', 'b', 'c'])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c'])
})

test('enqueueMermaidRender keeps the chain alive after a failing task', async () => {
  const { enqueueMermaidRender } = await import('../src/client/mermaid.ts')
  const order: string[] = []
  const bad = enqueueMermaidRender(async () => {
    order.push('bad')
    throw new Error('boom')
  })
  const after = enqueueMermaidRender(async () => {
    order.push('after')
    return 42
  })
  await assert.rejects(bad, /boom/)
  assert.equal(await after, 42)
  assert.deepEqual(order, ['bad', 'after'])
})

test('sourceSignature distinguishes streaming prefixes from the final source', async () => {
  const { sourceSignature } = await import('../src/client/mermaid.ts')
  const partial = 'flowchart TD\n    In["H"] --> B1'
  const full = partial + '\n    B1 --> B2'
  assert.equal(sourceSignature(partial), sourceSignature(partial))
  assert.notEqual(sourceSignature(partial), sourceSignature(full))
  assert.notEqual(sourceSignature('flowchart TD'), sourceSignature('flowchart TD '))
})

test('mermaidScanAction retries a block once its streamed source settles', async () => {
  const { mermaidScanAction } = await import('../src/client/mermaid.ts')
  // Never attempted -> render immediately (no settle delay for finished blocks).
  assert.equal(mermaidScanAction(null, null, null, 'a'), 'render')
  // Already handled this exact source -> skip.
  assert.equal(mermaidScanAction('done', 'a', null, 'a'), 'skip')
  // Same source previously failed -> don't hammer it.
  assert.equal(mermaidScanAction('fallback', 'a', null, 'a'), 'skip')
  assert.equal(mermaidScanAction('error', 'a', null, 'a'), 'skip')
  // A render is in flight -> skip.
  assert.equal(mermaidScanAction('busy', 'a', null, 'b'), 'skip')
  // Source changed after an attempt: wait one quiet pass, then render.
  assert.equal(mermaidScanAction('fallback', 'a', null, 'b'), 'wait')
  assert.equal(mermaidScanAction('fallback', 'a', 'b', 'b'), 'render')
  // A partial diagram that rendered mid-stream is re-rendered for the full text.
  assert.equal(mermaidScanAction('done', 'a', 'b', 'b'), 'render')
})



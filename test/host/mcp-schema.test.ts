import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGY_ALWAYS_LOAD_META,
  AGY_MCP_SAFE_TOKEN_BUDGET,
  enforceArrayItems,
  estimateMcpToolsTokens,
  extractMcpContentBlocks,
  findArraysMissingItems,
  prepareMcpTools,
  sanitizeMcpSchema,
  sanitizeRe2Pattern,
  type McpToolDef,
} from '../../src/host/mcp-schema.ts'

describe('Slice 4: Reverse MCP Bridge 4x hardening', () => {
  it('converts JS \\uXXXX, \\u{...} and UTF-16 surrogate pairs to Go RE2 syntax', () => {
    assert.deepEqual(sanitizeRe2Pattern('^[\\u4e00-\\u9fff]+$'), {
      pattern: '^[\\x{4E00}-\\x{9FFF}]+$',
    })
    // Surrogate pair for U+1F600 (😀): \uD83D\uDE00
    assert.deepEqual(sanitizeRe2Pattern('^\\uD83D\\uDE00$'), {
      pattern: '^\\x{1F600}$',
    })
    assert.deepEqual(sanitizeRe2Pattern('^\\u{1f680}+$'), {
      pattern: '^\\x{1F680}+$',
    })
  })

  it('downgrades lookarounds and backreferences into description notes instead of crashing RE2', () => {
    const lookahead = sanitizeRe2Pattern('^(?!admin)[a-z]+$')
    assert.equal(lookahead.pattern, undefined)
    assert.match(lookahead.note ?? '', /Pattern: \/\^\(\?!admin\)\[a-z\]\+\$\//)

    const backref = sanitizeRe2Pattern('^([a-z]+)-\\1$')
    assert.equal(backref.pattern, undefined)
    assert.match(backref.note ?? '', /Pattern:/)

    const schema = sanitizeMcpSchema({
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Unique slug',
          pattern: '^(?!reserved)[a-z0-9-]+$',
        },
      },
    })
    const props = schema.properties as Record<string, Record<string, unknown>>
    const slug = props.slug
    assert.ok(slug)
    assert.equal(slug.pattern, undefined)
    assert.match(String(slug.description), /Unique slug/)
    assert.match(String(slug.description), /Pattern:/)
  })

  it('flattens $ref (with cyclic guard), allOf, nullable anyOf/oneOf, const, empty enum, and ensures array items', () => {
    const clean = sanitizeMcpSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        Tag: { type: 'string', enum: ['a', 'b'] },
        Node: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            child: { $ref: '#/$defs/Node' },
          },
        },
      },
      allOf: [
        { type: 'object', properties: { base: { const: 'v1' } }, required: ['base'] },
        {
          type: 'object',
          properties: {
            tag: { anyOf: [{ $ref: '#/$defs/Tag' }, { type: 'null' }] },
            node: { $ref: '#/$defs/Node' },
            itemsList: { type: 'array' },
            badEnum: { type: 'string', enum: [] },
            nullableType: { type: ['number', 'null'] },
          },
          required: ['tag'],
        },
      ],
      examples: [{ base: 'v1' }],
    })

    assert.equal('$schema' in clean, false)
    assert.equal('$defs' in clean, false)
    assert.equal('examples' in clean, false)
    assert.equal('allOf' in clean, false)
    assert.deepEqual(clean.required, ['base', 'tag'])

    const props = clean.properties as Record<string, Record<string, unknown>>
    const base = props.base
    const badEnum = props.badEnum
    const nullableType = props.nullableType
    const node = props.node
    assert.ok(base && badEnum && nullableType && node)
    assert.deepEqual(base.enum, ['v1'])
    assert.equal('const' in base, false)
    assert.deepEqual(props.tag, { type: 'string', enum: ['a', 'b'] })
    assert.deepEqual(props.itemsList, { type: 'array', items: { type: 'string' } })
    assert.equal('enum' in badEnum, false)
    assert.equal(nullableType.type, 'number')
    const nodeProps = node.properties as Record<string, Record<string, unknown>>
    assert.equal(nodeProps.id?.type, 'string')
  })

  it('attaches antigravity/alwaysLoad _meta and trims verbose descriptions under the 18k token ceiling without dropping any tool', () => {
    const hugeDesc = 'Detailed tool documentation explaining every single edge case and parameter. '.repeat(40)
    const raw: McpToolDef[] = Array.from({ length: 40 }, (_, i) => ({
      name: `tool_${i}`,
      dshName: `dsh.tool_${i}`,
      description: hugeDesc,
      inputSchema: {
        type: 'object',
        title: `Tool${i}Input`,
        properties: {
          query: { type: 'string', title: 'QueryTitle', description: hugeDesc },
          limit: { type: 'number', title: 'LimitTitle', description: hugeDesc },
        },
      },
    }))

    assert.ok(estimateMcpToolsTokens(raw) > AGY_MCP_SAFE_TOKEN_BUDGET)
    const prepared = prepareMcpTools(raw)
    assert.equal(prepared.length, raw.length)
    assert.ok(estimateMcpToolsTokens(prepared) <= AGY_MCP_SAFE_TOKEN_BUDGET)
    for (const t of prepared) {
      assert.deepEqual(t._meta, AGY_ALWAYS_LOAD_META)
      assert.equal('title' in t.inputSchema, false)
    }
  })

  it('extracts MCP image + text content blocks when a tool returns images', () => {
    assert.equal(extractMcpContentBlocks({ content: [{ type: 'text', text: 'only text' }] }), undefined)
    const blocks = extractMcpContentBlocks({
      content: [
        { type: 'text', text: 'Screenshot captured' },
        { type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
      ],
    })
    assert.deepEqual(blocks, [
      { type: 'text', text: 'Screenshot captured' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
    ])
  })
})

describe('MCP bridge: no array may reach agy without `items`', () => {
  // Google rejects the WHOLE GenerateContentRequest when a single declaration
  // is malformed (`...properties[args].items: missing field`), so the bridge
  // must guarantee the post-condition rather than hope sanitizeNode covered it.
  const hostile: McpToolDef = {
    name: 'game_procedural_mesh',
    dshName: 'mcp__godot__game_procedural_mesh',
    description: 'build a mesh from raw arrays',
    inputSchema: {
      type: 'object',
      properties: {
        vertices: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        // Plain array with no items at all.
        args: { type: 'array' },
        // Array hidden inside a union branch.
        points: { anyOf: [{ type: 'array' }, { type: 'null' }] },
        // Array hidden inside additionalProperties.
        methods: { type: 'object', additionalProperties: { type: 'array' } },
        // Array behind a $ref whose definition is incomplete.
        normals: { $ref: '#/$defs/NumList' },
      },
      $defs: { NumList: { type: 'array' } },
    },
  }

  it('finds the violation in a raw schema (proves the audit can see it)', () => {
    const found = findArraysMissingItems(hostile.inputSchema)
    assert.ok(found.length >= 3, `expected several violations, got ${JSON.stringify(found)}`)
    assert.ok(found.some((p) => p.includes('args')))
  })

  it('prepareMcpTools output satisfies the post-condition for every tool', () => {
    const prepared = prepareMcpTools([hostile])
    assert.equal(prepared.length, 1)
    assert.deepEqual(findArraysMissingItems(prepared[0]!.inputSchema), [])
    // The nested shape survives: vertices stays array-of-array-of-number.
    const props = (prepared[0]!.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>
    assert.equal(props.vertices?.type, 'array')
    assert.deepEqual(props.vertices?.items, { type: 'array', items: { type: 'number' } })
  })

  it('the guard is idempotent and depth-safe', () => {
    let deep: Record<string, unknown> = { type: 'array' }
    for (let i = 0; i < 30; i++) deep = { type: 'object', properties: { child: deep } }
    const once = enforceArrayItems(deep)
    assert.deepEqual(findArraysMissingItems(once), [])
    const twice = enforceArrayItems(once)
    assert.deepEqual(twice, once)
  })
})

describe('Gemini enum hygiene', () => {
  it('drops empty-string and null enum members (enum[N]: cannot be empty)', () => {
    const clean = sanitizeMcpSchema({
      type: 'object',
      properties: {
        permission: { type: 'string', enum: ['read', 'write', 'admin', ''] },
        mode: { anyOf: [{ const: 'a' }, { const: '' }, { type: 'null' }] },
        onlyEmpty: { type: 'string', enum: [''] },
      },
    }) as { properties: Record<string, { enum?: unknown[] }> }
    assert.deepEqual(clean.properties.permission?.enum, ['read', 'write', 'admin'])
    assert.deepEqual(clean.properties.mode?.enum, ['a'])
    assert.equal(clean.properties.onlyEmpty?.enum, undefined)
  })
})

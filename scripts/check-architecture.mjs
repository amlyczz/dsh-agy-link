#!/usr/bin/env node
// Dependency-direction guard. Zero runtime deps: uses the TypeScript compiler
// API that is already a devDependency.
//
// Rules (the target modular-monolith layering):
//   common   -> nothing but common + node builtins
//   domain   -> common
//   runtime  -> common, domain
//   provider -> common, domain, runtime
//   features -> common, domain, runtime, provider
//   transport-> common, domain, runtime, provider, features
//   client   -> common ONLY (never host/provider/transport/index)
//   index    -> everything (composition root)
//
// Existing files are allowed to violate the TARGET paths only while their
// phase is in progress; the rule set below already matches today's code for
// the boundaries that must never regress.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcRoot = path.join(root, 'src')
const files = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.ts') || p.endsWith('.mjs')) files.push(p)
  }
}
walk(srcRoot)

const graph = new Map()
const rel = (p) => path.relative(root, p).replaceAll(path.sep, '/')

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(from), spec)
  for (const cand of [base, base + '.ts', base + '.mjs', path.join(base, 'index.ts')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand
  }
  return null
}

for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const deps = []
  sf.forEachChild((n) => {
    if (ts.isImportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const to = resolveImport(file, n.moduleSpecifier.text)
      if (to) deps.push(to)
    }
  })
  graph.set(file, deps)
}

const violations = []
for (const [from, deps] of graph) {
  const f = rel(from)
  for (const to of deps) {
    const t = rel(to)
    if (f.startsWith('src/client/') && (t.startsWith('src/host/') || t.startsWith('src/provider/') || t.startsWith('src/transport/') || t.startsWith('src/cli/') || t === 'src/index.ts')) {
      violations.push(`${f} -> ${t} (client may only import common/*)`)
    }
    if (f.startsWith('src/common/') && (t.startsWith('src/host/') || t.startsWith('src/client/') || t.startsWith('src/provider/') || t.startsWith('src/transport/') || t.startsWith('src/cli/') || t === 'src/index.ts')) {
      violations.push(`${f} -> ${t} (common must stay a leaf)`)
    }
    if (f.startsWith('src/host/') && t === 'src/index.ts') {
      violations.push(`${f} -> ${t} (host must not import the composition root)`)
    }
  }
}

// cycle detection
const WHITE = 0, GRAY = 1, BLACK = 2
const color = new Map()
const stack = []
const cycles = []
function dfs(node) {
  color.set(node, GRAY); stack.push(node)
  for (const next of graph.get(node) ?? []) {
    const c = color.get(next) ?? WHITE
    if (c === GRAY) cycles.push([...stack.slice(stack.indexOf(next)), next].map(rel).join(' -> '))
    else if (c === WHITE) dfs(next)
  }
  stack.pop(); color.set(node, BLACK)
}
for (const node of graph.keys()) if ((color.get(node) ?? WHITE) === WHITE) dfs(node)

const lines = []
if (cycles.length) {
  lines.push('Import cycles:')
  for (const c of cycles) lines.push('  ' + c)
}
if (violations.length) {
  lines.push('Dependency-direction violations:')
  for (const v of violations) lines.push('  ' + v)
}
if (lines.length) {
  console.error(lines.join('\n'))
  console.error(`\n${cycles.length} cycle(s), ${violations.length} violation(s)`)
  process.exit(1)
}
console.log(`architecture ok: ${graph.size} modules, 0 cycles, 0 direction violations`)

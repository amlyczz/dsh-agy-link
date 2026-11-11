#!/usr/bin/env node
// Size ratchet. God files may only shrink: every oversized file carries its
// current ceiling in scripts/budgets-allowlist.json. New files must fit the
// normal budget. Functions in the target modules (provider/transport/domain/
// runtime/client ui+hooks+sections) must fit the function budget immediately.
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const srcRoot = path.join(root, 'src')
const FILE_BUDGET = 600
const FN_BUDGET = 120
const allow = JSON.parse(fs.readFileSync(path.join(root, 'scripts/budgets-allowlist.json'), 'utf8'))

const files = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith('.ts') || p.endsWith('.mjs')) files.push(p)
  }
}
walk(srcRoot)

const problems = []
for (const file of files) {
  const rel = path.relative(root, file).replaceAll(path.sep, '/')
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n').length
  const ceiling = allow.files[rel]
  if (ceiling !== undefined) {
    if (lines > ceiling) problems.push(`${rel}: ${lines} lines > ratchet ceiling ${ceiling}`)
  } else if (lines > FILE_BUDGET) {
    problems.push(`${rel}: ${lines} lines > ${FILE_BUDGET} (add it to the ratchet only for legacy files)`)
  }

  const inTarget = /^src\/(provider|transport|domain|runtime)\//.test(rel) || /^src\/client\/(ui|hooks|sections)\//.test(rel)
  if (!inTarget) continue
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  sf.forEachChild((n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name) return
    const start = sf.getLineAndCharacterOfPosition(n.getStart()).line
    const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line
    const size = end - start + 1
    if (size > FN_BUDGET) problems.push(`${rel}: function ${n.name.text} is ${size} lines > ${FN_BUDGET}`)
  })
}

if (problems.length) {
  console.error('Budget violations:')
  for (const p of problems) console.error('  ' + p)
  process.exit(1)
}
console.log(`budgets ok: ${files.length} files (${Object.keys(allow.files).length} legacy ratchet entries)`)

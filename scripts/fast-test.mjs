#!/usr/bin/env node
/**
 * fast-test.mjs — TDD 极速反馈运行器 (Fast TDD Loop)
 * 参考 academic-agent 两级双环设计原则：
 * 内环（TDD 极速环，1~3 秒）：
 * 1. 自动根据 Git 变更检测受影响的测试用例，秒级极速反馈；
 * 2. 支持精准测试映射，直接运行特定文件；
 * 3. 避免在红绿重构与日常开发中直接运行全量慢速测试套件。
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEST_DIR = join(ROOT, 'test')

// 源码模块与测试用例的高精度映射表
const COMPONENT_TEST_MAP = {
  'src/host/adapter.ts': ['test/adapter.test.ts'],
  'src/host/models.ts': ['test/models.test.ts'],
  'src/host/quota.ts': ['test/quota.test.ts'],
  'src/host/pool.ts': ['test/pool.test.ts', 'test/pool-auth.test.ts'],
  'src/host/sessions.ts': ['test/sessions.test.ts'],
  'src/host/runner.ts': ['test/cross-platform.test.ts', 'test/proxy-keychain.test.ts'],
  'src/host/keychain.ts': ['test/proxy-keychain.test.ts'],
  'src/host/parser.ts': ['test/parser.test.ts', 'test/mapper.test.ts'],
  'src/host/mirror-tool.ts': ['test/mirror-tool.test.ts'],
  'src/host/mcp.ts': ['test/mcp-ready-disposal.test.ts'],
  'src/host/agy-usage.ts': ['test/agy-usage.test.ts'],
  'src/host/agy-db.ts': ['test/agy-db.test.ts'],
  'src/host/media-route.ts': ['test/media-route.test.ts'],
  'src/host/recording.ts': ['test/adapter.test.ts'],
  'src/client/reasoning.ts': ['test/reasoning-scroll.test.ts', 'test/scroll-guard.test.ts'],
  'src/client/scroll-guard.ts': ['test/scroll-guard.test.ts'],
  'src/client/decisions.ts': ['test/decisions-idempotent.test.ts'],
  'src/client/mermaid.ts': ['test/mermaid.test.ts'],
  'src/client/toolview.ts': ['test/toolview.test.ts', 'test/run-code-view.test.ts'],
  'src/client/images.ts': ['test/toolview.test.ts'],
  'src/client/index.ts': ['test/client-plugin-meta.test.ts', 'test/client-render.test.ts'],
  'src/client/styles.ts': ['test/client-account-card-style.test.ts', 'test/client-dom.test.ts'],
  'src/client/global-css.ts': ['test/client-account-card-style.test.ts', 'test/client-dom.test.ts'],
  'src/client/sections/AccountsPanel.ts': ['test/client-account-card-style.test.ts', 'test/client-dom.test.ts'],
  'src/client/sections/QuotaPanel.ts': ['test/client-account-card-style.test.ts'],
  'src/client/sections/SettingsSection.ts': ['test/client-render.test.ts', 'test/client-account-card-style.test.ts'],
  'src/client/sections/ModelsPanel.ts': ['test/client-render.test.ts'],
  'src/runtime/agy/db/extract.ts': ['test/agy-db.test.ts'],
  'src/runtime/agy/db/reader.ts': ['test/agy-db.test.ts'],
  'src/runtime/net/account-env.ts': ['test/account-env.test.ts'],
  'src/provider/account-selection.ts': ['test/host-branches.test.ts'],
  'src/common/config.ts': ['test/config-precedence.test.ts'],
  'src/common/types.ts': ['test/models.test.ts', 'test/rate-limit-classify.test.ts'],
}

function getGitChangedFiles() {
  const files = new Set()
  try {
    // 1. 暂存区改动
    const staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8' })
    for (const l of staged.split('\n')) if (l.trim()) files.add(l.trim())

    // 2. 工作区改动
    const unstaged = execSync('git diff --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8' })
    for (const l of unstaged.split('\n')) if (l.trim()) files.add(l.trim())

    // 3. 未跟踪新文件
    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' })
    for (const l of untracked.split('\n')) if (l.trim()) files.add(l.trim())
  } catch (err) {
    console.error('Git status error:', err.message)
  }
  return Array.from(files)
}

function resolveTargetTests(args) {
  const allTests = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`)
  const targets = new Set()

  // 1. 如果传了参数，优先按参数匹配
  if (args.length > 0) {
    for (const arg of args) {
      if (arg === '--all') {
        return allTests
      }
      // 精确匹配已有文件
      if (existsSync(join(ROOT, arg))) {
        targets.add(arg.startsWith('test/') ? arg : `test/${basename(arg)}`)
        continue
      }
      // 模糊匹配测试名称（如 "models" -> "test/models.test.ts"）
      const query = arg.toLowerCase().replace(/\.test\.ts$/, '').replace(/^test\//, '')
      const matched = allTests.filter((t) => t.toLowerCase().includes(query))
      if (matched.length > 0) {
        matched.forEach((m) => targets.add(m))
      }
    }
    return Array.from(targets)
  }

  // 2. 无参数时，自动根据 Git 变动推导
  const changedFiles = getGitChangedFiles()
  for (const file of changedFiles) {
    if (file.startsWith('test/') && file.endsWith('.test.ts')) {
      targets.add(file)
    } else if (COMPONENT_TEST_MAP[file]) {
      COMPONENT_TEST_MAP[file].forEach((t) => targets.add(t))
    } else if (file.startsWith('src/')) {
      // 默认模糊推导
      const base = basename(file).replace(/\.tsx?$/, '')
      const guess = `test/${base}.test.ts`
      if (existsSync(join(ROOT, guess))) {
        targets.add(guess)
      }
    }
  }

  return Array.from(targets)
}

const args = process.argv.slice(2)
const targets = resolveTargetTests(args)

if (targets.length === 0) {
  console.log('⚡ [Fast-Test] 工作区没有检测到任何代码变更。')
  console.log('💡 提示：可直接传参运行指定测试，例如：')
  console.log('   pnpm run test:fast models')
  console.log('   pnpm run test:fast reasoning')
  console.log('   pnpm run test:fast --all')
  process.exit(0)
}

console.log(`⚡ [Fast-Test] 极速内环命中 ${targets.length} 个相关测试:`)
targets.forEach((t) => console.log(`   - ${t}`))
console.log('')

const start = Date.now()
const res = spawnSync(
  'node',
  ['--experimental-transform-types', '--test', ...targets],
  { cwd: ROOT, stdio: 'inherit' },
)

const elapsed = ((Date.now() - start) / 1000).toFixed(2)
if (res.status === 0) {
  console.log(`\n✨ [Fast-Test] 全部通过！耗时: ${elapsed}s`)
} else {
  console.log(`\n❌ [Fast-Test] 存在失败用例。耗时: ${elapsed}s`)
}
process.exit(res.status ?? 1)

#!/usr/bin/env node
/**
 * fast-test.mjs — TDD 极速反馈运行器 (Fast TDD Loop)
 * 内环（TDD 极速环，0.3~3 秒）：
 * 1. 自动根据 Git 变更检测受影响的测试用例，秒级极速反馈；
 * 2. 支持精准模块/目录前缀映射，直接运行关联测试文件；
 * 3. 避免在红绿重构与日常开发中直接运行全量慢速测试套件。
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { globSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEST_DIR = join(ROOT, 'test')

const COMPONENT_TEST_MAP = {
  'src/index.ts': ['test/integration/lifecycle.test.ts', 'test/host/services.test.ts'],
  'src/host/services.ts': ['test/host/services.test.ts', 'test/transport/http-contract-*.test.ts'],
  'src/host/adapter.ts': ['test/provider/adapter-*.test.ts'],
  'src/host/models.ts': ['test/host/models.test.ts', 'test/domain/model-support-ineligibility.test.ts'],
  'src/host/quota.ts': ['test/features/quota/quota-*.test.ts', 'test/domain/domain-quota.test.ts'],
  'src/host/pool.ts': ['test/domain/pool.test.ts', 'test/host/pool-auth.test.ts'],
  'src/host/pool-auth.ts': ['test/host/pool-auth.test.ts', 'test/transport/http-contract-*.test.ts'],
  'src/host/oauth.ts': ['test/host/pool-auth.test.ts', 'test/features/quota/quota-*.test.ts'],
  'src/host/sessions.ts': ['test/host/sessions.test.ts'],
  'src/host/runner.ts': ['test/runtime/cross-platform.test.ts', 'test/runtime/proxy-keychain.test.ts'],
  'src/host/boot-hygiene.ts': ['test/runtime/boot-hygiene.test.ts'],
  'src/host/credential-slot.ts': ['test/host/credential-slot.test.ts', 'test/provider/issue101-slot-failover.test.ts'],
  'src/host/agy-log.ts': ['test/host/auth-jitter.test.ts', 'test/provider/failure-classifier.test.ts'],
  'src/host/agy-usage.ts': ['test/host/agy-usage.test.ts'],
  'src/host/parser.ts': ['test/host/parser.test.ts', 'test/provider/mapper.test.ts'],
  'src/host/mcp-bridge.ts': ['test/host/mcp-bridge-registry-and-agent.test.ts', 'test/host/mcp-ready-disposal.test.ts', 'test/host/mcp-bridge-call-id.test.ts'],
  'src/host/bridge-steps.ts': ['test/host/mcp-bridge-registry-and-agent.test.ts'],
  'src/host/media-route.ts': ['test/transport/media-route.test.ts'],
  'src/host/recording.ts': ['test/provider/adapter-*.test.ts'],
  'src/host/oneshot.ts': ['test/integration/v02.test.ts', 'test/features/quota/quota-failover-alignment.test.ts', 'test/features/image/slash-bridge-and-image-tool.test.ts', 'test/features/btw/btw.test.ts'],
  'src/host/btw-command.ts': ['test/features/btw/btw.test.ts'],
  'src/client/btw.ts': ['test/client/btw-client.test.ts'],
  'src/client/btw-card.ts': ['test/client/btw-client.test.ts'],
  'src/common/config.ts': ['test/common/config-precedence.test.ts'],
  'src/common/pool-types.ts': ['test/host/models.test.ts', 'test/domain/model-support-ineligibility.test.ts', 'test/domain/pool.test.ts'],
  'src/common/timeouts.ts': ['test/transport/route-guard.test.ts', 'test/client/client-api.test.ts'],
}

const PREFIX_TEST_MAP = [
  ['src/common/types/', ['test/provider/failure-classifier.test.ts', 'test/common/rate-limit-classify.test.ts', 'test/common/network-backoff.test.ts']],
  ['src/domain/accounts/', ['test/domain/pool.test.ts', 'test/domain/model-support-ineligibility.test.ts', 'test/domain/narrow-account-preference.test.ts']],
  ['src/domain/credentials/', ['test/host/credential-slot.test.ts', 'test/host/credential-backup.test.ts', 'test/provider/issue101-slot-failover.test.ts']],
  ['src/domain/quota/', ['test/domain/domain-quota.test.ts', 'test/features/quota/quota-*.test.ts', 'test/transport/status-argon-filter.test.ts']],
  ['src/features/quota/', ['test/features/quota/quota-*.test.ts', 'test/domain/domain-quota.test.ts']],
  ['src/features/warmup/', ['test/features/warmup/warmup.test.ts', 'test/transport/http-contract-*.test.ts']],
  ['src/features/translation/', ['test/features/translation/translate.test.ts']],
  ['src/features/btw/', ['test/features/btw/btw.test.ts']],
  ['src/features/image/', ['test/features/image/image.test.ts', 'test/features/image/image-cli.test.ts']],
  ['src/features/ecosystem/', ['test/features/ecosystem/ecosystem.test.ts', 'test/transport/http-contract-*.test.ts']],
  ['src/features/subagent/', ['test/features/subagent/subagent-tracker.test.ts']],
  ['src/provider/mapper/', ['test/provider/mapper.test.ts']],
  ['src/provider/mirror/', ['test/provider/mirror-tool.test.ts', 'test/client/run-code-view.test.ts']],
  ['src/provider/', ['test/provider/adapter-*.test.ts', 'test/provider/failure-classifier.test.ts', 'test/host/models.test.ts', 'test/host/host-branches.test.ts']],
  ['src/runtime/agy/db/', ['test/runtime/agy-db.test.ts', 'test/runtime/agy-db-extract.test.ts']],
  ['src/runtime/agy/', ['test/runtime/cross-platform.test.ts', 'test/runtime/proxy-keychain.test.ts', 'test/features/background/background-task-hang.test.ts', 'test/runtime/updater-preempt.test.ts']],
  ['src/runtime/net/', ['test/runtime/account-env.test.ts']],
  ['src/transport/http/', ['test/transport/http-contract-*.test.ts', 'test/transport/route-guard.test.ts', 'test/transport/media-route.test.ts']],
  ['src/host/commands/', ['test/integration/commands.test.ts', 'test/features/translation/tsl-command.test.ts', 'test/features/image/slash-bridge-and-image-tool.test.ts', 'test/features/ecosystem/ecosystem.test.ts']],
  ['src/client/images/', ['test/client/client-dom.test.ts', 'test/transport/media-route.test.ts']],
  ['src/client/toolview/', ['test/client/toolview.test.ts', 'test/client/run-code-view.test.ts']],
  ['src/client/sections/', ['test/client/client-render.test.ts', 'test/client/client-account-card-style.test.ts', 'test/client/catalog-rows.test.ts']],
  ['src/client/hooks/', ['test/client/client-api.test.ts', 'test/client/client-render.test.ts']],
  ['src/client/ui/', ['test/client/modal-overlay-isolation.test.ts', 'test/client/client-render.test.ts']],
]

function getGitChangedFiles() {
  const files = new Set()
  try {
    const staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8' })
    for (const l of staged.split('\n')) if (l.trim()) files.add(l.trim())

    const unstaged = execSync('git diff --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf8' })
    for (const l of unstaged.split('\n')) if (l.trim()) files.add(l.trim())

    const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ROOT, encoding: 'utf8' })
    for (const l of untracked.split('\n')) if (l.trim()) files.add(l.trim())
  } catch (err) {
    console.error('Git status error:', err.message)
  }
  return Array.from(files)
}

// Tests live in domain subdirectories (test/<domain>/<name>.test.ts), mirroring
// the source layering. Walk the tree instead of reading one flat directory.
function listAllTests(dir = TEST_DIR, prefix = 'test') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listAllTests(join(dir, entry.name), rel))
    else if (entry.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

/**
 * Expand mapping entries: they may name one file or a glob
 * (`test/provider/adapter-*.test.ts`), because a suite is allowed to be split
 * across several files in its domain directory.
 */
function expandTargets(entries, out) {
  for (const entry of entries) {
    if (!entry.includes('*')) {
      if (existsSync(join(ROOT, entry))) out.add(entry)
      continue
    }
    for (const hit of globSync(entry, { cwd: ROOT })) out.add(hit)
  }
}

/** Locate a test by bare basename anywhere under test/ (domain-agnostic). */
function findByBasename(allTests, name) {
  const base = basename(name)
  return allTests.find((t) => t.endsWith(`/${base}`)) ?? null
}

function resolveTargetTests(args) {
  const allTests = listAllTests()
  const targets = new Set()

  if (args.length > 0) {
    for (const arg of args) {
      if (arg === '--all') return allTests
      if (existsSync(join(ROOT, arg))) {
        targets.add(arg.startsWith('test/') ? arg : `test/${basename(arg)}`)
        continue
      }
      const query = arg.toLowerCase().replace(/\.test\.ts$/, '').replace(/^test\//, '')
      for (const m of allTests.filter((t) => t.toLowerCase().includes(query))) {
        targets.add(m)
      }
    }
    return Array.from(targets)
  }

  for (const file of getGitChangedFiles()) {
    if (file.startsWith('test/') && file.endsWith('.test.ts')) {
      targets.add(file)
      continue
    }
    if (COMPONENT_TEST_MAP[file]) expandTargets(COMPONENT_TEST_MAP[file], targets)
    for (const [prefix, mapped] of PREFIX_TEST_MAP) {
      if (file.startsWith(prefix)) expandTargets(mapped, targets)
    }
    if (file.startsWith('src/')) {
      const base = basename(file).replace(/\.tsx?$/, '')
      const guess = findByBasename(allTests, `${base}.test.ts`)
      if (guess !== null) targets.add(guess)
    }
  }

  return Array.from(targets)
}

const args = process.argv.slice(2)
const targets = resolveTargetTests(args)

if (targets.length === 0) {
  console.log('⚡ [Fast-Test] 工作区没有检测到任何代码变更。')
  console.log('💡 提示：可直接传参运行指定测试，例如：')
  console.log('   npm run test:fast models')
  console.log('   npm run test:fast warmup')
  console.log('   npm run test:fast --all')
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

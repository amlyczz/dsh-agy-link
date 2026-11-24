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
import { basename, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const TEST_DIR = join(ROOT, 'test')

const COMPONENT_TEST_MAP = {
  'src/index.ts': ['test/lifecycle.test.ts', 'test/services.test.ts'],
  'src/host/services.ts': ['test/services.test.ts', 'test/http-contract.test.ts'],
  'src/host/adapter.ts': ['test/adapter.test.ts'],
  'src/host/models.ts': ['test/models.test.ts', 'test/model-support-ineligibility.test.ts'],
  'src/host/quota.ts': ['test/quota.test.ts', 'test/domain-quota.test.ts'],
  'src/host/pool.ts': ['test/pool.test.ts', 'test/pool-auth.test.ts'],
  'src/host/pool-auth.ts': ['test/pool-auth.test.ts', 'test/http-contract.test.ts'],
  'src/host/oauth.ts': ['test/pool-auth.test.ts', 'test/quota.test.ts'],
  'src/host/sessions.ts': ['test/sessions.test.ts'],
  'src/host/runner.ts': ['test/cross-platform.test.ts', 'test/proxy-keychain.test.ts'],
  'src/host/boot-hygiene.ts': ['test/boot-hygiene.test.ts'],
  'src/host/credential-slot.ts': ['test/credential-slot.test.ts', 'test/issue101-slot-failover.test.ts'],
  'src/host/agy-log.ts': ['test/auth-jitter.test.ts', 'test/failure-classifier.test.ts'],
  'src/host/agy-usage.ts': ['test/agy-usage.test.ts'],
  'src/host/parser.ts': ['test/parser.test.ts', 'test/mapper.test.ts'],
  'src/host/mcp-bridge.ts': ['test/mcp-bridge-registry-and-agent.test.ts', 'test/mcp-ready-disposal.test.ts'],
  'src/host/media-route.ts': ['test/media-route.test.ts'],
  'src/host/recording.ts': ['test/adapter.test.ts'],
  'src/host/oneshot.ts': ['test/v02.test.ts', 'test/quota-failover-alignment.test.ts', 'test/slash-bridge-and-image-tool.test.ts', 'test/btw.test.ts'],
  'src/host/btw-command.ts': ['test/btw.test.ts'],
  'src/client/btw.ts': ['test/btw-client.test.ts'],
  'src/client/btw-card.ts': ['test/btw-client.test.ts'],
  'src/common/config.ts': ['test/config-precedence.test.ts'],
  'src/common/pool-types.ts': ['test/models.test.ts', 'test/model-support-ineligibility.test.ts', 'test/pool.test.ts'],
  'src/common/timeouts.ts': ['test/route-guard.test.ts', 'test/client-api.test.ts'],
}

const PREFIX_TEST_MAP = [
  ['src/common/types/', ['test/failure-classifier.test.ts', 'test/rate-limit-classify.test.ts', 'test/network-backoff.test.ts']],
  ['src/domain/accounts/', ['test/pool.test.ts', 'test/model-support-ineligibility.test.ts']],
  ['src/domain/credentials/', ['test/credential-slot.test.ts', 'test/credential-backup.test.ts', 'test/issue101-slot-failover.test.ts']],
  ['src/domain/quota/', ['test/domain-quota.test.ts', 'test/quota.test.ts', 'test/status-argon-filter.test.ts']],
  ['src/features/quota/', ['test/quota.test.ts', 'test/domain-quota.test.ts']],
  ['src/features/warmup/', ['test/warmup.test.ts', 'test/http-contract.test.ts']],
  ['src/features/translation/', ['test/translate.test.ts']],
  ['src/features/btw/', ['test/btw.test.ts']],
  ['src/features/image/', ['test/image.test.ts', 'test/image-cli.test.ts']],
  ['src/features/ecosystem/', ['test/ecosystem.test.ts', 'test/http-contract.test.ts']],
  ['src/features/subagent/', ['test/subagent-tracker.test.ts']],
  ['src/provider/mapper/', ['test/mapper.test.ts']],
  ['src/provider/mirror/', ['test/mirror-tool.test.ts', 'test/run-code-view.test.ts']],
  ['src/provider/', ['test/adapter.test.ts', 'test/failure-classifier.test.ts', 'test/models.test.ts', 'test/host-branches.test.ts']],
  ['src/runtime/agy/db/', ['test/agy-db.test.ts', 'test/agy-db-extract.test.ts']],
  ['src/runtime/agy/', ['test/cross-platform.test.ts', 'test/proxy-keychain.test.ts', 'test/background-task-hang.test.ts', 'test/updater-preempt.test.ts']],
  ['src/runtime/net/', ['test/account-env.test.ts']],
  ['src/transport/http/', ['test/http-contract.test.ts', 'test/route-guard.test.ts', 'test/media-route.test.ts']],
  ['src/host/commands/', ['test/commands.test.ts', 'test/tsl-command.test.ts', 'test/slash-bridge-and-image-tool.test.ts', 'test/ecosystem.test.ts']],
  ['src/client/images/', ['test/client-dom.test.ts', 'test/media-route.test.ts']],
  ['src/client/toolview/', ['test/toolview.test.ts', 'test/run-code-view.test.ts']],
  ['src/client/sections/', ['test/client-render.test.ts', 'test/client-account-card-style.test.ts', 'test/catalog-rows.test.ts']],
  ['src/client/hooks/', ['test/client-api.test.ts', 'test/client-render.test.ts']],
  ['src/client/ui/', ['test/modal-overlay-isolation.test.ts', 'test/client-render.test.ts']],
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

function resolveTargetTests(args) {
  const allTests = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`)
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
    if (COMPONENT_TEST_MAP[file]) {
      for (const t of COMPONENT_TEST_MAP[file]) if (existsSync(join(ROOT, t))) targets.add(t)
    }
    for (const [prefix, mapped] of PREFIX_TEST_MAP) {
      if (file.startsWith(prefix)) {
        for (const t of mapped) if (existsSync(join(ROOT, t))) targets.add(t)
      }
    }
    if (file.startsWith('src/')) {
      const base = basename(file).replace(/\.tsx?$/, '')
      const guess = `test/${base}.test.ts`
      if (existsSync(join(ROOT, guess))) targets.add(guess)
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

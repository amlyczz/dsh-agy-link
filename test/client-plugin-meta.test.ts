import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zh, en, es, ptBR } from '../src/client/locales.ts';

const root = join(fileURLToPath(import.meta.url), '..', '..');

// The DSH host (dsh-app-boot readPluginMeta/iconOf) enforces these contract
// points; failing any of them degrades the plugin card to its default artwork
// or an error string, so they are pinned here.

test('package.json icon is a relative in-package SVG under the 256 KiB host cap', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const icon: unknown = pkg.icon;
  assert.equal(typeof icon, 'string', 'icon field must be a string');
  const iconPath = icon as string;
  assert.equal(isAbsolute(iconPath), false, 'icon must be a relative path');
  assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/.test(iconPath), false, 'icon must not be a URL/protocol path');
  assert.equal(extname(iconPath).toLowerCase(), '.svg', 'icon must be SVG');
  const resolved = join(root, iconPath);
  assert.equal(resolved.startsWith(root), true, 'icon must stay inside the package');
  const stat = statSync(resolved);
  assert.equal(stat.isFile(), true, 'icon must be a regular file');
  assert.ok(stat.size <= 256 * 1024, `icon exceeds 256 KiB host cap (${stat.size} bytes)`);
  const svg = readFileSync(resolved, 'utf8');
  assert.match(svg, /<svg[^>]*viewBox=/, 'icon must carry a viewBox');
});

test('package.json exports and files expose the locale meta directory', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.ok((pkg.files as string[]).includes('locale'));
});

test('locale meta files parse with non-empty meta.title and meta.description', () => {
  const dir = join(root, 'locale');
  const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.ok(names.includes('en.json'), 'en.json is the anchor the host resolves first');
  assert.ok(names.includes('zh.json'), 'zh.json serves the primary user locale');
  for (const name of names) {
    const lang = name.slice(0, -5);
    assert.match(lang, /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i, `${name} must use a language id as its filename`);
    const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    assert.equal(typeof parsed?.meta?.title, 'string', `${name}: meta.title must be a string`);
    assert.ok(parsed.meta.title.trim().length > 0, `${name}: meta.title must be non-empty`);
    assert.equal(typeof parsed?.meta?.description, 'string', `${name}: meta.description must be a string`);
    assert.ok(parsed.meta.description.trim().length > 0, `${name}: meta.description must be non-empty`);
  }
});

test('console dictionary keys exist in every shipped language', () => {
  const languages: Record<string, Record<string, string>> = { zh, en, es, ptBR };
  const required = [
    'console.title', 'status.ready', 'status.needsAuth', 'account.add',
    'header.refreshQuota', 'quota.fiveHour', 'quota.weekly', 'permission.label',
    'config.defaultEffort', 'config.defaultEffortDesc',
    'effort.auto', 'effort.low', 'effort.medium', 'effort.high',
    'config.translateModel', 'config.translateModelDesc', 'config.translateModelAuto',
    'config.translateEffort', 'config.translateEffortDesc', 'config.translateEffortAuto',
    'config.image', 'config.imageDesc', 'config.imageModel', 'config.imageModelDesc',
    'config.imageEffort', 'config.imageEffortDesc', 'config.imageCopy', 'config.imageCopied',
    'config.imageCopyFailed',
    'config.showHeaderBadge', 'config.showHeaderBadgeDesc',
    'config.showTranslateAction', 'config.showTranslateActionDesc',
    'config.poolWideCatalog', 'config.poolWideCatalogDesc',
  ];
  for (const [lang, dict] of Object.entries(languages)) {
    for (const key of required) {
      assert.ok(typeof dict[key] === 'string' && dict[key]!.length > 0, `${lang} is missing "${key}"`);
    }
  }
});

test('settings panel keeps the default thinking-effort row', () => {
  // The row is the seed for the session model menu; it was dropped once and must
  // stay: the model menu can still override it per model. The level buttons are
  // now BUILT from the catalog (no hardcoded high/medium/low literals), so we
  // assert the writer receives the level variable plus the explicit "auto".
  const source = readFileSync(join(root, 'dist', 'client.js'), 'utf8');
  assert.match(source, /config\.defaultEffort/)
  assert.match(source, /setCfg\(["']defaultEffort["'],\s*["']['"]\)/)
  assert.match(source, /setCfg\(["']defaultEffort["'],\s*[A-Za-z_$][\w$]*\)/)
  // No hardcoded level buttons may remain.
  assert.doesNotMatch(source, /setCfg\(["']defaultEffort["'],\s*["'](?:low|medium|high|xhigh|max)["']\)/)
});

test('settings row exposes translation model and effort as dropdowns', () => {
  // Both writes ride the same /config endpoint as the toggles, and the selects
  // are fed by the pure option builders: the catalog is advisory, so a
  // configured-but-unlisted model id must stay selectable.
  const source = readFileSync(join(root, 'dist', 'client.js'), 'utf8');
  assert.match(source, /setCfg\(["']translateModel["']/)
  assert.match(source, /setCfg\(["']translateEffort["']/)
  assert.match(source, /translateModelOptions\(/)
  assert.match(source, /translateEffortOptions\(/)
  assert.match(source, /className: ["']agy-select["']/)
  // The two selects sit in the auto-translate row, not in a separate section.
  assert.match(source, /config\.autoTranslate/)
  assert.match(source, /cfgRowRight/)
});


test('settings row exposes image generation model/effort and the CLI command', () => {
  const source = readFileSync(join(root, 'dist', 'client.js'), 'utf8');
  assert.match(source, /setCfg\(["']imageModel["']/);
  assert.match(source, /setCfg\(["']imageEffort["']/);
  assert.match(source, /config\.image/);
  assert.match(source, /dsh-agy-image/);
  assert.match(source, /config\.imageCopy/);
});

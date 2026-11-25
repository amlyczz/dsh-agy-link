import '../helpers/client-render.ts'
import { React, renderToStaticMarkup } from '../helpers/client-render.ts'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { defaultConfig } from '../../src/common/types/config.ts'
import { defaultPoolData } from '../../src/common/pool-types.ts'
import { zh } from '../../src/client/locales/zh.ts'
import { en } from '../../src/client/locales/en.ts'
import { es } from '../../src/client/locales/es.ts'
import { ptBR } from '../../src/client/locales/ptBR.ts'
import { renderConsoleTabContent, type ConsoleTabId, type ConsoleTabsProps } from '../../src/client/sections/ConsoleTabs.ts'
import { createSettingsSection, resetConsoleTabForTest } from '../../src/client/sections/SettingsSection.ts'
import { disposeStatusPolling, publishStatusSnapshot } from '../../src/client/status.ts'
import type { StatusPayload } from '../../src/client/status.ts'

const nodeRequire = createRequire(import.meta.url)
const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html?: string, opts?: Record<string, unknown>) => any }
const ReactDOMClient = nodeRequire('react-dom/client') as any
const testUtils = nodeRequire('react-dom/test-utils') as any
const createElement = (React as { createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown }).createElement

function makeTranslator(dict: Record<string, string>) {
	return ((key: string, vars?: Record<string, string | number>) => {
		const raw = dict[key] ?? key
		return vars ? raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')) : raw
	}) as never
}

function baseStatus(): StatusPayload {
	const cfg = defaultConfig()
	return {
		...cfg,
		version: '0.6.76',
		auth: { phase: 'ok' },
		pool: {
			...defaultPoolData(),
			accounts: [
				{
					id: 'acc_primary',
					alias: 'Primary',
					dir: '',
					enabled: true,
					createdAt: 1,
					cooldowns: {},
					quotas: { google: { remainingFraction: 0.9, updatedAt: Date.now() } },
				},
			],
		},
		catalogModels: [
			{ id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
			{ id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
			{ id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)' },
		],
		accountModels: {},
		quotaRefreshing: [],
		warmupState: null,
		hiddenModels: [],
		selectedModels: [],
		acpStatus: { activeProcesses: 1, sessions: 1, keys: [] },
	} as unknown as StatusPayload
}

function baseTabProps(tab: ConsoleTabId, dict: Record<string, string> = zh): ConsoleTabsProps {
	const status = baseStatus()
	return {
		t: makeTranslator(dict),
		activeTab: tab,
		onSelectTab: () => {},
		status,
		pool: status.pool,
		accounts: status.pool?.accounts ?? [],
		accountModels: status.accountModels,
		catalogModels: status.catalogModels ?? [],
		hiddenModelSet: new Set(),
		selectedModelSet: new Set(),
		loadingAction: null,
		effortLabels: { auto: 'auto', level: (x) => x },
		addAccountSection: null,
		proxyInputs: {},
		setProxyInputs: () => {},
		editingProxyId: null,
		setEditingProxyId: () => {},
		aliasInputs: {},
		setAliasInputs: () => {},
		editingAliasId: null,
		setEditingAliasId: () => {},
		expandedModels: {},
		toggleExpand: () => {},
		optimisticActiveByFamily: {},
		accountHandlers: {
			moveAccount: async () => {},
			setActiveAccount: async () => {},
			beginReauth: async () => {},
			removeAccount: async () => {},
			toggleAccountEnabled: async () => {},
			refreshQuota: async () => {},
			warmupAccount: async () => {},
			saveProxy: async () => {},
			saveAlias: async () => {},
			clearCooldown: async () => {},
		},
		setCfg: async () => {},
		setMode: async () => {},
		setSelectedModels: async () => {},
		setHiddenModels: async () => {},
		copyImageCommand: () => {},
		showToast: () => {},
	}
}

test('console tabs separate accounts, models/orchestrator, features, and runtime/ecosystem cleanly', () => {
	// 1. Accounts tab: shows account pool + schedule/warmup card, keeps other tabs out
	const accountsHtml = renderToStaticMarkup(createElement('div', null, renderConsoleTabContent(baseTabProps('accounts'))))
	assert.ok(accountsHtml.includes('role="tablist"'))
	assert.ok(accountsHtml.includes('账号池 (1)'))
	assert.ok(accountsHtml.includes(zh['section.poolSchedule']))
	assert.ok(accountsHtml.includes(zh['config.warmupWindows']))
	assert.equal(accountsHtml.includes(zh['config.orchestratorPlanner']), false)
	assert.equal(accountsHtml.includes(zh['config.permissionMode']), false)

	// 2. Models tab: shows poolWideCatalog + model chips + defaultEffort + Orchestrator
	const modelsHtml = renderToStaticMarkup(createElement('div', null, renderConsoleTabContent(baseTabProps('models'))))
	assert.ok(modelsHtml.includes(zh['section.modelCatalog']))
	assert.ok(modelsHtml.includes('Gemini 4 Neon'))
	assert.ok(modelsHtml.includes(zh['section.thinkingOrchestrator']))
	assert.ok(modelsHtml.includes(zh['config.orchestratorPlanner']))
	assert.equal(modelsHtml.includes(zh['config.autoTranslate']), false)

	// 3. Features tab: groups translation + image + UI display together
	const featuresHtml = renderToStaticMarkup(createElement('div', null, renderConsoleTabContent(baseTabProps('features'))))
	assert.ok(featuresHtml.includes(zh['section.translation']))
	assert.ok(featuresHtml.includes(zh['config.autoTranslate']))
	assert.ok(featuresHtml.includes(zh['config.showTranslateAction']))
	assert.ok(featuresHtml.includes(zh['section.imageGen']))
	assert.ok(featuresHtml.includes('dsh-agy-image'))
	assert.ok(featuresHtml.includes(zh['config.imageTool']))
	assert.ok(featuresHtml.includes(zh['section.btw']))
	assert.ok(featuresHtml.includes(zh['config.btw']))
	assert.ok(featuresHtml.includes(zh['section.uiDisplay']))
	assert.ok(featuresHtml.includes(zh['config.showHeaderBadge']))

	// 4. Runtime tab: execution controls + ecosystem sync + EcosystemPanel (no duplicate imageTool)
	const runtimeHtml = renderToStaticMarkup(createElement('div', null, renderConsoleTabContent(baseTabProps('runtime'))))
	assert.ok(runtimeHtml.includes(zh['section.execution']))
	assert.ok(runtimeHtml.includes(zh['config.permissionMode']))
	assert.ok(runtimeHtml.includes(zh['config.transport']))
	assert.ok(runtimeHtml.includes(zh['section.ecosystem']))
	assert.ok(runtimeHtml.includes(zh['config.syncCustomizations']))
	assert.ok(runtimeHtml.includes(zh['eco.heading']))
	assert.equal(runtimeHtml.includes(zh['config.imageTool']), false)

	// 5. All 4 locales define every new tab & section key
	const keys = [
		'tab.accounts', 'tab.models', 'tab.features', 'tab.runtime',
		'section.poolSchedule', 'section.warmupSettings', 'section.modelCatalog',
		'section.thinkingOrchestrator', 'section.translation', 'section.imageGen',
		'section.btw', 'config.btw', 'config.btwDesc', 'config.btwModel', 'config.btwModelDesc', 'config.btwEffort', 'config.btwEffortDesc',
		'section.uiDisplay', 'section.execution', 'section.ecosystem',
	] as const
	for (const dict of [zh, en, es, ptBR]) {
		for (const k of keys) {
			assert.ok(typeof dict[k] === 'string' && dict[k].length > 0, `missing locale key ${k}`)
		}
	}
})

test('SettingsSection switches tabs interactively, remembers selection, and jumps to accounts when adding', async () => {
	resetConsoleTabForTest()
	const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
	const prevDoc = (globalThis as any).document
	const prevWin = (globalThis as any).window
	const prevAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
	;(globalThis as any).document = dom.window.document
	;(globalThis as any).window = dom.window
	;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
	const prevFetch = globalThis.fetch
	Object.defineProperty(globalThis, 'fetch', {
		configurable: true,
		writable: true,
		value: async (url: string) => {
			if (url.includes('/ecosystem')) {
				return { ok: true, status: 200, json: async () => ({ ok: true, primaryHome: '/h', plugins: [], mcpServers: [], skills: [], rules: [], agents: [], syncedAccountCount: 0, lastSyncAt: null }) }
			}
			return { ok: true, status: 200, json: async () => baseStatus() }
		},
	})
	publishStatusSnapshot(baseStatus() as never)

	const locale = {
		bind: () => makeTranslator(en),
		subscribe: () => () => {},
	}
	const AgySettingsSection = createSettingsSection(locale as never)
	const container = dom.window.document.createElement('div')
	dom.window.document.body.appendChild(container)
	const root = ReactDOMClient.createRoot(container)
	try {
		await testUtils.act(async () => {
			root.render(createElement(AgySettingsSection as never))
			await new Promise((r) => setTimeout(r, 15))
		})
		const modelsTabBtn = container.querySelector('[data-tab="models"]') as HTMLButtonElement | null
		assert.ok(modelsTabBtn)
		await testUtils.act(async () => { modelsTabBtn.click() })
		assert.equal(modelsTabBtn.getAttribute('aria-selected'), 'true')
		assert.ok((container.textContent ?? '').includes(en['section.thinkingOrchestrator']))

		// Unmount + remount remembers the selected tab
		await testUtils.act(async () => { root.unmount() })
		const root2 = ReactDOMClient.createRoot(container)
		await testUtils.act(async () => {
			root2.render(createElement(AgySettingsSection as never))
			await new Promise((r) => setTimeout(r, 15))
		})
		assert.equal(container.querySelector('[data-tab="models"]')?.getAttribute('aria-selected'), 'true')

		// Clicking "+ Add Google account" automatically returns to the accounts tab
		const addBtn = Array.from(container.querySelectorAll('button')).find((b: any) => (b.textContent ?? '').includes(en['account.add'])) as HTMLButtonElement | undefined
		assert.ok(addBtn)
		await testUtils.act(async () => { addBtn.click() })
		assert.equal(container.querySelector('[data-tab="accounts"]')?.getAttribute('aria-selected'), 'true')
		assert.ok((container.textContent ?? '').includes(en['auth.openBrowser']))
		await testUtils.act(async () => { root2.unmount() })
	} finally {
		disposeStatusPolling()
		resetConsoleTabForTest()
		Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: prevFetch })
		;(globalThis as any).document = prevDoc
		;(globalThis as any).window = prevWin
		;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = prevAct
		dom.window.close()
	}
})

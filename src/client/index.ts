// dsh-agy-link client half (browser). Integrated into native DSH settings, sidebar footer, and header.
//
// This file is WIRING ONLY: inject the stylesheet, register the locale
// dictionaries, mount the extracted sections, and install the conversation
// enhancers. The UI lives in ./sections, the primitives in ./ui, the action
// handlers in ./hooks.
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import { en, es, NS, ptBR, zh } from './locales.ts';
import { installAgyToolView } from './toolview.ts';
import { installMermaidRendering } from './mermaid.ts';
import { installAutoExpandReasoning } from './reasoning.ts';
import { installImageEnhancer, setClientContext } from './images.ts';
import { installAgentEmbedRenderer } from './embed.ts';
import { installDecisionChips } from './decisions.ts';
import { installTranslationUi } from './translate.ts';
import { installAcpCards } from './acp-notice.ts';
import { installBtwUi } from './btw.ts';
import { installCompactionCard } from './compaction.ts';
import { ensureScrollListener, disposeScrollListener, setOverlaySuspended } from './scroll-guard.ts';
import { installSettingsNavIcon } from './icons.ts';
import { disposeStatusPolling, ensureStatusPolling } from './status.ts';
import { injectGlobalStyles } from './styles.ts';
import { agyModalStore } from './ui/Modal.ts';
import { createSettingsSection } from './sections/SettingsSection.ts';
import { createSessionStatus } from './sections/SessionStatus.ts';
import type { LocaleLike } from './hooks/useTranslation.ts';
import { bindTranslator } from './i18n-bridge.ts';

export const name = 'dsh-agy-link-client';
// Cordis inject entries are hard dependencies: accessing a service not listed
// here throws ("cannot get property X without inject"). locale must be declared
// for ctx.locale to be readable (issue #24). dsh-web-app ships dsh-client-locale.
export const inject = ['slots', 'locale'];

export interface ClientContext extends Context {
	slots: {
		inject(name: string, register: () => () => void): void;
		register(
			// `id` for list slots (settings.section entries), `key` for keyed
			// slots (plugins.bundle.config is keyed by package name).
			opts: { name: string; key?: string; id?: string; order?: number; label?: string | (() => string); locale?: string },
			Component: (props?: unknown) => unknown,
		): () => void;
	};
}

export function apply(ctx: ClientContext): void {
	setClientContext(ctx);
	injectGlobalStyles();
	ctx.effect(() => {
		ensureStatusPolling();
		return () => {
			disposeStatusPolling();
		};
	}, 'agy-link: status polling');
	// locale is declared in inject — cordis guarantees ctx.locale (issue #24).
	const locale = ctx.locale;
	// One translator binding for the whole client surface: the DOM enhancers
	// (image scanner, lightbox, decision chips, mermaid, compaction, toolview
	// cards) are not React components and several have no ctx of their own
	// (issue #153).
	bindTranslator(ctx);
	ctx.effect(() => {
		const safeAddLanguage = (lang: { id: string; label: string; fallback: string }) => {
			try {
				const snapshotLocales = typeof locale?.getSnapshot === 'function' ? locale.getSnapshot()?.locales : undefined;
				const list = Array.isArray(snapshotLocales)
					? snapshotLocales
					: typeof (locale as any)?.localeList === 'function'
						? (locale as any).localeList()
						: [];
				if (Array.isArray(list) && list.some((l: { id?: string }) => l?.id?.toLowerCase() === lang.id.toLowerCase())) {
					return () => {};
				}
				return locale.addLanguage(lang);
			} catch (err: unknown) {
				const message = String((err as any)?.message || err);
				if (/already registered/i.test(message)) {
					return () => {};
				}
				throw err;
			}
		};

		const safeRegister = (ns: string, langOrDicts: string | Record<string, Record<string, string>>, dict?: Record<string, string>) => {
			try {
				return locale.register(ns, langOrDicts as any, dict as any);
			} catch (err: unknown) {
				const message = String((err as any)?.message || err);
				if (/already has locale/i.test(message)) {
					return () => {};
				}
				throw err;
			}
		};

		const disposePtBR = safeAddLanguage({ id: 'pt-BR', label: 'Português (Brasil)', fallback: 'en' });
		const disposeEs = safeAddLanguage({ id: 'es', label: 'Español', fallback: 'en' });
		// Untyped single-locale form: 'agy-link' is not in the host LocaleNamespaceMap merge table.
		const disposeZh = safeRegister(NS, 'zh', zh);
		const disposeEn = safeRegister(NS, 'en', en);
		const disposePtBRDictionary = safeRegister(NS, 'pt-BR', ptBR);
		const disposeEsDictionary = safeRegister(NS, 'es', es);
		return () => { disposeEsDictionary(); disposePtBRDictionary(); disposeEn(); disposeZh(); disposeEs(); disposePtBR(); };
	}, 'agy-link: locale dictionaries');

	const AgySettingsSection = createSettingsSection(locale as unknown as LocaleLike);
	const AgySessionStatus = createSessionStatus(locale as unknown as LocaleLike, AgySettingsSection as never);

	// Register in header session toolbar
	ctx.slots.inject('conversation.session.header.actions', () => {
		const dispose = ctx.slots.register(
			{
				name: 'conversation.session.header.actions',
				id: 'agy-link-status',
				order: 10,
				label: () => locale.bind(NS)('section.label'),
				locale: NS,
				// The header component needs the session id to scope subagents.
				// `inject` is supported by the slot runtime but missing from this
				// bundle's TS surface, so spread it past the excess-property check.
				...({ inject: (sessionId: string) => ({ sessionId }) } as Record<string, unknown>),
			},
			AgySessionStatus,
		);
		return dispose;
	});

	// Register in settings section (under Gear icon -> Antigravity)
	ctx.slots.inject('settings.section', () => {
		const dispose = ctx.slots.register(
			{
				name: 'settings.section',
				id: 'agy-link',
				order: 20,
				label: () => locale.bind(NS)('section.label'),
				locale: NS,
			},
			AgySettingsSection as (props?: unknown) => unknown,
		);
		return dispose;
	});

	// Plugins page (sidebar → 插件 → dsh-agy-link): the bundle's detail panel.
	// Directly reuses the identical Antigravity management console (AgySettingsSection),
	// providing 100% feature parity and zero redundancy.
	// When view === "summary", returns null to keep plugin list cards compact and clean.
	ctx.slots.inject('plugins.bundle.config', () => {
		const dispose = ctx.slots.register(
			{ name: 'plugins.bundle.config', key: 'dsh-agy-link', locale: NS },
			(ownerProps?: unknown) => {
				const view = (ownerProps as { view?: string } | undefined)?.view;
				if (view === 'summary') return null;
				return AgySettingsSection({ isModal: false });
			},
		);
		return dispose;
	});

	// Also register row config for the agy-link row, so clicking through row
	// items renders the identical Antigravity management console.
	ctx.slots.inject('plugins.row.config', () => {
		const dispose = ctx.slots.register(
			{ name: 'plugins.row.config', key: 'dsh-agy-link#agy-link', locale: NS },
			(ownerProps?: unknown) => {
				const view = (ownerProps as { view?: string } | undefined)?.view;
				if (view === 'summary') return null;
				return AgySettingsSection({ isModal: false });
			},
		);
		return dispose;
	});

	// Global scroll activity coordinator: suppresses layout-shifting DOM mutations during scrolling,
	// and (via the same guard) while the console overlay owns the screen.
	ctx.effect(() => {
		ensureScrollListener();
		return () => {
			disposeScrollListener();
			// A plugin reload while the console was open must not leave the page
			// permanently scroll-locked (setOpen(false) never runs on teardown).
			agyModalStore.open = false;
			setOverlaySuspended(false);
			if (typeof document !== 'undefined' && document.documentElement) {
				document.documentElement.classList.remove('agy-modal-open');
			}
		};
	});

	// Native tool-card rendering for the agy_tool mirror (DSH >= 0.1.5):
	// the browser conversation UI keys tool cards by wire name; registering
	// `tool.call.toolview` for `agy_tool` makes every mirrored agy step render
	// as a terminal / diff / read / search card instead of a generic text row.
	try {
		installAgyToolView(ctx);
	} catch (err) {
		console.warn('[dsh-agy-link] agy tool view registration failed:', err);
	}

	// Auto-expand reasoning blocks containing full model thought prose.
	// Installed through ctx.effect so a plugin reload DISCONNECTS the old
	// MutationObserver instead of stacking one observer per reload.
	ctx.effect(() => installAutoExpandReasoning());

	// Draw ```mermaid fences (DSH's shiki pass has no mermaid grammar and
	// leaves them as plain code blocks). Same lifecycle contract as above.
	ctx.effect(() => installMermaidRendering());

	// Local image display + fullscreen lightbox + native right-sidebar file opener.
	ctx.effect(() => installImageEnhancer(ctx));

	// Generative UI (<agent-embed>) sandboxed HTML widget renderer.
	ctx.effect(() => installAgentEmbedRenderer());

	// Interactive user decision & choice chips (recovered working tree).
	ctx.effect(() => installDecisionChips());

	// Interactive compaction card (DeepSeek Flash native visual parity + token delta metrics).
	ctx.effect(() => installCompactionCard());

	// Gemini plain-language translation: the persisted record card plus the
	// per-reply "译成人话" action. Contained: a host that lacks uiConversation
	// or the chat slots must keep every other plugin contribution (header badge,
	// settings, toolviews) alive instead of failing the whole client apply.
	// ACP channel cards: the transport keeps narrating after a turn ends, so the
	// host persists those frames as plugin records and these Definitions project
	// them into the conversation without spending a model turn. They live inside
	// the translation effect because both project persisted records into the chat:
	// a host that registers conversation Definitions once must not be asked twice.
	// (Splitting them into a second effect doubled the registered chat-node slots
	// and the locale lifecycle test rightly caught it.)
	ctx.effect(() => {
		try {
			const dispose = installTranslationUi(ctx as never, NS);
			let disposeAcp = () => {};
			try {
				disposeAcp = installAcpCards(ctx as never, NS);
			} catch (e) {
				console.warn('[dsh-agy-link] ACP cards unavailable:', e);
			}
			let disposeBtw = () => {};
			try {
				disposeBtw = installBtwUi(ctx as never, NS);
			} catch (e) {
				console.warn('[dsh-agy-link] btw UI unavailable:', e);
			}
			return () => {
				disposeBtw();
				disposeAcp();
				dispose();
			};
		} catch (e) {
			console.warn('[dsh-agy-link] translation UI unavailable:', e);
			return () => {};
		}
	});

	// Custom Antigravity brand icon inside Settings dialog nav list
	ctx.effect(() => installSettingsNavIcon(ctx, () => locale.bind(NS)('section.label')));
}

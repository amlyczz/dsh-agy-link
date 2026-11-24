// BtwCard — DSH-native dismissible side-question card docked above the composer.
//
// Visual tokens mirror DSH's GoalBar + ToolCard: `--dsh-composer-side-clearance`,
// `--dsh-composer-dock-inset`, `--dsh-composer-card-max-width`, `--dsw-specific-menu`,
// `--dsw-menu-backdrop-filter`, `--dsw-elevation-panel`, `--dsw-alias-border-l1`,
// and `--dsw-radius-md`. Long answers clamp inside `.agy-btw-body` so the main
// composer and footer hints are never pushed off-screen.

import type { BtwEntry, BtwSessionView, BtwToolStep } from '../common/btw-types.ts'
import { win } from './api.ts'
import { BRAND_PATHS } from './brand-icons.ts'
import { translateOr } from './i18n-bridge.ts'
import { h, useState } from './react.ts'
import { renderMarkdown } from './translate-card.ts'

export const BTW_STYLE_ID = 'dsh-agy-link-btw-css-v1'

const BTW_CSS = `
.agy-btw-dock {
  box-sizing: border-box;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance, 0px) -
    var(--dsh-composer-side-clearance, 0px) -
    var(--dsh-composer-dock-inset, 0px) -
    var(--dsh-composer-dock-inset, 0px) -
    var(--dsh-composer-dock-inset, 0px) -
    var(--dsh-composer-dock-inset, 0px)
  );
  max-width: calc(var(--dsh-composer-card-max-width, 760px) - 4 * var(--dsh-composer-dock-inset, 0px));
  margin: 0 auto 6px auto;
}
.agy-btw-card {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .24));
  border-radius: var(--dsw-radius-md, 12px);
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, .12));
  background: var(--dsw-specific-menu, var(--dsw-alias-markdown-code-block, #f7f8fa));
  backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px));
  overflow: hidden;
  font-size: 13px;
  color: var(--dsw-alias-label-primary, #1a1c21);
}
body[data-ds-dark-theme] .agy-btw-card,
body.dark .agy-btw-card,
[data-theme="dark"] .agy-btw-card {
  background: var(--dsw-specific-menu, var(--dsw-alias-markdown-code-block, #1f2229));
  border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, .12));
  color: var(--dsw-alias-label-primary, #eceef2);
}
.agy-btw-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 4px 8px 4px 12px;
  background: var(--dsw-alias-markdown-code-block-banner, rgba(127, 127, 127, .05));
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .2));
}
.agy-btw-card[data-collapsed="true"] .agy-btw-head { border-bottom: 0; }
.agy-btw-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #4a4c55);
}
.agy-btw-mark {
  display: block;
  width: 13px;
  height: 13px;
  color: var(--dsw-alias-state-business-primary, #4176e6);
}
.agy-btw-question {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary-dimmed, var(--dsw-alias-label-secondary, #5c606b));
}
.agy-btw-status {
  flex: none;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  white-space: nowrap;
}
.agy-btw-status[data-running="true"] {
  color: var(--dsw-alias-state-business-primary, #4176e6);
}
.agy-btw-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  margin-left: 4px;
}
.agy-btw-pager {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  margin-right: 2px;
}
.agy-btw-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  margin: 0;
  padding: 2px 6px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
  font: inherit;
  font-size: 11.5px;
  line-height: 18px;
  cursor: pointer;
}
.agy-btw-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1a1c21);
}
.agy-btw-btn:disabled { opacity: .4; cursor: default; }
.agy-btw-btn[data-active="true"] {
  color: var(--dsw-alias-state-business-primary, #4176e6);
}
.agy-btw-btn-danger:hover:not(:disabled) {
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-btw-tools {
  padding: 5px 12px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .16));
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.agy-btw-tools-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.agy-btw-tools-toggle:hover { color: var(--dsw-alias-label-primary, inherit); }
.agy-btw-tools-list {
  margin: 4px 0 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agy-btw-tool-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
}
.agy-btw-tool-state[data-state="running"] { color: var(--dsw-alias-state-business-primary, #4176e6); }
.agy-btw-tool-state[data-state="done"] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.agy-btw-tool-state[data-state="error"] { color: var(--dsw-alias-state-error-primary, #ef4444); }
.agy-btw-body {
  max-height: min(38vh, 320px);
  overflow-y: auto;
  padding: 10px 14px;
  font-size: var(--dsw-font-markdown-base-font-size, 13.5px);
  line-height: var(--dsw-font-markdown-base-line-height, 22px);
  overflow-wrap: break-word;
}
.agy-btw-body p { margin: 0 0 8px 0; }
.agy-btw-body p:last-child { margin-bottom: 0; }
.agy-btw-body ul, .agy-btw-body ol { margin: 0 0 8px 0; padding-left: 20px; }
.agy-btw-body pre {
  margin: 0 0 8px 0;
  padding: 8px 10px;
  overflow-x: auto;
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .2));
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-markdown-code-block-banner, rgba(127, 127, 127, .06));
}
.agy-btw-body code {
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: .9em;
  padding: 1px 4px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-markdown-inline-code, rgba(127, 127, 127, .14));
}
.agy-btw-body pre code { background: transparent; padding: 0; }
.agy-btw-empty, .agy-btw-thinking {
  font-size: 12.5px;
  color: var(--dsw-alias-label-tertiary, #8a8f98);
}
.agy-btw-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--dsw-alias-state-error-primary, #ef4444);
}
.agy-btw-followup {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .18));
  background: var(--dsw-alias-markdown-code-block-banner, rgba(127, 127, 127, .03));
}
.agy-btw-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, .26));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-specific-input-major, transparent);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  outline: none;
}
.agy-btw-input:focus {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}
.agy-btw-send {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-button-info-fill, #3964fe);
  color: var(--dsw-alias-label-on-color, #fff);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.agy-btw-send:disabled { opacity: .45; cursor: default; }
`

export function injectBtwStyles(): void {
  try {
    const doc = win.document as {
      getElementById?: (id: string) => { textContent?: string } | null
      createElement?: (tag: string) => { id: string; textContent: string }
      head?: { appendChild(node: unknown): void } | null
      documentElement?: { appendChild(node: unknown): void } | null
    } | null | undefined
    if (!doc || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') return
    const existing = doc.getElementById(BTW_STYLE_ID)
    if (existing !== null && existing !== undefined) {
      if (existing.textContent !== BTW_CSS) existing.textContent = BTW_CSS
      return
    }
    const el = doc.createElement('style')
    el.id = BTW_STYLE_ID
    el.textContent = BTW_CSS
    ;(doc.head ?? doc.documentElement)?.appendChild(el)
  } catch {
    // SSR / minimal test environments skip style injection
  }
}

export interface BtwCardProps {
  view: BtwSessionView
  t?: (key: string, params?: Record<string, unknown>) => string
  onAsk: (question: string, opts: { followUp: boolean; newThread: boolean }) => void
  onCancel: () => void
  onDismiss: () => void
  onNavigate: (index: number) => void
}

function tr(propsT: BtwCardProps['t'], key: string, fallback: string, params?: Record<string, unknown>): string {
  if (typeof propsT === 'function') {
    try {
      const val = propsT(key, params)
      if (typeof val === 'string' && val !== '' && val !== key) return val
    } catch {
      // fall through
    }
  }
  return translateOr(key, fallback, params)
}

function formatDuration(ms: number): string {
  if (ms <= 0) return ''
  return (Math.round(ms / 100) / 10).toFixed(1) + 's'
}

function toolGlyph(state: BtwToolStep['state']): string {
  if (state === 'done') return '✓'
  if (state === 'error') return '✕'
  return '⋯'
}

function renderToolsStrip(
  entry: BtwEntry,
  toolsOpen: boolean,
  onToggle: () => void,
  t: BtwCardProps['t'],
): unknown {
  if (entry.tools.length === 0) return null
  const runningCount = entry.tools.filter((x) => x.state === 'running').length
  const summary = runningCount > 0
    ? tr(t, 'btw.toolsRunning', 'Running tools ({count})', { count: entry.tools.length })
    : tr(t, 'btw.toolsCalled', 'Called {count} tool(s)', { count: entry.tools.length })
  return h(
    'div',
    { className: 'agy-btw-tools', 'data-btw-tools': '' },
    h(
      'button',
      { type: 'button', className: 'agy-btw-tools-toggle', onClick: onToggle },
      h('span', null, toolsOpen ? '▾' : '▸'),
      h('span', null, summary),
    ),
    !toolsOpen
      ? null
      : h(
          'ul',
          { className: 'agy-btw-tools-list' },
          ...entry.tools.map((tool) =>
            h(
              'li',
              { key: tool.stepKey, className: 'agy-btw-tool-row' },
              h('span', { className: 'agy-btw-tool-state', 'data-state': tool.state }, toolGlyph(tool.state)),
              h('span', null, tool.target ? `${tool.name}(${tool.target})` : tool.name),
            ),
          ),
        ),
  )
}

export function BtwCard(props: BtwCardProps): unknown {
  const { view, t, onAsk, onCancel, onDismiss, onNavigate } = props
  const [collapsed, setCollapsed] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState('')
  const [newThread, setNewThread] = useState(false)

  if (!view.open) return null
  const entry = view.entries[view.activeIndex]
  const isRunning = entry?.status === 'running'
  const badge = tr(t, 'btw.badge', '/btw Side Question')

  const statusText = (() => {
    if (!entry) return ''
    if (entry.status === 'running') {
      return entry.answer.trim() === ''
        ? `${tr(t, 'btw.thinking', 'Thinking…')} · ${tr(t, 'btw.escCancel', 'Esc to cancel')}`
        : `${tr(t, 'btw.streaming', 'Streaming…')} · ${tr(t, 'btw.escCancel', 'Esc to cancel')}`
    }
    const parts: string[] = []
    if (entry.model) parts.push(entry.model)
    const dur = formatDuration(entry.durationMs)
    if (dur) parts.push(dur)
    if (entry.status === 'aborted') parts.push(tr(t, 'btw.aborted', 'Stopped'))
    return parts.join(' · ')
  })()

  const copyAnswer = (): void => {
    if (!entry || entry.answer.trim() === '') return
    void win.navigator?.clipboard?.writeText(entry.answer).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => undefined)
  }

  const submitFollowUp = (): void => {
    const q = draft.trim()
    if (q === '' || isRunning) return
    const wantNew = newThread || !entry?.conversationId
    setDraft('')
    setNewThread(false)
    onAsk(q, { followUp: !wantNew, newThread: wantNew })
  }

  const spark = h(
    'svg',
    { viewBox: '0 0 24 24', className: 'agy-btw-mark', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d: BRAND_PATHS.gemini, fill: 'currentColor' }),
  )

  return h(
    'div',
    { className: 'agy-btw-dock', 'data-btw-dock': view.sessionId },
    h(
      'div',
      { className: 'agy-btw-card', 'data-collapsed': collapsed ? 'true' : 'false', role: 'region', 'aria-label': badge },
      h(
        'div',
        { className: 'agy-btw-head' },
        h('span', { className: 'agy-btw-badge' }, spark, h('span', null, badge)),
        entry
          ? h('span', { className: 'agy-btw-question', title: entry.question }, entry.question)
          : h('span', { className: 'agy-btw-question' }, ''),
        statusText
          ? h('span', { className: 'agy-btw-status', 'data-running': isRunning ? 'true' : 'false' }, statusText)
          : null,
        h(
          'span',
          { className: 'agy-btw-actions' },
          view.entries.length > 1
            ? h(
                'span',
                { className: 'agy-btw-pager' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'agy-btw-btn',
                    disabled: view.activeIndex <= 0,
                    'aria-label': tr(t, 'btw.prev', 'Previous'),
                    onClick: () => onNavigate(view.activeIndex - 1),
                  },
                  '‹',
                ),
                h('span', null, `${view.activeIndex + 1}/${view.entries.length}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'agy-btw-btn',
                    disabled: view.activeIndex >= view.entries.length - 1,
                    'aria-label': tr(t, 'btw.next', 'Next'),
                    onClick: () => onNavigate(view.activeIndex + 1),
                  },
                  '›',
                ),
              )
            : null,
          entry
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'agy-btw-btn',
                  'data-active': newThread ? 'true' : 'false',
                  title: tr(t, 'btw.newThreadActive', 'Starts a new thread'),
                  onClick: () => {
                    setNewThread(!newThread)
                    if (collapsed) setCollapsed(false)
                  },
                },
                '+ ' + tr(t, 'btw.newThread', 'New'),
              )
            : null,
          entry && entry.answer.trim() !== ''
            ? h(
                'button',
                { type: 'button', className: 'agy-btw-btn', onClick: copyAnswer },
                copied ? tr(t, 'btw.copied', 'Copied') : tr(t, 'btw.copy', 'Copy'),
              )
            : null,
          entry
            ? h(
                'button',
                { type: 'button', className: 'agy-btw-btn', onClick: () => setCollapsed(!collapsed) },
                collapsed ? tr(t, 'btw.expand', 'Expand') : tr(t, 'btw.collapse', 'Collapse'),
              )
            : null,
          isRunning
            ? h(
                'button',
                { type: 'button', className: 'agy-btw-btn agy-btw-btn-danger', onClick: onCancel },
                tr(t, 'btw.stop', 'Stop'),
              )
            : h(
                'button',
                {
                  type: 'button',
                  className: 'agy-btw-btn',
                  title: tr(t, 'btw.dismiss', 'Dismiss (Esc)'),
                  'aria-label': tr(t, 'btw.dismiss', 'Dismiss (Esc)'),
                  onClick: onDismiss,
                },
                '×',
              ),
        ),
      ),
      collapsed || !entry ? null : renderToolsStrip(entry, toolsOpen, () => setToolsOpen(!toolsOpen), t),
      collapsed
        ? null
        : h(
            'div',
            { className: 'agy-btw-body' },
            !entry
              ? h('div', { className: 'agy-btw-empty' }, tr(t, 'btw.emptyHint', 'Ask a quick read-only side question without interrupting or altering the main conversation.'))
              : entry.answer.trim() !== ''
                ? renderMarkdown(entry.answer)
                : isRunning
                  ? h('div', { className: 'agy-btw-thinking' }, entry.thinking.trim() || tr(t, 'btw.thinking', 'Thinking…'))
                  : entry.status === 'aborted'
                    ? h('div', { className: 'agy-btw-thinking' }, tr(t, 'btw.aborted', 'Stopped'))
                    : null,
            entry?.status === 'error'
              ? h('div', { className: 'agy-btw-error', role: 'alert' }, `${tr(t, 'btw.failed', 'Side question failed')}: ${entry.error ?? ''}`)
              : null,
          ),
      collapsed || isRunning
        ? null
        : h(
            'div',
            { className: 'agy-btw-followup' },
            h('input', {
              type: 'text',
              className: 'agy-btw-input',
              value: draft,
              placeholder: newThread || !entry?.conversationId
                ? tr(t, 'btw.newPlaceholder', 'Ask a new side question…')
                : tr(t, 'btw.followUpPlaceholder', 'Ask a follow-up in this side thread…'),
              onChange: (e: { target?: { value?: string } }) => setDraft(e?.target?.value ?? ''),
              onKeyDown: (e: { key?: string; isComposing?: boolean; preventDefault?: () => void; stopPropagation?: () => void }) => {
                if (e.key === 'Enter' && !e.isComposing) {
                  e.preventDefault?.()
                  e.stopPropagation?.()
                  submitFollowUp()
                } else if (e.key === 'Escape') {
                  e.preventDefault?.()
                  e.stopPropagation?.()
                  onDismiss()
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'agy-btw-send',
                disabled: draft.trim() === '',
                onClick: submitFollowUp,
              },
              tr(t, 'btw.send', 'Send'),
            ),
          ),
    ),
  )
}

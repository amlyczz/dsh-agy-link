import { isInteractionLocked, onScrollSettle } from './scroll-guard.ts';
import { formatTokenCount, calcTokenReduction, formatCompactionSummary } from '../common/compaction.ts';

// Native-parity Compaction Card Presentation for dsh-agy-link.
//
// Matches the visual layout, typography, sticky header, and disclosure transitions
// of DSH's native `@deepseek-ai/dsh-client-ui-chat` CompactionItem, enriched with
// explicit token progression metrics:
//   "上下文已压缩 · xxx k → yyy k tokens (-zz%)"
//
// Includes TanStack Virtualizer safety: guarded by `isInteractionLocked()` and
// stable idempotency markers (`data-agy-compaction-rendered="true"`).

const COMPACTION_CSS = `
.agy-compaction-row {
  --dsh-compaction-header-height: calc(24px + var(--dsh-content-font-delta, 0px));
  padding: 2px 0;
  margin: 6px 0;
  font-family: inherit;
}

.agy-compaction-button {
  width: 100%;
  height: var(--dsh-compaction-header-height);
  border-radius: var(--dsw-radius-sm, 4px);
  min-width: 0;
  color: var(--dsw-alias-label-tertiary, #888);
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 12px);
  text-align: left;
  background: transparent;
  border: none;
  align-items: center;
  padding: 0 4px;
  transition: color 0.1s ease, background 0.1s ease;
  display: flex;
  cursor: pointer;
  box-sizing: border-box;
}

.agy-compaction-button:hover {
  color: var(--dsw-alias-label-secondary, #ccc);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08));
}

.agy-compaction-row[data-state="expanded"] .agy-compaction-button {
  position: sticky;
  top: 0;
  z-index: 7;
  background: var(--dsw-alias-bg-base, #1e1e1e);
  border-radius: 0;
}

.agy-compaction-leading {
  width: calc(16px + var(--dsh-content-font-delta, 0px));
  height: calc(16px + var(--dsh-content-font-delta, 0px));
  color: inherit;
  flex: none;
  place-items: center;
  margin-right: 6px;
  display: inline-grid;
}

.agy-compaction-leading svg {
  width: calc(14px + var(--dsh-content-font-delta, 0px));
  height: calc(14px + var(--dsh-content-font-delta, 0px));
}

.agy-compaction-icon-context,
.agy-compaction-icon-chevron {
  grid-area: 1/1;
  justify-content: center;
  align-items: center;
  display: inline-flex;
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.agy-compaction-icon-chevron {
  opacity: 0;
}

.agy-compaction-button:hover .agy-compaction-icon-context {
  opacity: 0;
}

.agy-compaction-button:hover .agy-compaction-icon-chevron {
  opacity: 1;
}

.agy-compaction-row[data-state="expanded"] .agy-compaction-icon-context {
  opacity: 0;
}

.agy-compaction-row[data-state="expanded"] .agy-compaction-icon-chevron {
  opacity: 1;
  transform: rotate(90deg);
}

.agy-compaction-title {
  font-weight: 500;
  color: var(--dsw-alias-label-secondary, #aaa);
}

.agy-compaction-sep {
  margin: 0 6px;
  color: var(--dsw-alias-label-tertiary, #666);
}

.agy-compaction-summary {
  color: var(--dsw-alias-label-tertiary, #888);
  font-size: var(--dsh-content-font-size-secondary, 12px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-compaction-body {
  padding: 10px 14px;
  margin-top: 4px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-l1, rgba(127, 127, 127, 0.05));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.15));
  color: var(--dsw-alias-label-secondary, #ccc);
  font-size: 13px;
  line-height: 1.6;
}

.agy-compaction-metrics-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.15));
  font-size: 12px;
}

.agy-metric-item {
  color: var(--dsw-alias-label-secondary, #bbb);
}

.agy-metric-arrow {
  color: var(--dsw-alias-label-tertiary, #666);
  font-weight: 600;
}

.agy-metric-badge {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.agy-compaction-summary-text {
  white-space: pre-wrap;
  word-break: break-word;
}
`;

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'dsh-agy-link-compaction-css';
  if (document.getElementById(styleId) === null) {
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = COMPACTION_CSS;
    const host = document.head ?? document.documentElement;
    if (host) host.appendChild(st);
  }
}

/** Check if document language is Chinese or English. */
function getCompactionTitle(): string {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang || '';
    if (lang.startsWith('en')) return 'Context compacted';
  }
  return '上下文已压缩';
}

/**
 * Scan DOM for `.agy-compaction-card` markers and transform them into
 * the interactive DeepSeek-like Compaction Card.
 */
export function scanAndEnhanceCompactionCards(root: ParentNode = document): void {
  if (typeof document === 'undefined') return;
  if (isInteractionLocked()) return;

  const cards = root.querySelectorAll<HTMLElement>('.agy-compaction-card:not([data-agy-compaction-rendered="true"])');
  for (const card of Array.from(cards)) {
    card.setAttribute('data-agy-compaction-rendered', 'true');

    const beforeTokens = parseInt(card.dataset.before || '0', 10);
    const afterTokens = parseInt(card.dataset.after || '0', 10);
    // The marker is percent-encoded; a mangled value (host renderer, copy-paste)
    // must degrade to "no digest" instead of throwing and aborting the scan.
    let summary = ''
    if (card.dataset.summary) {
      try {
        summary = decodeURIComponent(card.dataset.summary)
      } catch {
        summary = ''
      }
    };

    const summaryLabel = formatCompactionSummary(beforeTokens, afterTokens);
    const reductionLabel = calcTokenReduction(beforeTokens, afterTokens);
    const titleText = getCompactionTitle();

    // Construct the card DOM
    const row = document.createElement('div');
    row.className = 'agy-compaction-row';
    row.setAttribute('data-state', 'collapsed');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agy-compaction-button';
    button.setAttribute('aria-expanded', 'false');

    button.innerHTML = `
      <span class="agy-compaction-leading" aria-hidden="true">
        <svg class="agy-compaction-icon-context" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="16" rx="2"></rect>
          <line x1="7" y1="8" x2="17" y2="8"></line>
          <line x1="7" y1="12" x2="13" y2="12"></line>
          <line x1="7" y1="16" x2="11" y2="16"></line>
        </svg>
        <svg class="agy-compaction-icon-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 5l7 7-7 7"></path>
        </svg>
      </span>
      <span class="agy-compaction-title">${titleText}</span>
      <span class="agy-compaction-sep" aria-hidden="true">·</span>
      <span class="agy-compaction-summary">${summaryLabel}</span>
    `;

    const body = document.createElement('div');
    body.className = 'agy-compaction-body';
    body.style.display = 'none';

    const metricsBar = document.createElement('div');
    metricsBar.className = 'agy-compaction-metrics-bar';
    metricsBar.innerHTML = `
      <span class="agy-metric-item"><strong>压缩前:</strong> ${formatTokenCount(beforeTokens)} tokens</span>
      <span class="agy-metric-arrow">→</span>
      <span class="agy-metric-item"><strong>压缩后:</strong> ${formatTokenCount(afterTokens)} tokens</span>
      <span class="agy-metric-badge">${reductionLabel}</span>
    `;
    body.appendChild(metricsBar);

    if (summary.trim() !== '') {
      const summaryContent = document.createElement('div');
      summaryContent.className = 'agy-compaction-summary-text';
      summaryContent.textContent = summary;
      body.appendChild(summaryContent);
    }

    button.addEventListener('click', (e) => {
      e.stopPropagation();
      const isExpanded = row.getAttribute('data-state') === 'expanded';
      const nextState = isExpanded ? 'collapsed' : 'expanded';
      row.setAttribute('data-state', nextState);
      button.setAttribute('aria-expanded', String(!isExpanded));
      body.style.display = isExpanded ? 'none' : 'block';
    });

    // Replace the fallback markdown blockquote with the interactive card
    card.replaceChildren(row);
    row.appendChild(button);
    row.appendChild(body);
  }
}

let compactionDispose: (() => void) | null = null;
let compactionScanTimer: ReturnType<typeof setTimeout> | null = null;
let unbindCompactionSettle: (() => void) | null = null;

function scheduleCompactionScan(): void {
  if (isInteractionLocked()) return;
  if (compactionScanTimer !== null) return;
  compactionScanTimer = setTimeout(() => {
    compactionScanTimer = null;
    if (isInteractionLocked()) return;
    scanAndEnhanceCompactionCards();
  }, 100);
}

export function installCompactionCard(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  compactionDispose?.();
  injectStyles();

  const observer = new MutationObserver(() => {
    scheduleCompactionScan();
  });

  unbindCompactionSettle = onScrollSettle(() => {
    scheduleCompactionScan();
  });

  const setup = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      scanAndEnhanceCompactionCards();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }

  const dispose = () => {
    if (compactionScanTimer !== null) {
      clearTimeout(compactionScanTimer);
      compactionScanTimer = null;
    }
    observer.disconnect();
    unbindCompactionSettle?.();
    unbindCompactionSettle = null;
  };

  compactionDispose = dispose;
  return dispose;
}

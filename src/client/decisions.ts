import { isInteractionLocked, onScrollSettle } from './scroll-guard.ts';

// Interactive User Decision & Choice Quick-Actions for dsh-agy-link.
//
// Detects decision sections and choice prompts in model responses (e.g.
// "### 💬 请您拍板：", "### 💬 接下来请您指示：", "### 请选择：")
// and attaches quick-action chip buttons that insert the user's selected choice
// straight into DSH's chat composer.

const DECISION_CSS = `
.agy-decision-container {
  margin: 10px 0 6px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.07));
  border: 1px dashed var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.3));
}

.agy-decision-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #aaa);
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.agy-decision-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.agy-decision-chip {
  background: var(--dsw-alias-bg-l1, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
  color: var(--dsw-alias-label-primary, #eee);
  padding: 5px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s ease;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  text-align: left;
  max-width: 100%;
}

.agy-decision-chip:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.18));
  border-color: var(--dsw-alias-border-l4, rgba(127, 127, 127, 0.5));
  transform: translateY(-1px);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
}

.agy-decision-chip:active {
  transform: translateY(0);
}

.agy-decision-chip.selected {
  background: rgba(16, 185, 129, 0.15);
  border-color: #10b981;
  color: #10b981;
}

.agy-decision-chip-num {
  font-weight: 700;
  opacity: 0.8;
}

.agy-decision-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

function injectStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'dsh-agy-link-decisions-css';
  if (document.getElementById(styleId) === null) {
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = DECISION_CSS;
    const host = document.head ?? document.documentElement;
    if (host) host.appendChild(st);
  }
}

/**
 * Insert text directly into DSH's chat composer
 */
export function insertTextIntoChatComposer(text: string): boolean {
  if (typeof document === 'undefined' || !text) return false;
  const inputEl =
    document.querySelector<HTMLElement>('[data-composer-input]') ??
    document.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]') ??
    document.querySelector<HTMLTextAreaElement>('textarea');

  if (!inputEl) return false;
  inputEl.focus();

  if (inputEl instanceof HTMLTextAreaElement || inputEl instanceof HTMLInputElement) {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? inputEl.value.length;
    inputEl.setRangeText(text, start, end, 'end');
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Lexical / ContentEditable
  try {
    const ok = document.execCommand('insertText', false, text);
    if (ok) return true;
  } catch {
    // ignore
  }

  // Fallback direct text update
  const existing = inputEl.textContent?.trim() ?? '';
  inputEl.textContent = existing ? `${existing} ${text}` : text;
  inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return true;
}

/** Check if text header suggests an actionable decision or choice prompt */
const DECISION_HEADER_REGEX = /(?:请(?:您)?(?:拍板|指示|决定|选择|决策)|decision|next\s+step|choose|拍板|选择方案)/i;

interface ExtractedOption {
  num?: string;
  title: string;
  fullText: string;
}

/** Extract numbered options or choice items from a decision list */
function extractOptionsFromList(container: HTMLElement): ExtractedOption[] {
  const options: ExtractedOption[] = [];
  const listItems = container.querySelectorAll('li');

  if (listItems.length > 0) {
    for (let i = 0; i < listItems.length; i++) {
      const li = listItems[i];
      if (!li) continue;
      const text = (li.textContent ?? '').trim();
      if (!text) continue;

      // Extract title: up to first colon, dash, or 60 chars
      const m = text.match(/^([0-9]+[、.．:]\s*)?(.*?)(?:[：:—\-·]|\n|$)/);
      const num = m?.[1]?.trim() ?? `${i + 1}.`;
      let title = m?.[2]?.trim() || text.slice(0, 50);
      if (title.length > 40) title = title.slice(0, 40) + '…';

      options.push({
        num,
        title,
        fullText: text,
      });
    }
  }

  return options;
}

/**
 * Scan DOM for decision prompts and mount interactive choice chips.
 *
 * IDEMPOTENCE (incident 2026-10-23 — "scroll back and forth = insane flashing"):
 * DSH renders these containers inside a TanStack-Virtual list with dynamic
 * measurement (`measureElement` + `anchorTo:"start"`). Injecting a toolbar
 * changes the measured item height, which makes the virtualizer rewrite
 * scrollTop; the resulting re-render rebuilds the markdown/heading nodes
 * (dropping the per-HEADING guard) and this scanner injected the toolbar
 * again — growth on every scroll pass, i.e. a flashing flywheel.
 *
 * Two independent guards now make injection strictly once-per-container:
 *   1. `data-agy-decisions-scanned` on the container, written on EVERY pass
 *      (it used to be read here but never assigned anywhere in the codebase),
 *   2. "a toolbar already exists in this container" — survives React
 *      rebuilding the heading nodes during a virtualizer remount.
 */
export function scanAndEnhanceDecisions(): void {
  if (typeof document === 'undefined') return;
  if (isInteractionLocked()) return;

  const markdownContainers = document.querySelectorAll<HTMLElement>('div[class*="_markdown_"], [data-markdown-variant]');
  for (let i = 0; i < markdownContainers.length; i++) {
    const container = markdownContainers[i];
    if (!container || container.dataset.agyDecisionsScanned === 'true') continue;

    // A previous pass (or the host's own snapshot) already injected a toolbar
    // into this container. Mark and skip: never inject a duplicate.
    if (container.querySelector('.agy-decision-container')) {
      container.dataset.agyDecisionsScanned = 'true';
      continue;
    }

    // Mark BEFORE mutating so a self-triggered re-scan (this function inserts
    // nodes, which fires the observer that called it) short-circuits above.
    container.dataset.agyDecisionsScanned = 'true';

    // Check headings (h2, h3, h4, or strong paragraphs)
    const headings = container.querySelectorAll<HTMLElement>('h2, h3, h4, p > strong');
    for (let j = 0; j < headings.length; j++) {
      const heading = headings[j];
      if (!heading || heading.dataset.agyDecisionAttached === 'true') continue;

      const headingText = (heading.textContent ?? '').trim();
      if (!DECISION_HEADER_REGEX.test(headingText)) continue;

      // Find the list immediately following this heading
      let sibling = heading.nextElementSibling;
      let targetList: HTMLElement | null = null;
      while (sibling) {
        if (sibling.tagName === 'OL' || sibling.tagName === 'UL') {
          targetList = sibling as HTMLElement;
          break;
        }
        if (/^H[1-4]$/.test(sibling.tagName)) break; // hit another heading
        sibling = sibling.nextElementSibling;
      }

      if (!targetList) continue;

      const options = extractOptionsFromList(targetList);
      if (options.length === 0) continue;

      heading.dataset.agyDecisionAttached = 'true';

      // Build decision chip toolbar
      const box = document.createElement('div');
      box.className = 'agy-decision-container';

      const header = document.createElement('div');
      header.className = 'agy-decision-header';
      header.innerHTML = '<span>💬 点击选项快速填入：</span>';
      box.appendChild(header);

      const chips = document.createElement('div');
      chips.className = 'agy-decision-chips';

      for (const opt of options) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'agy-decision-chip';
        chip.title = `点击填入: ${opt.fullText}`;

        const numSpan = document.createElement('span');
        numSpan.className = 'agy-decision-chip-num';
        numSpan.textContent = opt.num ?? '👉';

        const textSpan = document.createElement('span');
        textSpan.className = 'agy-decision-chip-text';
        textSpan.textContent = opt.title;

        chip.appendChild(numSpan);
        chip.appendChild(textSpan);

        chip.onclick = (e) => {
          e.stopPropagation();
          const cleanText = opt.fullText.replace(/^[0-9]+[、.．:]\s*/, '').trim();
          const insertPayload = `我选择 ${opt.num ? opt.num + ' ' : ''}${cleanText}`;
          insertTextIntoChatComposer(insertPayload);

          chip.classList.add('selected');
          setTimeout(() => chip.classList.remove('selected'), 1200);
        };

        chips.appendChild(chip);
      }

      box.appendChild(chips);
      targetList.parentNode?.insertBefore(box, targetList.nextSibling);
    }
  }
}

let decisionChipsDispose: (() => void) | null = null;
let decisionScanTimer: ReturnType<typeof setTimeout> | null = null;
let unbindDecisionSettle: (() => void) | null = null;

function scheduleDecisionScan(): void {
  if (isInteractionLocked()) return;
  if (decisionScanTimer !== null) return;
  decisionScanTimer = setTimeout(() => {
    decisionScanTimer = null;
    if (isInteractionLocked()) return;
    scanAndEnhanceDecisions();
  }, 100);
}

export function installDecisionChips(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  // Same lifecycle contract as installImageEnhancer: a reload replaces the
  // observer instead of accumulating one per plugin load.
  decisionChipsDispose?.();
  injectStyles();

  const observer = new MutationObserver(() => {
    scheduleDecisionScan();
  });

  unbindDecisionSettle = onScrollSettle(() => {
    scheduleDecisionScan();
  });

  const setup = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
      scanAndEnhanceDecisions();
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setup, { once: true });
  } else {
    setup();
  }

  const dispose = (): void => {
    observer.disconnect();
    if (unbindDecisionSettle !== null) {
      unbindDecisionSettle();
      unbindDecisionSettle = null;
    }
    if (decisionScanTimer !== null) {
      clearTimeout(decisionScanTimer);
      decisionScanTimer = null;
    }
    window.removeEventListener('DOMContentLoaded', setup);
    if (decisionChipsDispose === dispose) decisionChipsDispose = null;
  };
  decisionChipsDispose = dispose;
  return dispose;
}

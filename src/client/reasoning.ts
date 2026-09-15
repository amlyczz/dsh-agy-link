// Client-side auto-expansion for reasoning blocks with thought prose (dsh-agy-link).
//
// In DSH web, assistant reasoning rows (<div data-variant="think">) default to
// collapsed (useState(false)). When a turn contains full model thought prose
// (from agy SQLite), we auto-expand the row so the user can read the thoughts
// directly without having to manually click to open.
//
// If the user manually clicks the row to collapse it, we respect their action
// and keep it collapsed. In the collapsed state, DSH displays the first line
// of the reasoning text as the summary:
//   [agy thinking turn · *** thinking tokens] [Chain-of-Thought body]

export function installAutoExpandReasoning(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const userCollapsed = new WeakSet<Element>();
  const autoExpanded = new WeakSet<Element>();

  function checkElement(el: Element): void {
    if (el.getAttribute('data-variant') !== 'think') return;
    if (userCollapsed.has(el)) return;
    if (autoExpanded.has(el)) return;

    // Check if it has real thinking prose beyond the banner
    const text = (el.textContent ?? '').trim();
    if (!text.includes('[agy thinking turn')) return;

    // Match banner and check for non-empty thought prose
    const match = text.match(/\[agy thinking turn(?: · \d+ thinking tokens)?\]\s*(.+)/s);
    const hasProse = Boolean(match && match[1] && match[1].trim().length > 0);
    if (!hasProse) return;

    // If currently collapsed (not expanded in DSH)
    const isExpanded = el.hasAttribute('data-expanded') && el.getAttribute('data-expanded') !== 'false';
    if (!isExpanded) {
      autoExpanded.add(el);
      const clickTarget =
        (el.querySelector('button') as HTMLElement | null) ||
        (el.querySelector('[class*="row"]') as HTMLElement | null) ||
        (el as HTMLElement);
      try {
        clickTarget.click();
      } catch {
        // non-fatal
      }
    }
  }

  function scanAll(): void {
    const thinkRows = document.querySelectorAll('div[data-variant="think"]');
    for (let i = 0; i < thinkRows.length; i++) {
      const el = thinkRows[i];
      if (el) checkElement(el);
    }
  }

  // Track user manual clicks so we never re-expand what the user deliberately collapsed
  document.addEventListener(
    'click',
    (ev) => {
      const target = ev.target as Element | null;
      if (!target) return;
      const thinkRow = target.closest('div[data-variant="think"]');
      if (!thinkRow) return;

      const wasExpanded =
        thinkRow.hasAttribute('data-expanded') && thinkRow.getAttribute('data-expanded') !== 'false';
      if (wasExpanded) {
        userCollapsed.add(thinkRow);
      } else {
        userCollapsed.delete(thinkRow);
      }
    },
    true, // capture phase
  );

  // Observe streaming changes and new rows
  const observer = new MutationObserver(() => {
    scanAll();
  });

  const setupObserver = () => {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      scanAll();
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setupObserver, { once: true });
  } else {
    setupObserver();
  }
}

// Console overlay stylesheet: backdrop, panel, scroller and the scroll-time
// animation pause.
//
// Split out of global-css.ts because that file sits on the 600-line budget
// ceiling and every overlay change used to be paid for by deleting comments.
// These rules are self-contained (unique `.agy-modal-*` selectors plus the
// `html.agy-modal-open` / `html.agy-scrolling` state hooks), so they compose
// safely at the end of GLOBAL_CSS.
export const MODAL_CSS = `
.agy-modal-backdrop {
	position: fixed;
	inset: 0;
	z-index: 9999;
	background: var(--agy-modal-backdrop);
	/* NO full-screen backdrop blur here. Filtering the whole viewport forces
	   Chromium/Electron to re-sample the page every frame while anything behind
	   it moves (scroll, streaming, animations) — the recurring "打开控制台后滚动
	   闪屏" root cause. The rgba dim below is stable and flicker-free. */
	overscroll-behavior: contain;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	padding: clamp(20px, 6vh, 48px) 16px 20px;
	box-sizing: border-box;
}
/* While the console is open, freeze the conversation scroller behind it so
   nothing moves/reflows under the fixed overlay. scrollbar-gutter:stable on the
   host scroller keeps the width from jumping when overflow flips to hidden. */
html.agy-modal-open [data-conversation-scroll] {
	overflow: hidden !important;
	overscroll-behavior: contain;
}
/* Belt for the shell itself: if the host page (or a shell wrapper) is the thing
   that scrolls, locking only the conversation scroller leaves a scroller free
   behind the overlay. The wheel/touch blocker in the dialog is the primary fix;
   this makes the intent explicit for any element that follows the document. */
html.agy-modal-open,
html.agy-modal-open body {
	overflow: hidden !important;
	overscroll-behavior: none;
}
.agy-modal-panel {
	position: relative;
	width: 100%;
	max-width: 640px;
	max-height: min(820px, calc(100vh - 68px));
	background: var(--agy-bg-panel);
	border: 1px solid var(--agy-border-card);
	border-radius: 14px;
	box-shadow: var(--agy-shadow-modal);
	display: flex;
	flex-direction: column;
	overflow: hidden;
	color: var(--agy-text-primary);
	font-family: var(--agy-font-family);
	/* NO compositing hints here (2026-11-04, "滚动还是频繁闪屏"):
	   contain: content implies PAINT containment, and paint containment on an
	   ancestor of a scrolling subtree is the classic Chromium flicker trap — the
	   backing layer is dropped and rebuilt while the body scrolls, so the panel
	   blinks over the translucent backdrop. A forced translateZ(0) layer makes
	   it worse (big fixed layer + shadow re-composited per frame). A 640px panel
	   needs neither hint; plain overflow: hidden already clips it. */
}
.agy-modal-body { scrollbar-gutter: stable; }
/* While a scroll gesture is in flight (scroll-guard toggles html.agy-scrolling),
   freeze every decorative effect inside the console PANEL - header spinner and
   status chips included, they share the layer the scroller moves in. Continuous animation
   under a moving scroller keeps Chromium re-painting that subtree each frame and,
   with the panel's rounded clip + shadow, shows up as the recurring "scrolling
   the console flashes" symptom (2026-11-25). Paused effects resume when the
   gesture settles, so nothing looks permanently frozen. */
html.agy-scrolling :is(.agy-modal-panel, .agy-modal-panel *) {
	animation-play-state: paused !important;
	transition: none !important;
}
`

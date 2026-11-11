// Injected CSS for the local-image enhancer and lightbox.
//
// Split out of src/client/images.ts; the stylesheet is unchanged.
const IMAGE_CSS = `
.agy-image-card {
  display: inline-flex;
  flex-direction: column;
  margin: 6px 0;
  max-width: 100%;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.25));
  background: var(--dsw-alias-bg-l1, rgba(255, 255, 255, 0.03));
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  vertical-align: middle;
}

.agy-image-card:hover {
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.45));
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
}

.agy-image-thumb-wrap {
  position: relative;
  overflow: hidden;
  max-height: 480px;
  cursor: zoom-in;
  display: flex;
  align-items: center;
  justify-content: center;
  background: repeating-conic-gradient(rgba(127,127,127,0.08) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
}

.agy-image-thumb {
  display: block;
  max-width: 100%;
  max-height: 480px;
  height: auto;
  object-fit: contain;
  transition: transform 0.2s ease;
}

.agy-image-card:hover .agy-image-thumb {
  transform: scale(1.015);
}

.agy-image-caption {
  padding: 6px 10px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #aaa);
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.08));
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.15));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-image-link-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  margin: 0 2px;
  border-radius: 4px;
  font-size: 12px;
  background: var(--dsw-alias-bg-l2, rgba(127, 127, 127, 0.1));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  color: var(--dsw-alias-label-primary, #ddd);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s ease;
}

.agy-image-link-chip:hover {
  background: var(--dsw-alias-bg-hover, rgba(127, 127, 127, 0.2));
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.35));
}

/* Lightbox Modal */
.agy-lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: rgba(0, 0, 0, 0.9);
  /* No full-viewport backdrop blur: same flicker class as the console overlay.
     The image viewer is already near-opaque; a solid alpha is stable. */
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  user-select: none;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.agy-lightbox-backdrop.open {
  opacity: 1;
}

.agy-lightbox-header {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: rgba(20, 20, 20, 0.65);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 13px;
}

.agy-lightbox-title {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.agy-lightbox-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.agy-lightbox-btn {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.agy-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.agy-lightbox-btn-close {
  background: rgba(239, 68, 68, 0.25);
  border-color: rgba(239, 68, 68, 0.4);
}

.agy-lightbox-btn-close:hover {
  background: rgba(239, 68, 68, 0.45);
}

.agy-lightbox-body {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
}

.agy-lightbox-body.grabbing {
  cursor: grabbing;
}

.agy-lightbox-img-wrap {
  transform-origin: center center;
  transition: transform 0.05s ease-out;
  display: inline-block;
}

.agy-lightbox-img {
  max-width: 90vw;
  max-height: 85vh;
  object-fit: contain;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  border-radius: 4px;
  pointer-events: none;
}
`;

export function injectStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'dsh-agy-link-images-css';
  if (document.getElementById(styleId) === null) {
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = IMAGE_CSS;
    const host = document.head ?? document.documentElement;
    if (host) host.appendChild(st);
  }
}


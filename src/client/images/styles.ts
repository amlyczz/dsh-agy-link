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
  margin-left: 6px;
  padding: 1px 8px;
  height: 20px;
  line-height: 1;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 500;
  vertical-align: middle;
  color: #60a5fa;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.28);
  cursor: pointer;
  text-decoration: none;
  user-select: none;
  white-space: nowrap;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.agy-image-link-chip:hover {
  background: rgba(59, 130, 246, 0.22);
  border-color: rgba(59, 130, 246, 0.5);
  color: #93c5fd;
  transform: translateY(-0.5px);
  box-shadow: 0 2px 10px rgba(59, 130, 246, 0.25);
}

.agy-image-link-chip:active {
  transform: translateY(0.5px);
}

.agy-chip-video {
  color: #a855f7;
  background: rgba(168, 85, 247, 0.1);
  border-color: rgba(168, 85, 247, 0.28);
}
.agy-chip-video:hover {
  background: rgba(168, 85, 247, 0.22);
  border-color: rgba(168, 85, 247, 0.5);
  color: #c084fc;
  box-shadow: 0 2px 10px rgba(168, 85, 247, 0.25);
}

.agy-image-chip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.agy-image-chip-text {
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.2px;
}

/* Lightbox Modal */
.agy-lightbox-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: radial-gradient(circle at 50% 50%, rgba(15, 23, 42, 0.78) 0%, rgba(6, 8, 15, 0.94) 100%);
  backdrop-filter: blur(24px) saturate(160%);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  user-select: none;
  opacity: 0;
  transition: opacity 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.agy-lightbox-backdrop.open {
  opacity: 1;
}

.agy-lightbox-header {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: rgba(20, 24, 38, 0.85);
  backdrop-filter: blur(28px) saturate(190%);
  -webkit-backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 9999px;
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05);
  z-index: 10;
  color: #f8fafc;
  max-width: 92vw;
  box-sizing: border-box;
}

.agy-lightbox-title {
  font-size: 12px;
  font-weight: 500;
  color: #e2e8f0;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.2px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.agy-lightbox-tag {
  display: inline-block;
  padding: 1px 6px;
  font-size: 9.5px;
  font-weight: 600;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: #94a3b8;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.agy-lightbox-divider {
  width: 1px;
  height: 16px;
  background: rgba(255, 255, 255, 0.14);
  margin: 0 4px;
  flex-shrink: 0;
}

.agy-lightbox-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.agy-lightbox-btn {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #cbd5e1;
  border-radius: 9999px;
  padding: 0 10px;
  height: 28px;
  cursor: pointer;
  font-size: 11.5px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  outline: none;
}

.agy-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.25);
  color: #ffffff;
  transform: translateY(-0.5px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}

.agy-lightbox-btn:active {
  transform: translateY(0.5px);
}

.agy-lightbox-btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.agy-lightbox-btn-close {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.3);
  color: #fca5a5;
  margin-left: 2px;
}

.agy-lightbox-btn-close:hover {
  background: rgba(239, 68, 68, 0.3);
  border-color: rgba(239, 68, 68, 0.5);
  color: #ffffff;
}

.agy-lightbox-hints {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(12px);
  padding: 4px 14px;
  border-radius: 9999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  letter-spacing: 0.2px;
  pointer-events: none;
  user-select: none;
  z-index: 5;
}

.agy-lightbox-video {
  max-width: 90vw;
  max-height: 82vh;
  border-radius: 12px;
  box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.12);
  background: #000;
  outline: none;
  display: block;
}

.agy-toast {
  position: fixed;
  bottom: 32px;
  left: 50%;
  transform: translateX(-50%) translateY(16px);
  background: rgba(20, 24, 38, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.16);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  color: #f8fafc;
  padding: 8px 18px;
  border-radius: 9999px;
  font-size: 12px;
  font-weight: 500;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
  z-index: 1000000;
  display: flex;
  align-items: center;
  gap: 8px;
}

.agy-toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
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
  position: relative;
  transform-origin: center center;
  transition: transform 0.05s ease-out;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 92vw;
  max-height: 86vh;
  border-radius: 8px;
  box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.12);
  background: repeating-conic-gradient(rgba(255, 255, 255, 0.07) 0% 25%, rgba(0, 0, 0, 0.18) 0% 50%) 50% / 20px 20px;
}

.agy-lightbox-img {
  max-width: 90vw;
  max-height: 84vh;
  object-fit: contain;
  display: block;
  border-radius: 8px;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.agy-lightbox-spinner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  gap: 12px;
  color: #94a3b8;
  font-size: 13px;
}

.agy-lightbox-spinner-ring {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.15);
  border-top-color: #38bdf8;
  border-radius: 50%;
  animation: agySpin 0.8s linear infinite;
}

@keyframes agySpin {
  to { transform: rotate(360deg); }
}

.agy-lightbox-error-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 28px;
  max-width: 460px;
  text-align: center;
  background: rgba(24, 24, 30, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
  user-select: text;
}

.agy-lightbox-error-icon {
  font-size: 32px;
  margin-bottom: 12px;
  opacity: 0.85;
}

.agy-lightbox-error-title {
  font-size: 15px;
  font-weight: 600;
  color: #f8fafc;
  margin-bottom: 8px;
}

.agy-lightbox-error-desc {
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #cbd5e1;
  background: rgba(0, 0, 0, 0.45);
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  word-break: break-all;
  margin-bottom: 12px;
  max-width: 100%;
}

.agy-lightbox-error-hint {
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.5;
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


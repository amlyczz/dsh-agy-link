// Fullscreen image lightbox (zoom, pan, copy path, fullscreen).
//
// Split out of src/client/images.ts; behaviour is unchanged.
import { injectStyles } from './styles.ts';

let lightboxOverlay: HTMLElement | null = null;
let currentLightboxImg: HTMLImageElement | null = null;
let lightboxScale = 1.0;
let lightboxTranslateX = 0;
let lightboxTranslateY = 0;
let isDraggingLightbox = false;
let dragStartX = 0;
let dragStartY = 0;

/**
 * Open fullscreen Lightbox modal
 */
export function openLightbox(src: string, title = 'Image Preview', rawPath?: string): void {
  if (typeof document === 'undefined') return;
  injectStyles();

  if (lightboxOverlay) {
    lightboxOverlay.remove();
    lightboxOverlay = null;
  }

  lightboxScale = 1.0;
  lightboxTranslateX = 0;
  lightboxTranslateY = 0;

  const overlay = document.createElement('div');
  overlay.className = 'agy-lightbox-backdrop';

  const header = document.createElement('div');
  header.className = 'agy-lightbox-header';

  const titleEl = document.createElement('div');
  titleEl.className = 'agy-lightbox-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const actions = document.createElement('div');
  actions.className = 'agy-lightbox-actions';

  const btnZoomIn = document.createElement('button');
  btnZoomIn.className = 'agy-lightbox-btn';
  btnZoomIn.textContent = '🔍+';
  btnZoomIn.title = '放大 / Zoom In';

  const btnZoomOut = document.createElement('button');
  btnZoomOut.className = 'agy-lightbox-btn';
  btnZoomOut.textContent = '🔍-';
  btnZoomOut.title = '缩小 / Zoom Out';

  const btnReset = document.createElement('button');
  btnReset.className = 'agy-lightbox-btn';
  btnReset.textContent = '1:1';
  btnReset.title = '实际大小 / Reset';

  actions.appendChild(btnZoomIn);
  actions.appendChild(btnZoomOut);
  actions.appendChild(btnReset);

  if (rawPath) {
    const btnCopyPath = document.createElement('button');
    btnCopyPath.className = 'agy-lightbox-btn';
    btnCopyPath.textContent = '📋 复制路径';
    btnCopyPath.onclick = (e) => {
      e.stopPropagation();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(rawPath).then(() => {
          btnCopyPath.textContent = '✓ 已复制';
          setTimeout(() => { btnCopyPath.textContent = '📋 复制路径'; }, 1500);
        }).catch(() => {});
      }
    };
    actions.appendChild(btnCopyPath);
  }

  const btnClose = document.createElement('button');
  btnClose.className = 'agy-lightbox-btn agy-lightbox-btn-close';
  btnClose.textContent = '✕ 关闭';
  actions.appendChild(btnClose);

  header.appendChild(actions);
  overlay.appendChild(header);

  const body = document.createElement('div');
  body.className = 'agy-lightbox-body';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'agy-lightbox-img-wrap';

  const img = document.createElement('img');
  img.className = 'agy-lightbox-img';
  img.src = src;
  img.alt = title;
  currentLightboxImg = img;

  imgWrap.appendChild(img);
  body.appendChild(imgWrap);
  overlay.appendChild(body);

  const updateTransform = () => {
    imgWrap.style.transform = `translate(${lightboxTranslateX}px, ${lightboxTranslateY}px) scale(${lightboxScale})`;
  };

  btnZoomIn.onclick = (e) => {
    e.stopPropagation();
    lightboxScale = Math.min(lightboxScale * 1.3, 5.0);
    updateTransform();
  };

  btnZoomOut.onclick = (e) => {
    e.stopPropagation();
    lightboxScale = Math.max(lightboxScale / 1.3, 0.2);
    updateTransform();
  };

  btnReset.onclick = (e) => {
    e.stopPropagation();
    lightboxScale = 1.0;
    lightboxTranslateX = 0;
    lightboxTranslateY = 0;
    updateTransform();
  };

  const closeLightbox = () => {
    window.removeEventListener('keydown', onKeyDown);
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.remove();
      if (lightboxOverlay === overlay) lightboxOverlay = null;
    }, 200);
  };

  btnClose.onclick = (e) => {
    e.stopPropagation();
    closeLightbox();
  };

  overlay.onclick = (e) => {
    if (e.target === overlay || e.target === body) {
      closeLightbox();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeLightbox();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Drag and pan
  body.onmousedown = (e) => {
    isDraggingLightbox = true;
    dragStartX = e.clientX - lightboxTranslateX;
    dragStartY = e.clientY - lightboxTranslateY;
    body.classList.add('grabbing');
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDraggingLightbox) return;
    lightboxTranslateX = e.clientX - dragStartX;
    lightboxTranslateY = e.clientY - dragStartY;
    updateTransform();
  };

  const onMouseUp = () => {
    if (isDraggingLightbox) {
      isDraggingLightbox = false;
      body.classList.remove('grabbing');
    }
  };

  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);

  // Wheel zoom
  body.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 0.87;
    lightboxScale = Math.max(0.2, Math.min(lightboxScale * factor, 5.0));
    updateTransform();
  };

  document.body.appendChild(overlay);
  lightboxOverlay = overlay;
  requestAnimationFrame(() => overlay.classList.add('open'));
}


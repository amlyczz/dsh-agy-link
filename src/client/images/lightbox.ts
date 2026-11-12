// Fullscreen image & media lightbox (modern glassmorphism, video player, zoom, pan, copy path, reveal in finder).
import { injectStyles } from './styles.ts';
import { isVideoFile, openInSystem } from './media.ts';

let lightboxOverlay: HTMLElement | null = null;
let currentLightboxImg: HTMLImageElement | null = null;
let lightboxScale = 1.0;
let lightboxTranslateX = 0;
let lightboxTranslateY = 0;
let isDraggingLightbox = false;
let dragStartX = 0;
let dragStartY = 0;

export function showToast(message: string, duration = 2200): void {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector('.agy-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'agy-toast';
  toast.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg><span>${message}</span>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

function createActionButtons(rawPath: string | undefined, isVideo: boolean, callbacks: {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
  onClose: () => void;
}): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'agy-lightbox-actions';

  if (!isVideo) {
    const btnZoomIn = document.createElement('button');
    btnZoomIn.className = 'agy-lightbox-btn';
    btnZoomIn.title = '放大 / Zoom In';
    btnZoomIn.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg></span><span class="agy-btn-text">放大</span><span style="display:none">🔍+</span>';
    btnZoomIn.onclick = (e) => { e.stopPropagation(); callbacks.onZoomIn(); };

    const btnZoomOut = document.createElement('button');
    btnZoomOut.className = 'agy-lightbox-btn';
    btnZoomOut.title = '缩小 / Zoom Out';
    btnZoomOut.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg></span><span class="agy-btn-text">缩小</span><span style="display:none">🔍-</span>';
    btnZoomOut.onclick = (e) => { e.stopPropagation(); callbacks.onZoomOut(); };

    const btnReset = document.createElement('button');
    btnReset.className = 'agy-lightbox-btn';
    btnReset.title = '实际大小 / Reset (1:1)';
    btnReset.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg></span><span class="agy-btn-text">1:1</span>';
    btnReset.onclick = (e) => { e.stopPropagation(); callbacks.onReset(); };

    actions.appendChild(btnZoomIn);
    actions.appendChild(btnZoomOut);
    actions.appendChild(btnReset);
  }

  if (rawPath) {
    const btnOpen = document.createElement('button');
    btnOpen.className = 'agy-lightbox-btn';
    btnOpen.title = '用系统默认应用打开 / Open with default app';
    btnOpen.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></span><span class="agy-btn-text">打开</span>';
    btnOpen.onclick = (e) => {
      e.stopPropagation();
      openInSystem(rawPath, false).then((res) => {
        showToast(res.ok ? '已在系统应用中打开' : `打开失败: ${res.error || '未知错误'}`);
      });
    };
    actions.appendChild(btnOpen);

    const btnReveal = document.createElement('button');
    btnReveal.className = 'agy-lightbox-btn';
    btnReveal.title = '在访达 / 资源管理器中显示 (Reveal in File Manager)';
    btnReveal.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></span><span class="agy-btn-text">定位</span>';
    btnReveal.onclick = (e) => {
      e.stopPropagation();
      openInSystem(rawPath, true).then((res) => {
        showToast(res.ok ? '已在文件管理器中定位' : `定位失败: ${res.error || '未知错误'}`);
      });
    };
    actions.appendChild(btnReveal);

    const btnCopyPath = document.createElement('button');
    btnCopyPath.className = 'agy-lightbox-btn';
    btnCopyPath.title = '复制完整文件路径';
    btnCopyPath.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span><span class="agy-btn-text">复制路径</span>';
    btnCopyPath.onclick = (e) => {
      e.stopPropagation();
      if (navigator.clipboard) {
        navigator.clipboard.writeText(rawPath).then(() => {
          showToast('文件路径已复制到剪贴板');
          btnCopyPath.innerHTML = '<span class="agy-btn-text">✓ 已复制</span>';
          setTimeout(() => {
            btnCopyPath.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></span><span class="agy-btn-text">复制路径</span>';
          }, 1500);
        }).catch(() => {});
      }
    };
    actions.appendChild(btnCopyPath);
  }

  const divider = document.createElement('div');
  divider.className = 'agy-lightbox-divider';
  actions.appendChild(divider);

  const btnClose = document.createElement('button');
  btnClose.className = 'agy-lightbox-btn agy-lightbox-btn-close';
  btnClose.title = '关闭 (ESC)';
  btnClose.innerHTML = '<span class="agy-lightbox-btn-icon"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span><span class="agy-btn-text">关闭</span><span style="display:none">✕ 关闭</span>';
  btnClose.onclick = (e) => { e.stopPropagation(); callbacks.onClose(); };
  actions.appendChild(btnClose);

  return actions;
}

function buildErrorCard(rawPath: string | undefined, src: string): HTMLElement {
  const errorCard = document.createElement('div');
  errorCard.className = 'agy-lightbox-error-card';
  errorCard.style.display = 'none';

  const errorIcon = document.createElement('div');
  errorIcon.className = 'agy-lightbox-error-icon';
  errorIcon.innerHTML = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';

  const errorTitle = document.createElement('div');
  errorTitle.className = 'agy-lightbox-error-title';
  errorTitle.textContent = '无法直接预览媒体 / Media Preview Unavailable';

  const errorDesc = document.createElement('div');
  errorDesc.className = 'agy-lightbox-error-desc';
  errorDesc.textContent = rawPath || src;

  const errorHint = document.createElement('div');
  errorHint.className = 'agy-lightbox-error-hint';
  errorHint.textContent = '文件可能正在生成中、已移动或格式需由外部应用呈现。';

  errorCard.appendChild(errorIcon);
  errorCard.appendChild(errorTitle);
  errorCard.appendChild(errorDesc);
  errorCard.appendChild(errorHint);

  if (rawPath) {
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:14px;';

    const btnOpen = document.createElement('button');
    btnOpen.className = 'agy-lightbox-btn';
    btnOpen.textContent = '在访达/资源管理器中查找';
    btnOpen.onclick = () => {
      openInSystem(rawPath, true).then((r) => {
        showToast(r.ok ? '已在文件管理器中定位' : '无法定位文件');
      });
    };
    btnRow.appendChild(btnOpen);
    errorCard.appendChild(btnRow);
  }

  return errorCard;
}

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

  const isVideo = isVideoFile(rawPath || src);

  const header = document.createElement('div');
  header.className = 'agy-lightbox-header';

  const tagEl = document.createElement('span');
  tagEl.className = 'agy-lightbox-tag';
  tagEl.textContent = isVideo ? 'VIDEO' : 'IMG';
  header.appendChild(tagEl);

  const titleEl = document.createElement('div');
  titleEl.className = 'agy-lightbox-title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  const body = document.createElement('div');
  body.className = 'agy-lightbox-body';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'agy-lightbox-img-wrap';

  const updateTransform = () => {
    imgWrap.style.transform = `translate(${lightboxTranslateX}px, ${lightboxTranslateY}px) scale(${lightboxScale})`;
  };

  const closeLightbox = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    overlay.classList.remove('open');
    setTimeout(() => {
      overlay.remove();
      if (lightboxOverlay === overlay) lightboxOverlay = null;
    }, 200);
  };

  const actions = createActionButtons(rawPath, isVideo, {
    onZoomIn: () => {
      lightboxScale = Math.min(lightboxScale * 1.3, 5.0);
      updateTransform();
    },
    onZoomOut: () => {
      lightboxScale = Math.max(lightboxScale / 1.3, 0.2);
      updateTransform();
    },
    onReset: () => {
      lightboxScale = 1.0;
      lightboxTranslateX = 0;
      lightboxTranslateY = 0;
      updateTransform();
    },
    onClose: closeLightbox,
  });

  header.appendChild(actions);
  overlay.appendChild(header);

  const spinner = document.createElement('div');
  spinner.className = 'agy-lightbox-spinner';
  spinner.innerHTML = '<div class="agy-lightbox-spinner-ring"></div><div class="agy-lightbox-spinner-text">加载媒体中...</div>';

  const errorCard = buildErrorCard(rawPath, src);

  if (isVideo) {
    const video = document.createElement('video');
    video.className = 'agy-lightbox-video';
    video.src = src;
    video.controls = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;

    video.onerror = () => {
      spinner.style.display = 'none';
      video.style.display = 'none';
      errorCard.style.display = 'flex';
    };
    video.onloadeddata = () => {
      spinner.style.display = 'none';
      video.style.display = '';
      errorCard.style.display = 'none';
    };

    imgWrap.appendChild(spinner);
    imgWrap.appendChild(video);
    imgWrap.appendChild(errorCard);
  } else {
    const img = document.createElement('img');
    img.className = 'agy-lightbox-img';
    img.src = src;
    img.alt = title;
    currentLightboxImg = img;

    img.onerror = () => {
      spinner.style.display = 'none';
      img.style.display = 'none';
      errorCard.style.display = 'flex';
    };
    img.onload = () => {
      spinner.style.display = 'none';
      img.style.display = '';
      errorCard.style.display = 'none';
    };

    imgWrap.appendChild(spinner);
    imgWrap.appendChild(img);
    imgWrap.appendChild(errorCard);
  }

  body.appendChild(imgWrap);

  const hints = document.createElement('div');
  hints.className = 'agy-lightbox-hints';
  hints.textContent = isVideo ? 'ESC 退出 · 点击空白处关闭' : 'ESC 退出 · 滚轮缩放 · 拖拽平移';
  overlay.appendChild(hints);
  overlay.appendChild(body);

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

  // Drag and pan (only for images)
  body.onmousedown = (e) => {
    if (isVideo) return;
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

  if (!isVideo) {
    body.onwheel = (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 0.87;
      lightboxScale = Math.max(0.2, Math.min(lightboxScale * factor, 5.0));
      updateTransform();
    };
  }

  document.body.appendChild(overlay);
  lightboxOverlay = overlay;
  requestAnimationFrame(() => overlay.classList.add('open'));
}

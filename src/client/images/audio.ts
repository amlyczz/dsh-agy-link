// Inline audio player enhancer for local audio file links rendered in DSH chat.
import { translateOr } from '../i18n-bridge.ts';
import { buildMediaUrl, openInSystem } from './media.ts';
import { showToast } from './lightbox.ts';

export function enhanceAudioLink(link: HTMLAnchorElement, rawHref: string, resolvedHref: string): void {
  link.dataset.agyAudioEnhanced = 'true';
  const pathToUse = rawHref.startsWith('file://')
    ? rawHref
    : (resolvedHref.startsWith('file://') ? resolvedHref : (rawHref || resolvedHref));
  const mediaUrl = buildMediaUrl(pathToUse);
  const fileName = (pathToUse.split(/[/\\]/).pop() || link.textContent || 'Audio').trim();

  if (!link.querySelector('.agy-audio-link-icon')) {
    const badge = document.createElement('span');
    badge.className = 'agy-image-link-chip agy-chip-audio agy-audio-link-icon';
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');
    badge.title = translateOr('audio.toggleTitle', 'Play/toggle audio player ({name})', { name: fileName });
    badge.innerHTML = '<span class="agy-image-chip-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></span><span class="agy-image-chip-text">' + translateOr('audio.listenChip', 'Listen') + '</span>';
    const togglePlayer = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const next = link.nextElementSibling as HTMLElement | null;
      if (next && next.classList.contains('agy-audio-card')) {
        next.style.display = next.style.display === 'none' ? 'flex' : 'none';
      }
    };
    badge.onclick = togglePlayer;
    badge.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') togglePlayer(e);
    };
    link.appendChild(badge);
  }

  const next = link.nextElementSibling as HTMLElement | null;
  if (next && next.classList.contains('agy-audio-card')) return;

  const card = document.createElement('div');
  card.className = 'agy-audio-card';

  const header = document.createElement('div');
  header.className = 'agy-audio-card-head';

  const title = document.createElement('span');
  title.className = 'agy-audio-card-title';
  title.textContent = fileName;
  title.title = pathToUse;

  const revealBtn = document.createElement('button');
  revealBtn.type = 'button';
  revealBtn.className = 'agy-audio-card-open';
  revealBtn.textContent = translateOr('audio.openBtn', 'Open');
  revealBtn.onclick = (e) => {
    e.stopPropagation();
    openInSystem(pathToUse, true).then((res) => {
      if (!res.ok) {
        showToast(translateOr('file.openFailed', 'Could not open: {error}', {
          error: res.error || translateOr('file.notFound', 'file not found'),
        }));
      }
    });
  };

  header.appendChild(title);
  header.appendChild(revealBtn);

  const audio = document.createElement('audio');
  audio.className = 'agy-audio-player';
  audio.controls = true;
  audio.preload = 'metadata';
  audio.src = mediaUrl;

  card.appendChild(header);
  card.appendChild(audio);
  link.insertAdjacentElement('afterend', card);
}

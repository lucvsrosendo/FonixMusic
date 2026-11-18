const cover = document.getElementById('cover');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const fill = document.getElementById('progress-fill');
const progress = document.getElementById('progress');
const btnPrev = document.getElementById('btn-prev');
const btnPlay = document.getElementById('btn-play');
const btnNext = document.getElementById('btn-next');
const volume = document.getElementById('volume');
const bubble = document.querySelector('.bubble');

const PLAY_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7L8 5z"/></svg>';
const PAUSE_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>';

const PLACEHOLDER =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect fill="%23ffffff22" width="96" height="96" rx="10"/><text x="48" y="54" text-anchor="middle" fill="%23ffffff88" font-size="28" font-family="Segoe UI">♪</text></svg>'
  );

let lastCoverKey = null;
let locked = false;
let dragging = false;
let volumeHold = false;
let currentSong = null;
let localMode = false;
let lastLocalSrc = null;
let externalPosition = 0;
let externalDuration = 0;
let externalPlaying = false;
let externalUpdatedAt = performance.now();
let volumeTimer = null;
const audio = new Audio();
audio.preload = 'auto';

function setIdle() {
  titleEl.textContent = 'Nada tocando';
  artistEl.textContent = 'YouTube, Spotify ou músicas do PC';
  fill.style.width = '0%';
  progress.setAttribute('aria-valuenow', '0');
  if (lastCoverKey !== 'idle') {
    cover.src = PLACEHOLDER;
    lastCoverKey = 'idle';
  }
  btnPlay.innerHTML = PLAY_SVG;
}

function setCover(data) {
  if (data.coverDataUrl) {
    const key = 'data:' + data.coverDataUrl.slice(0, 80);
    if (key !== lastCoverKey) {
      lastCoverKey = key;
      cover.src = data.coverDataUrl;
    }
    return;
  }
  if (data.coverUrl) {
    const key = 'url:' + data.coverUrl;
    if (key !== lastCoverKey) {
      lastCoverKey = key;
      cover.src = data.coverUrl;
    }
    return;
  }
  if (data.thumbnail) {
    const key = 'b64:' + data.thumbnail.slice(0, 64);
    if (key !== lastCoverKey) {
      lastCoverKey = key;
      const mime =
        data.thumbMime ||
        (data.thumbnail.startsWith('iVBOR')
          ? 'image/png'
          : data.thumbnail.startsWith('R0lG')
            ? 'image/gif'
            : data.thumbnail.startsWith('UklGR')
              ? 'image/webp'
              : 'image/jpeg');
      cover.src = 'data:' + mime + ';base64,' + data.thumbnail;
    }
    return;
  }
  if (lastCoverKey !== 'idle') {
    cover.src = PLACEHOLDER;
    lastCoverKey = 'idle';
  }
}

function setSkip(btn, enabled) {
  btn.disabled = !enabled;
}

function syncVolume(data) {
  if (volumeHold || !data || typeof data.volume !== 'number') return;
  const pct = Math.round(Math.max(0, Math.min(1, data.volume)) * 100);
  if (Number(volume.value) !== pct) volume.value = String(pct);
  if (localMode) audio.volume = pct / 100;
}

let seeking = false;
let seekHoldUntil = 0;

function updateProgressUi(pos, dur) {
  if (seeking) return;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  fill.style.width = pct + '%';
  progress.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function currentDuration() {
  return localMode ? audio.duration || externalDuration || 0 : externalDuration;
}

function seekRatio(e) {
  const rect = progress.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function paintSeek(ratio) {
  fill.style.width = ratio * 100 + '%';
  progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
}

function commitSeek(ratio) {
  const dur = currentDuration();
  if (!(dur > 0)) return;
  const t = Math.max(0, Math.min(dur, ratio * dur));
  if (localMode) {
    audio.currentTime = t;
    window.music.localProgress({ position: t });
  } else {
    externalPosition = t;
    externalUpdatedAt = performance.now();
    seekHoldUntil = performance.now() + 1500;
    window.music.control('seek:' + t.toFixed(2));
  }
}

progress.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !(currentDuration() > 0)) return;
  e.stopPropagation();
  seeking = true;
  progress.classList.add('seeking');
  progress.setPointerCapture(e.pointerId);
  paintSeek(seekRatio(e));
});
progress.addEventListener('pointermove', (e) => {
  if (!seeking) return;
  e.stopPropagation();
  paintSeek(seekRatio(e));
});
function endSeek(e, commit) {
  if (!seeking) return;
  seeking = false;
  progress.classList.remove('seeking');
  try {
    progress.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  if (commit) commitSeek(seekRatio(e));
}
progress.addEventListener('pointerup', (e) => {
  e.stopPropagation();
  endSeek(e, true);
});
progress.addEventListener('pointercancel', (e) => endSeek(e, false));
progress.addEventListener('keydown', (e) => {
  const dur = currentDuration();
  if (!(dur > 0)) return;
  const cur = localMode
    ? audio.currentTime
    : externalPosition + (externalPlaying ? (performance.now() - externalUpdatedAt) / 1000 : 0);
  let next = null;
  if (e.key === 'ArrowRight') next = cur + 5;
  else if (e.key === 'ArrowLeft') next = cur - 5;
  if (next === null) return;
  e.preventDefault();
  commitSeek(Math.max(0, Math.min(1, next / dur)));
});

setInterval(() => {
  if (localMode || !externalPlaying || externalDuration <= 0) return;
  const elapsed = (performance.now() - externalUpdatedAt) / 1000;
  updateProgressUi(
    Math.min(externalDuration, externalPosition + elapsed),
    externalDuration
  );
}, 100);

function songFrom(data) {
  if (!data || data.idle || !data.title) return null;
  return {
    title: data.title,
    artist: data.artist || '',
    album: data.album || '',
    app: data.app || '',
    source: data.local ? 'local' : /spotify/i.test(data.app || '') ? 'spotify' : 'youtube',
    path: data.path || data.src || '',
    coverUrl: data.coverUrl || '',
    thumbnail: data.thumbnail || '',
    thumbMime: data.thumbMime || '',
    duration: data.duration > 0 ? data.duration : 0,
  };
}

function setLiked(on) {
  const btn = document.getElementById('btn-like');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.classList.toggle('active', !!on);
}

function applyTrack(data) {
  const prevSong = currentSong;
  currentSong = songFrom(data);
  setLiked(!!(data && data.liked));
  if (!data || data.idle) {
    if (localMode && data && data.local && data.stopped) {
      localMode = false;
      lastLocalSrc = null;
      audio.pause();
      audio.removeAttribute('src');
    }
    if (!localMode) setIdle();
    return;
  }

  if (data.local) {
    localMode = true;
    const nextTitle = data.title || 'Desconhecido';
    const nextArtist = data.artist || data.album || '';
    if (titleEl.textContent !== nextTitle) titleEl.textContent = nextTitle;
    if (artistEl.textContent !== nextArtist) artistEl.textContent = nextArtist;
    setCover(data);

    if (data.src && data.src !== lastLocalSrc) {
      lastLocalSrc = data.src;
      audio.src = data.src;
      audio.load();
    }

    const playing = String(data.status || '').toLowerCase() === 'playing';
    if (playing) {
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      audio.pause();
    }
    btnPlay.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
    btnPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Tocar');
    setSkip(btnPrev, data.canPrev !== false);
    setSkip(btnNext, data.canNext !== false);
    syncVolume(data);
    updateProgressUi(audio.currentTime || data.position || 0, data.duration || audio.duration || 0);
    return;
  }

  if (localMode) {
    localMode = false;
    audio.pause();
    lastLocalSrc = null;
  }

  const nextTitle = data.title || 'Desconhecido';
  const nextArtist = data.artist || data.album || '';
  titleEl.textContent = nextTitle;
  artistEl.textContent = nextArtist;

  const playing = String(data.status || '').toLowerCase() === 'playing';
  const incomingPos = Math.max(0, data.position || 0);
  externalDuration = data.duration > 0 ? data.duration : 0;
  externalPlaying = playing;
  // Right after a seek, ignore stale positions until the player catches up.
  const holdSeek =
    performance.now() < seekHoldUntil && Math.abs(incomingPos - externalPosition) > 2;
  if (!holdSeek) {
    externalPosition = incomingPos;
    externalUpdatedAt = performance.now();
  }
  updateProgressUi(externalPosition, externalDuration);
  btnPlay.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
  btnPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Tocar');
  const spotify = /spotify/i.test(data.app || '');
  setSkip(btnPrev, spotify || data.canPrev !== false);
  setSkip(btnNext, spotify || data.canNext !== false);
  syncVolume(data);
  const trackChanged =
    !prevSong ||
    prevSong.title !== (data.title || '') ||
    prevSong.artist !== (data.artist || '') ||
    Math.round(prevSong.duration || 0) !==
      Math.round(data.duration > 0 ? data.duration : 0);
  if (data.coverDataUrl || data.coverUrl || data.thumbnail) {
    setCover(data);
  } else if (trackChanged) {
    setCover({});
  }
}

audio.addEventListener('timeupdate', () => {
  if (!localMode) return;
  updateProgressUi(audio.currentTime, audio.duration || 0);
  window.music.localProgress({ position: audio.currentTime });
});

audio.addEventListener('ended', () => {
  if (!localMode) return;
  window.music.localProgress({ position: 0, ended: true });
});

window.music.onTrack(applyTrack);
setIdle();

btnPrev.addEventListener('click', (e) => {
  e.stopPropagation();
  window.music.control('prev');
});
btnNext.addEventListener('click', (e) => {
  e.stopPropagation();
  window.music.control('next');
});
btnPlay.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!localMode) {
    if (externalPlaying) {
      externalPosition += (performance.now() - externalUpdatedAt) / 1000;
    }
    externalPlaying = !externalPlaying;
    externalUpdatedAt = performance.now();
    btnPlay.innerHTML = externalPlaying ? PAUSE_SVG : PLAY_SVG;
    btnPlay.setAttribute('aria-label', externalPlaying ? 'Pausar' : 'Tocar');
  }
  window.music.control('toggle');
});

volume.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  volumeHold = true;
});
volume.addEventListener('input', () => {
  const v = Number(volume.value) / 100;
  if (localMode) audio.volume = v;
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(
    () => window.music.control('vol:' + v.toFixed(2)),
    35
  );
});
function releaseVolume() {
  volumeHold = false;
}
volume.addEventListener('change', releaseVolume);
volume.addEventListener('pointerup', releaseVolume);
volume.addEventListener('pointercancel', releaseVolume);

function wireToggle(btn) {
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const on = btn.getAttribute('aria-pressed') === 'true';
    btn.setAttribute('aria-pressed', on ? 'false' : 'true');
    btn.classList.toggle('active', !on);
  });
}
wireToggle(document.getElementById('btn-shuffle'));
wireToggle(document.getElementById('btn-repeat'));

document.getElementById('btn-like').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!currentSong) return;
  const on = document.getElementById('btn-like').getAttribute('aria-pressed') !== 'true';
  setLiked(on);
  window.music.like(currentSong, on);
});

function openCurrent(e) {
  e.stopPropagation();
  if (currentSong) window.music.openSong(currentSong);
}
cover.addEventListener('click', openCurrent);
titleEl.addEventListener('click', openCurrent);

bubble.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.music.openMenu();
});

bubble.addEventListener('pointerdown', (e) => {
  if (locked || e.button !== 0) return;
  if (e.target.closest('button, a, input, #cover, #title, #progress')) return;
  dragging = true;
  bubble.setPointerCapture(e.pointerId);
  window.music.dragStart();
});

bubble.addEventListener('pointermove', () => {
  if (!dragging) return;
  window.music.dragMove();
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  try {
    bubble.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  window.music.dragEnd();
}

bubble.addEventListener('pointerup', endDrag);
bubble.addEventListener('pointercancel', endDrag);

function applyUiSettings(s) {
  if (!s) return;
  if (typeof s.opacity === 'number') {
    document.documentElement.style.setProperty('--opacity', String(s.opacity));
  }
  document.body.dataset.size = s.size || 'M';
  document.body.dataset.theme = s.theme || 'glass';
  locked = !!s.locked;
  bubble.classList.toggle('locked', locked);
}

window.music.getSettings().then(applyUiSettings);
if (window.music.onSettings) window.music.onSettings(applyUiSettings);

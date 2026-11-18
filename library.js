const fs = require('fs');
const path = require('path');
const https = require('https');
const { app, shell } = require('electron');
const { normalizeQuery } = require('./enrich');

const MAX_SONGS = 400;

function filePath() {
  return path.join(app.getPath('userData'), 'library.json');
}

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = Array.isArray(data.songs) ? data.songs : [];
  } catch {
    cache = [];
  }
  return cache;
}

function save(songs) {
  cache = songs;
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify({ songs }, null, 2), 'utf8');
}

function keyOf(track) {
  if (!track || !track.title) return '';
  const { title, artist } = normalizeQuery(track.title, track.artist);
  const name = (title || track.title || '').trim().toLowerCase();
  if (!name || name === 'nada tocando' || name === 'desconhecido') return '';
  const who = (artist || '').trim().toLowerCase();
  return `${who}||${name}`;
}

function sourceOf(track) {
  if (track.local || track.path) return 'local';
  if (/spotify/i.test(track.app || track.source || '')) return 'spotify';
  return 'youtube';
}

function coverOf(track, prev) {
  if (track.coverUrl) return track.coverUrl;
  if (prev && prev.cover) return prev.cover;
  const b64 = track.thumbnail || '';
  if (b64 && b64.length < 80000) {
    const mime = track.thumbMime || (b64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg');
    return `data:${mime};base64,${b64}`;
  }
  return prev ? prev.cover : '';
}

function remember(track, countPlay = true) {
  const id = keyOf(track);
  if (!id) return null;
  const songs = load();
  const now = new Date().toISOString();
  let row = songs.find((s) => s.id === id);
  if (!row) {
    row = {
      id,
      title: track.title,
      artist: track.artist || '',
      album: track.album || '',
      source: sourceOf(track),
      path: track.path || '',
      cover: coverOf(track, null),
      liked: false,
      plays: 1,
      playedAt: now,
    };
    songs.unshift(row);
  } else {
    row.title = track.title || row.title;
    row.artist = track.artist || row.artist;
    row.album = track.album || row.album;
    row.source = sourceOf(track);
    if (track.path) row.path = track.path;
    row.cover = coverOf(track, row);
    if (countPlay) {
      row.plays = (row.plays || 1) + 1;
      row.playedAt = now;
    }
    songs.splice(songs.indexOf(row), 1);
    songs.unshift(row);
  }
  save(songs.slice(0, MAX_SONGS));
  return row;
}

function isLiked(track) {
  const id = keyOf(track);
  if (!id) return false;
  const row = load().find((s) => s.id === id);
  return !!(row && row.liked);
}

function setLiked(track, liked) {
  const row = remember(track, false);
  if (!row) return null;
  const songs = load();
  const found = songs.find((s) => s.id === row.id);
  if (found) found.liked = !!liked;
  save(songs);
  return found;
}

function list() {
  return load();
}

function fetchText(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchText(res.headers.location));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (raw.length < 500000) raw += chunk;
        });
        res.on('end', () => resolve(raw));
      }
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => {
      req.destroy();
      resolve('');
    });
  });
}

async function openSong(song) {
  if (!song || !song.title) return;
  const source = song.source || sourceOf(song);
  if (source === 'local' && song.path && fs.existsSync(song.path)) {
    return { type: 'local', path: song.path };
  }
  const q = [song.artist, song.title].filter(Boolean).join(' ').trim();
  if (source === 'spotify') {
    const uri = 'spotify:search:' + encodeURIComponent(q);
    try {
      await shell.openExternal(uri);
      return { type: 'spotify' };
    } catch {
      await shell.openExternal('https://open.spotify.com/search/' + encodeURIComponent(q));
      return { type: 'spotify-web' };
    }
  }
  const search = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q + ' official audio');
  const html = await fetchText(search);
  const match = html && html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  const url = match
    ? 'https://www.youtube.com/watch?v=' + match[1] + '&autoplay=1'
    : search;
  await shell.openExternal(url);
  return { type: 'youtube' };
}

module.exports = { remember, isLiked, setLiked, list, keyOf, sourceOf, openSong };

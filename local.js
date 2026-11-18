const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { enrichTrack } = require('./enrich');

let metadataModule;
async function parseMetadata(filePath) {
  metadataModule ||= import('music-metadata');
  const { parseFile } = await metadataModule;
  return parseFile(filePath, { duration: true, skipCovers: false });
}

const AUDIO_EXT = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wma',
  '.aiff',
  '.aif',
]);

function isAudio(file) {
  return AUDIO_EXT.has(path.extname(file).toLowerCase());
}

function walkDir(dir, out = [], depth = 0) {
  if (depth > 4 || out.length > 500) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, out, depth + 1);
    else if (ent.isFile() && isAudio(full)) out.push(full);
    if (out.length > 500) break;
  }
  return out;
}

async function readTrack(filePath) {
  const base = {
    path: filePath,
    title: path.parse(filePath).name,
    artist: 'Arquivo local',
    album: '',
    duration: 0,
    thumbnail: null,
    coverUrl: null,
    local: true,
  };
  try {
    const meta = await parseMetadata(filePath);
    base.title = meta.common.title || base.title;
    base.artist =
      meta.common.artist ||
      meta.common.albumartist ||
      meta.common.artists?.[0] ||
      base.artist;
    base.album = meta.common.album || '';
    base.duration = meta.format.duration || 0;
    const pic = meta.common.picture?.[0];
    if (pic?.data) {
      const b64 = Buffer.from(pic.data).toString('base64');
      const mime = pic.format || 'image/jpeg';
      base.thumbnail = b64;
      base.coverDataUrl = `data:${mime};base64,${b64}`;
    }
  } catch {
    /* keep filename defaults */
  }

  if (!base.coverDataUrl) {
    try {
      const enriched = await enrichTrack({
        idle: false,
        title: base.title,
        artist: base.artist === 'Arquivo local' ? '' : base.artist,
      });
      if (enriched.coverUrl) base.coverUrl = enriched.coverUrl;
      if (enriched.title) base.title = enriched.title;
      if (enriched.artist) base.artist = enriched.artist;
      if (enriched.album) base.album = enriched.album;
    } catch {
      /* ignore */
    }
  }

  return base;
}

class LocalPlayer extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.index = -1;
    this.active = false;
    this.status = 'Paused';
    this.position = 0;
  }

  current() {
    if (this.index < 0 || this.index >= this.queue.length) return null;
    return this.queue[this.index];
  }

  snapshot() {
    const track = this.current();
    if (!track) {
      return { idle: true, local: true };
    }
    return {
      idle: false,
      local: true,
      title: track.title,
      artist: track.artist,
      album: track.album,
      status: this.status,
      position: this.position,
      duration: track.duration || 0,
      canPlay: true,
      canPause: true,
      canNext: this.queue.length > 1,
      canPrev: this.queue.length > 1,
      thumbnail: track.thumbnail,
      coverUrl: track.coverUrl || null,
      coverDataUrl: track.coverDataUrl || null,
      path: track.path,
      src: 'localaudio://' + encodeURIComponent(track.path),
      index: this.index,
      total: this.queue.length,
    };
  }

  emitState() {
    this.emit('update', this.snapshot());
  }

  async loadPaths(paths) {
    const files = [...new Set(paths.filter(isAudio))];
    if (!files.length) return false;
    const tracks = [];
    for (const f of files) {
      tracks.push(await readTrack(f));
    }
    this.queue = tracks;
    this.index = 0;
    this.active = true;
    this.status = 'Playing';
    this.position = 0;
    this.emitState();
    return true;
  }

  async loadFolder(dir) {
    const files = walkDir(dir).sort((a, b) => a.localeCompare(b));
    return this.loadPaths(files);
  }

  playIndex(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.active = true;
    this.status = 'Playing';
    this.position = 0;
    this.emitState();
  }

  toggle() {
    if (!this.active || !this.current()) return;
    this.status = this.status === 'Playing' ? 'Paused' : 'Playing';
    this.emitState();
  }

  next() {
    if (!this.queue.length) return;
    this.index = (this.index + 1) % this.queue.length;
    this.status = 'Playing';
    this.position = 0;
    this.emitState();
  }

  prev() {
    if (!this.queue.length) return;
    this.index = (this.index - 1 + this.queue.length) % this.queue.length;
    this.status = 'Playing';
    this.position = 0;
    this.emitState();
  }

  setPosition(pos) {
    this.position = Math.max(0, Number(pos) || 0);
  }

  stop() {
    this.active = false;
    this.status = 'Paused';
    this.position = 0;
    this.emit('update', { idle: true, local: true, stopped: true });
  }

  control(cmd) {
    switch (cmd) {
      case 'toggle':
        this.toggle();
        break;
      case 'play':
        this.status = 'Playing';
        this.emitState();
        break;
      case 'pause':
        this.status = 'Paused';
        this.emitState();
        break;
      case 'next':
        this.next();
        break;
      case 'prev':
        this.prev();
        break;
      default:
        break;
    }
  }
}

module.exports = { LocalPlayer, isAudio, walkDir };

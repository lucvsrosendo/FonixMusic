const https = require('https');

const cache = new Map();
const inflight = new Map();

function cleanChannel(name) {
  return String(name || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/vevo$/i, '')
    .replace(/\b(official|youtube music|youtube)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeQuery(title, artist) {
  let t = String(title || '');
  const rawArtist = String(artist || '');
  t = t
    .replace(/\s+-\s+YouTube Music$/i, '')
    .replace(/\s+-\s+YouTube$/i, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*(official|video|audio|lyrics|visualizer|hd|4k|mv|topic)[^)]*\)/gi, ' ')
    .replace(/\b(official\s*(music\s*)?video|lyrics?|audio|visualizer|hd|4k|mv|topic)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let a = cleanChannel(rawArtist);
  const channelish = !rawArtist || /vevo|topic|youtube|brave|chrome/i.test(rawArtist);

  if (t.includes(' - ')) {
    const parts = t.split(/\s+-\s+/);
    if (parts.length >= 2) {
      const left = parts[0].trim();
      const right = parts.slice(1).join(' - ').trim();
      const leftClean = cleanChannel(left);
      if (
        channelish ||
        a.toLowerCase() === left.toLowerCase() ||
        (a && left.toLowerCase().startsWith(a.toLowerCase()))
      ) {
        a = a && left.toLowerCase().startsWith(a.toLowerCase()) ? a : leftClean || left;
        t = right;
      }
    }
  }

  return { title: t, artist: a, key: `${a}||${t}`.toLowerCase() };
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'MusicBubble/1.0' }, timeout: 6000 },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error('http ' + res.statusCode));
          return;
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function pickBest(results, title, artist) {
  if (!results || !results.length) return null;
  const tl = title.toLowerCase();
  const al = artist.toLowerCase();
  let best = null;
  let bestScore = -1;
  for (const r of results) {
    let score = 0;
    const rt = String(r.trackName || '').toLowerCase();
    const ra = String(r.artistName || '').toLowerCase();
    if (rt === tl) score += 50;
    else if (rt.includes(tl) || tl.includes(rt)) score += 25;
    if (al && ra === al) score += 40;
    else if (al && (ra.includes(al) || al.includes(ra))) score += 20;
    if (r.artworkUrl100) score += 5;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 25 ? best : null;
}

async function lookupItunes(title, artist) {
  const term = encodeURIComponent([artist, title].filter(Boolean).join(' ').trim());
  if (!term) return null;
  const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=8`;
  const data = await httpGetJson(url);
  const hit = pickBest(data.results || [], title, artist);
  if (!hit) return null;
  const art = hit.artworkUrl100
    ? String(hit.artworkUrl100).replace('100x100bb', '600x600bb')
    : null;
  return {
    title: hit.trackName || title,
    artist: hit.artistName || artist,
    album: hit.collectionName || '',
    coverUrl: art,
    source: 'itunes',
  };
}

async function enrichTrack(raw) {
  if (!raw || raw.idle) return raw;
  const { title, artist, key } = normalizeQuery(raw.title, raw.artist);
  if (!title) return raw;
  const parsed = withParsed(raw, title, artist);
  if (raw.thumbnail && artist && !/vevo|topic|youtube|brave|chrome/i.test(raw.artist || '')) {
    return parsed;
  }

  if (cache.has(key)) {
    const cached = cache.get(key);
    return merge(raw, cached, title, artist);
  }

  if (inflight.has(key)) {
    try {
      const cached = await inflight.get(key);
      return merge(raw, cached, title, artist);
    } catch {
      return withParsed(raw, title, artist);
    }
  }

  const p = lookupItunes(title, artist)
    .then((hit) => {
      cache.set(key, hit);
      inflight.delete(key);
      return hit;
    })
    .catch(() => {
      inflight.delete(key);
      cache.set(key, null);
      return null;
    });
  inflight.set(key, p);

  try {
    const hit = await p;
    return merge(raw, hit, title, artist);
  } catch {
    return withParsed(raw, title, artist);
  }
}

function withParsed(raw, title, artist) {
  return {
    ...raw,
    title: title || raw.title,
    artist: artist || raw.artist,
  };
}

function merge(raw, hit, parsedTitle, parsedArtist) {
  const out = withParsed(raw, parsedTitle, parsedArtist);
  if (!hit) return out;
  return {
    ...out,
    title: hit.title || out.title,
    artist: hit.artist || out.artist,
    album: hit.album || out.album,
    coverUrl: hit.coverUrl || null,
    enriched: true,
  };
}

module.exports = { enrichTrack, normalizeQuery };

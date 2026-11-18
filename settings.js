const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  opacity: 1,
  size: 'M',
  mode: 'desktop', // desktop | top
  theme: 'glass', // glass | holo
  locked: false,
  startWithWindows: false,
  x: undefined,
  y: undefined,
};

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(settings, null, 2), 'utf8');
}

const SIZES = {
  P: { width: 300, height: 168 },
  M: { width: 380, height: 198 },
  G: { width: 460, height: 228 },
};

module.exports = { load, save, DEFAULTS, SIZES };

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  dialog,
  protocol,
  net,
} = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const settingsStore = require('./settings');
const { MediaService } = require('./media');
const { enrichTrack } = require('./enrich');
const { LocalPlayer } = require('./local');
const library = require('./library');
const {
  detachFromDesktop,
  moveToBottom,
} = require('./desktop');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'localaudio',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

let win = null;
let tray = null;
let libraryWin = null;
let lastSavedKey = '';
let settings = null;
let dragging = false;
let dragOrigin = null;
const media = new MediaService();
const localPlayer = new LocalPlayer();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show();
      applyMode();
    }
  });
}

function iconPath() {
  const ico = path.join(__dirname, 'build', 'icon.ico');
  const png = path.join(__dirname, 'build', 'icon.png');
  const fs = require('fs');
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return null;
}

function loadIcon() {
  const p = iconPath();
  if (!p) return nativeImage.createEmpty();
  return nativeImage.createFromPath(p);
}

function stopDesktopKeepAlive() {
  // No polling: spawning PowerShell repeatedly made startup/runtime sluggish.
}

function startDesktopKeepAlive() {
  // Window events already restore desktop z-order when needed.
}

async function applyMode() {
  if (!win || win.isDestroyed() || dragging) return;
  if (settings.mode === 'top') {
    stopDesktopKeepAlive();
    await detachFromDesktop(win);
    win.setAlwaysOnTop(true, 'floating');
  } else {
    win.setAlwaysOnTop(false);
    // only z-order behind apps — do NOT SetParent to WorkerW (breaks drag/clicks)
    await moveToBottom(win);
    startDesktopKeepAlive();
  }
}

function applySize() {
  if (!win) return;
  const size = settingsStore.SIZES[settings.size] || settingsStore.SIZES.M;
  win.setSize(size.width, size.height);
}

function applyOpacity() {
  if (!win) return;
  win.setOpacity(settings.opacity);
  if (!win.isDestroyed()) win.webContents.send('settings', settings);
}

function pushSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('settings', settings);
}

function applyLock() {
  if (!win) return;
  win.setMovable(!settings.locked);
  if (!win.isDestroyed()) win.webContents.send('settings', settings);
}

function persistPosition() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  settings.x = x;
  settings.y = y;
  settingsStore.save(settings);
}

function clampToWorkArea(x, y, w, h) {
  const displays = screen.getAllDisplays();
  let best = screen.getPrimaryDisplay().workArea;
  let bestDist = Infinity;
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (const d of displays) {
    const a = d.workArea;
    const dx = Math.max(a.x - cx, 0, cx - (a.x + a.width));
    const dy = Math.max(a.y - cy, 0, cy - (a.y + a.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  const nx = Math.min(Math.max(x, best.x), best.x + best.width - w);
  const ny = Math.min(Math.max(y, best.y), best.y + best.height - h);
  return { x: Math.round(nx), y: Math.round(ny) };
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? 'Ocultar' : 'Mostrar',
      click: () => {
        if (!win) return;
        if (win.isVisible()) win.hide();
        else {
          win.show();
          applyMode();
        }
        tray.setContextMenu(buildMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Biblioteca',
      click: () => openLibrary(),
    },
    {
      label: 'Abrir músicas...',
      click: () => openLocalFiles(),
    },
    {
      label: 'Abrir pasta...',
      click: () => openLocalFolder(),
    },
    {
      label: 'Parar músicas do PC',
      enabled: !!localPlayer.active,
      click: () => {
        localPlayer.stop();
        tray.setContextMenu(buildMenu());
      },
    },
    { type: 'separator' },
    {
      label: 'Travar posição',
      type: 'checkbox',
      checked: !!settings.locked,
      click: (item) => {
        settings.locked = item.checked;
        settingsStore.save(settings);
        applyLock();
      },
    },
    {
      label: 'Opacidade',
      submenu: [100, 85, 70].map((pct) => ({
        label: pct + '%',
        type: 'radio',
        checked: Math.round(settings.opacity * 100) === pct,
        click: () => {
          settings.opacity = pct / 100;
          settingsStore.save(settings);
          applyOpacity();
        },
      })),
    },
    {
      label: 'Tamanho',
      submenu: ['P', 'M', 'G'].map((s) => ({
        label: s,
        type: 'radio',
        checked: settings.size === s,
        click: () => {
          settings.size = s;
          settingsStore.save(settings);
          applySize();
          pushSettings();
        },
      })),
    },
    {
      label: 'Estilo',
      submenu: [
        {
          label: 'Anime Glass',
          type: 'radio',
          checked: (settings.theme || 'glass') === 'glass',
          click: () => {
            settings.theme = 'glass';
            settingsStore.save(settings);
            pushSettings();
          },
        },
        {
          label: 'Vidro Holográfico',
          type: 'radio',
          checked: settings.theme === 'holo',
          click: () => {
            settings.theme = 'holo';
            settingsStore.save(settings);
            pushSettings();
          },
        },
      ],
    },
    {
      label: 'Modo',
      submenu: [
        {
          label: 'Área de trabalho',
          type: 'radio',
          checked: settings.mode === 'desktop',
          click: () => {
            settings.mode = 'desktop';
            settingsStore.save(settings);
            applyMode();
          },
        },
        {
          label: 'Sempre no topo',
          type: 'radio',
          checked: settings.mode === 'top',
          click: () => {
            settings.mode = 'top';
            settingsStore.save(settings);
            applyMode();
          },
        },
      ],
    },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: !!settings.startWithWindows,
      click: (item) => {
        settings.startWithWindows = item.checked;
        settingsStore.save(settings);
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function stampTrack(data) {
  if (!data || data.idle || !data.title) return data;
  try {
    const id = library.keyOf(data);
    if (!id) return data;
    if (id !== lastSavedKey) {
      lastSavedKey = id;
      library.remember(data, true);
      if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('library-changed');
    } else if (data.coverUrl || data.thumbnail) {
      library.remember(data, false);
    }
    return { ...data, liked: library.isLiked(data) };
  } catch {
    return data;
  }
}

function openLibrary() {
  if (libraryWin && !libraryWin.isDestroyed()) {
    libraryWin.show();
    libraryWin.focus();
    return;
  }
  libraryWin = new BrowserWindow({
    width: 420,
    height: 560,
    title: 'Fonix Music',
    autoHideMenuBar: true,
    backgroundColor: '#12141a',
    icon: iconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  libraryWin.loadFile(path.join(__dirname, 'library.html'));
  libraryWin.on('closed', () => {
    libraryWin = null;
  });
}

async function openLocalFiles() {
  const result = await dialog.showOpenDialog({
    title: 'Abrir músicas',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Áudio',
        extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif'],
      },
    ],
  });
  if (result.canceled || !result.filePaths.length) return;
  await localPlayer.loadPaths(result.filePaths);
  if (tray) tray.setContextMenu(buildMenu());
}

async function openLocalFolder() {
  const result = await dialog.showOpenDialog({
    title: 'Abrir pasta de músicas',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return;
  await localPlayer.loadFolder(result.filePaths[0]);
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  const icon = loadIcon();
  tray = new Tray(
    icon.isEmpty()
      ? nativeImage.createFromDataURL(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAdElEQVRYR+2WMQ4AIAgD7f8/3cTFQcWgBdpE5yYN5QAoEAUCgUAgEAj8VyAvd5lZq5l5iYi9u7uZmYjsewDk3N3M3ETEzMzEzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM/ALq0gCkQCAQC/wN4ATcQ9Qe7QJ9RAAAAAElFTkSuQmCC'
        )
      : icon
  );
  tray.setToolTip('Fonix Music');
  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
    else {
      win.show();
      applyMode();
    }
    tray.setContextMenu(buildMenu());
  });
}

function createWindow() {
  const size = settingsStore.SIZES[settings.size] || settingsStore.SIZES.M;
  const display = screen.getPrimaryDisplay().workArea;
  const x =
    typeof settings.x === 'number'
      ? settings.x
      : Math.round(display.x + display.width - size.width - 24);
  const y =
    typeof settings.y === 'number'
      ? settings.y
      : Math.round(display.y + display.height - size.height - 24);

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: settings.mode === 'top',
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    opacity: settings.opacity,
    icon: iconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setMovable(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.showInactive();
    applyMode();
  });

  win.on('show', () => {
    if (settings.mode === 'desktop' && !dragging) applyMode();
  });

  win.on('blur', () => {
    if (settings.mode === 'desktop' && !dragging) moveToBottom(win);
  });

  win.on('focus', () => {
    if (settings.mode === 'desktop' && !dragging) moveToBottom(win);
  });

  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
      tray.setContextMenu(buildMenu());
    }
  });

  win.webContents.on('did-finish-load', () => {
    if (media.last) win.webContents.send('track', media.last);
    pushSettings();
  });
}

function wireIpc() {
  ipcMain.handle('control', (_e, cmd) => {
    if (typeof cmd === 'string' && cmd.startsWith('vol:')) {
      media.control(cmd);
      return;
    }
    if (typeof cmd === 'string' && cmd.startsWith('seek:')) {
      const sec = Number(cmd.slice(5));
      if (!Number.isFinite(sec)) return;
      if (localPlayer.active) localPlayer.setPosition(sec);
      else media.control('seek:' + sec.toFixed(2));
      return;
    }
    if (localPlayer.active) localPlayer.control(cmd);
    else media.control(cmd);
  });
  ipcMain.handle('get-settings', () => settings);
  ipcMain.handle('set-settings', (_e, partial) => {
    settings = { ...settings, ...partial };
    settingsStore.save(settings);
    applyOpacity();
    applySize();
    applyMode();
    applyLock();
    return settings;
  });
  ipcMain.on('open-menu', () => {
    if (tray) tray.popUpContextMenu(buildMenu());
  });
  ipcMain.handle('library-list', () => library.list());
  ipcMain.handle('library-like', (_e, song, liked) => {
    const row = library.setLiked(song, liked);
    if (libraryWin && !libraryWin.isDestroyed()) libraryWin.webContents.send('library-changed');
    return row;
  });
  ipcMain.handle('library-open', async (_e, song) => {
    const result = await library.openSong(song);
    if (result && result.type === 'local' && result.path) {
      await localPlayer.loadPaths([result.path]);
    }
    return result || null;
  });
  ipcMain.on('local-progress', (_e, payload) => {
    if (!localPlayer.active) return;
    if (payload && typeof payload.position === 'number') {
      localPlayer.setPosition(payload.position);
    }
    if (payload && payload.ended) {
      localPlayer.next();
    }
  });

  ipcMain.on('drag-start', () => {
    if (!win || win.isDestroyed() || settings.locked) return;
    const cursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    dragOrigin = { cx: cursor.x, cy: cursor.y, wx, wy, moved: false };
    dragging = true;
  });

  ipcMain.on('drag-move', () => {
    if (!dragOrigin || !win || win.isDestroyed() || settings.locked) return;
    const cursor = screen.getCursorScreenPoint();
    const dx = cursor.x - dragOrigin.cx;
    const dy = cursor.y - dragOrigin.cy;
    if (!dragOrigin.moved) {
      if (dx * dx + dy * dy < 9) return;
      dragOrigin.moved = true;
    }
    const [w, h] = win.getSize();
    const pos = clampToWorkArea(dragOrigin.wx + dx, dragOrigin.wy + dy, w, h);
    win.setPosition(pos.x, pos.y, false);
  });

  ipcMain.on('drag-end', () => {
    const moved = !!(dragOrigin && dragOrigin.moved);
    dragOrigin = null;
    dragging = false;
    if (!win || win.isDestroyed()) return;
    if (moved) persistPosition();
    if (settings.mode === 'desktop') moveToBottom(win);
    else if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'floating');
  });
}

function sendTrack(data) {
  if (win && !win.isDestroyed()) win.webContents.send('track', data);
}

app.whenReady().then(() => {
  protocol.handle('localaudio', (request) => {
    try {
      const encoded = request.url.replace(/^localaudio:\/\//i, '');
      const filePath = decodeURIComponent(encoded);
      return net.fetch(pathToFileURL(filePath).href);
    } catch (err) {
      return new Response('not found', { status: 404 });
    }
  });

  settings = settingsStore.load();
  app.setLoginItemSettings({
    openAtLogin: !!settings.startWithWindows,
    path: process.execPath,
  });
  wireIpc();
  createWindow();
  createTray();
  let mediaSeq = 0;
  media.on('update', async (data) => {
    const externalActive =
      data &&
      !data.idle &&
      /^(playing|paused)$/i.test(String(data.status || ''));
    const externalPlaying =
      data && !data.idle && String(data.status || '').toLowerCase() === 'playing';
    // Only suppress SMTC while local is active AND there is no external session to show.
    if (localPlayer.active && !externalActive) return;
    if (localPlayer.active && externalPlaying) {
      localPlayer.active = false;
      localPlayer.status = 'Paused';
    }
    if (data && data.idle) {
      sendTrack(data);
      return;
    }
    const seq = ++mediaSeq;
    const shown = stampTrack(data);
    media.last = shown;
    sendTrack(shown);
    let enriched = data;
    try {
      enriched = await enrichTrack(data);
    } catch {
      enriched = data;
    }
    if (seq !== mediaSeq) return;
    if (localPlayer.active && !externalPlaying) return;
    if (!enriched.coverUrl && !enriched.thumbnail && data.thumbnail) {
      enriched.thumbnail = data.thumbnail;
      enriched.thumbMime = data.thumbMime;
    }
    const done = stampTrack(enriched);
    media.last = done;
    sendTrack(done);
  });
  localPlayer.on('update', (data) => {
    if (data.stopped) {
      sendTrack(media.last || { idle: true });
      if (tray) tray.setContextMenu(buildMenu());
      return;
    }
    sendTrack(stampTrack(data));
    if (tray) tray.setContextMenu(buildMenu());
  });
  // Render the widget first; initialize Windows media integration afterward.
  setTimeout(() => media.start(), 600);
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopDesktopKeepAlive();
  media.stop();
  if (win && !win.isDestroyed()) persistPosition();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win) win.show();
});

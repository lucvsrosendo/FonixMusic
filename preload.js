const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('music', {
  onTrack: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('track', handler);
    return () => ipcRenderer.removeListener('track', handler);
  },
  onSettings: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('settings', handler);
    return () => ipcRenderer.removeListener('settings', handler);
  },
  control: (cmd) => ipcRenderer.invoke('control', cmd),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('set-settings', partial),
  openMenu: () => ipcRenderer.send('open-menu'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  localProgress: (payload) => ipcRenderer.send('local-progress', payload),
  libraryList: () => ipcRenderer.invoke('library-list'),
  like: (song, liked) => ipcRenderer.invoke('library-like', song, liked),
  openSong: (song) => ipcRenderer.invoke('library-open', song),
  onLibrary: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('library-changed', handler);
    return () => ipcRenderer.removeListener('library-changed', handler);
  },
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goodtimes', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getLibrary: () => ipcRenderer.invoke('get-library'),
  onLibrary: (cb) => ipcRenderer.on('library', (_e, lib) => cb(lib)),
  onPlace: (cb) => ipcRenderer.on('place', (_e, p) => cb(p)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  quit: () => ipcRenderer.send('quit'),
  log: (...m) => ipcRenderer.send('log', ...m),
});

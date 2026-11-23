'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('walled', {
  openSite: (id) => ipcRenderer.invoke('open-site', id),
  setRecolor: (on) => ipcRenderer.invoke('set-recolor', on),
  getState: () => ipcRenderer.invoke('get-state'),
  openLog: () => ipcRenderer.invoke('open-log'),
  onEvent: (cb) => ipcRenderer.on('event', (_e, evt) => cb(evt)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
});

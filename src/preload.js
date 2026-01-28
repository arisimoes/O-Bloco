// Minimal preload script to satisfy BrowserWindow preload requirement.
// Kept intentionally small to avoid exposing Node.js internals.
// If you later want to expose APIs, use contextBridge here.

// Example (commented):
// const { contextBridge, ipcRenderer } = require('electron');
// contextBridge.exposeInMainWorld('electronAPI', {
//   invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
//   on: (channel, cb) => ipcRenderer.on(channel, cb)
// });

// No runtime code required for now.

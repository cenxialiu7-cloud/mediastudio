// Exposes a tiny, safe API to the setup wizard renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ms', {
  getState: () => ipcRenderer.invoke('mediastudio:get-state'),
  openLog: () => ipcRenderer.invoke('mediastudio:open-log'),
  openUserData: () => ipcRenderer.invoke('mediastudio:open-userdata'),
  runSetup: (options) => ipcRenderer.invoke('setup:run', options),
  launchMain: () => ipcRenderer.invoke('launch:main'),
  startVoice: (which) => ipcRenderer.invoke('voice:start', which),
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:progress', handler);
    return () => ipcRenderer.off('setup:progress', handler);
  }
});

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('snappy', {
  setDockWidth: (width) => ipcRenderer.send('dock:set-width', width),

  bluetooth: {
    // Resolves to the latest list of connected devices, or null if none has been reported yet.
    get: () => ipcRenderer.invoke('bluetooth:get'),
    onChange: (callback) => ipcRenderer.on('bluetooth:update', (_event, devices) => callback(devices)),
  },

  // The file shelf: things dropped on the dock, kept in memory so they can be swiped back to.
  files: {
    // A dropped File's real path on disk ('' if it isn't a file on disk, e.g. an image from a web page).
    pathFor: (file) => webUtils.getPathForFile(file),
    list: () => ipcRenderer.invoke('files:list'),
    addPaths: (paths) => ipcRenderer.invoke('files:add-paths', paths),
    addBytes: (name, bytes) => ipcRenderer.invoke('files:add-bytes', { name, bytes }),
    addText: (text) => ipcRenderer.invoke('files:add-text', text),
    remove: (id) => ipcRenderer.invoke('files:remove', id),
    copyPath: (id) => ipcRenderer.invoke('files:copy-path', id),
    copy: (id) => ipcRenderer.invoke('files:copy', id),
    startDrag: (id) => ipcRenderer.send('files:start-drag', id),
  },

  media: {
    // Latest track ({ key, title, artist, album, app, status, pos, dur, art }) or null when nothing plays.
    get: () => ipcRenderer.invoke('media:get'),
    // 'toggle' (play/pause), 'next' or 'prev'
    command: (command) => ipcRenderer.send('media:command', command),
    onChange: (callback) => ipcRenderer.on('media:update', (_event, media) => callback(media)),
  },
});

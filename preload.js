// Bridge between the renderer UI and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listItems: () => ipcRenderer.invoke("items:list"),
  saveItems: (items) => ipcRenderer.invoke("items:save", items),
  showListing: (itemId, bounds, opts) => ipcRenderer.invoke("listing:show", { itemId, bounds, ...opts }),
  hideListing: () => ipcRenderer.invoke("listing:hide"),
  zoomListing: (dir) => ipcRenderer.invoke("listing:zoom", dir),
  openExternal: (itemId) => ipcRenderer.invoke("listing:openExternal", itemId),
  onListingLoading: (cb) => ipcRenderer.on("listing:loading", (_e, loading) => cb(loading)),
  onListingNavigated: (cb) => ipcRenderer.on("listing:navigated", (_e, itemId) => cb(itemId)),
  readClipboard: () => ipcRenderer.invoke("clip:read"),
  writeClipboard: (t) => ipcRenderer.invoke("clip:write", t),
  importSheet: () => ipcRenderer.invoke("sheet:import"),
  exportSheet: (rows) => ipcRenderer.invoke("sheet:export", rows),
});

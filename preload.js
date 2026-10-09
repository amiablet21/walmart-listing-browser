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
  exportRepricer: (payload) => ipcRenderer.invoke("sheet:exportRepricer", payload),
  // Walmart Marketplace API (Buy Box scan)
  getApiSettings: () => ipcRenderer.invoke("api:getSettings"),
  saveApiSettings: (patch) => ipcRenderer.invoke("api:saveSettings", patch),
  testApi: (override) => ipcRenderer.invoke("api:test", override),
  scanBuyBox: (skus) => ipcRenderer.invoke("api:scanBuyBox", skus),
  onScanProgress: (cb) => ipcRenderer.on("api:progress", (_e, p) => cb(p)),
  openApiDocs: () => ipcRenderer.invoke("api:openDocs"),
  openApiKeys: () => ipcRenderer.invoke("api:openKeys"),
});

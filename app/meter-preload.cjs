// The floating meter page's only access to the app: a few one-way messages and the hidden-accounts list.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiMeter", {
  setInteractive: (on) => ipcRenderer.send("meter:interactive", Boolean(on)),
  setHeight: (px) => ipcRenderer.send("meter:height", Number(px)),
  open: () => ipcRenderer.send("meter:open"),
  menu: () => ipcRenderer.send("meter:menu"),
  hide: () => ipcRenderer.send("meter:hide"),
  dragStart: () => ipcRenderer.send("meter:drag-start"),
  dragMove: () => ipcRenderer.send("meter:drag-move"),
  dragEnd: () => ipcRenderer.send("meter:drag-end"),
  hidden: () => ipcRenderer.invoke("meter:hidden"),
  onHiddenChanged: (callback) => ipcRenderer.on("meter:hidden-changed", (_event, ids) => callback(ids)),
});

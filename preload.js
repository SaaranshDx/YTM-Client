const { contextBridge, ipcRenderer } = require('electron')

function setMaximizeButton(button, isMaximized) {
  button.textContent = isMaximized ? '[]' : '[ ]'
  button.title = isMaximized ? 'Restore' : 'Maximize'
  button.setAttribute('aria-label', isMaximized ? 'Restore window' : 'Maximize window')
}

contextBridge.exposeInMainWorld('ytElectronWindow', {
  minimize: () => ipcRenderer.invoke('window-control:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window-control:toggle-maximize'),
  close: () => ipcRenderer.invoke('window-control:close'),
  isMaximized: () => ipcRenderer.invoke('window-control:is-maximized'),
})

window.addEventListener('DOMContentLoaded', async () => {
  const titlebar = document.createElement('div')
  titlebar.id = 'yt-electron-titlebar'
  titlebar.innerHTML = `
    <div id="yt-electron-title">YouTube Music</div>
    <div id="yt-electron-controls">
      <button id="yt-electron-minimize" type="button" title="Minimize" aria-label="Minimize window">-</button>
      <button id="yt-electron-maximize" type="button" title="Maximize" aria-label="Maximize window">[ ]</button>
      <button id="yt-electron-close" type="button" title="Close" aria-label="Close window">x</button>
    </div>
  `

  const style = document.createElement('style')
  style.textContent = `
    body {
      padding-top: 36px !important;
    }
    #yt-electron-titlebar {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 36px;
      z-index: 2147483647;
      display: flex;
      align-items: stretch;
      justify-content: space-between;
      user-select: none;
      -webkit-app-region: drag;
      background: rgba(10, 10, 10, 0.96);
      color: #ccc;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
      font-family: Segoe UI, Arial, sans-serif;
      font-size: 13px;
      line-height: 1;
    }
    #yt-electron-title {
      display: flex;
      align-items: center;
      padding: 0 12px 0 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex: 1;
      pointer-events: none;
    }
    #yt-electron-controls {
      display: flex;
      align-items: stretch;
      -webkit-app-region: no-drag;
    }
    #yt-electron-controls button {
      width: 46px;
      border: 0;
      background: transparent;
      color: #ddd;
      font: inherit;
      cursor: pointer;
      outline: none;
      -webkit-app-region: no-drag;
    }
    #yt-electron-controls button:hover {
      background: rgba(255, 255, 255, 0.08);
    }
    #yt-electron-close:hover {
      background: #c42b1c;
      color: #fff;
    }
  `

  document.documentElement.appendChild(style)
  document.documentElement.appendChild(titlebar)

  const titleEl = document.getElementById('yt-electron-title')
  const minimizeBtn = document.getElementById('yt-electron-minimize')
  const maximizeBtn = document.getElementById('yt-electron-maximize')
  const closeBtn = document.getElementById('yt-electron-close')

  const syncTitle = () => {
    const cleanTitle = document.title
      .replace(/\s*-\s*YouTube Music\s*$/i, '')
      .replace(/\s*-\s*YouTube\s*$/i, '')
      .trim()
    titleEl.textContent = cleanTitle || 'YouTube Music'
  }

  const syncMaximize = (isMaximized) => setMaximizeButton(maximizeBtn, !!isMaximized)

  minimizeBtn.addEventListener('click', () => {
    ipcRenderer.invoke('window-control:minimize').catch(() => {})
  })

  maximizeBtn.addEventListener('click', async () => {
    try {
      const isMaximized = await ipcRenderer.invoke('window-control:toggle-maximize')
      syncMaximize(isMaximized)
    } catch {}
  })

  closeBtn.addEventListener('click', () => {
    ipcRenderer.invoke('window-control:close').catch(() => {})
  })

  ipcRenderer.on('window-control:maximize-state', (_event, isMaximized) => {
    syncMaximize(isMaximized)
  })

  try {
    syncMaximize(await ipcRenderer.invoke('window-control:is-maximized'))
  } catch {
    syncMaximize(false)
  }

  const observer = new MutationObserver(syncTitle)
  const titleNode = document.querySelector('title')
  if (titleNode) observer.observe(titleNode, { childList: true, subtree: true, characterData: true })
  syncTitle()
})

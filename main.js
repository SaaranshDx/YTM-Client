const { app, BrowserWindow, session, Menu, shell, dialog, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const discordRpc = require('discord-rpc')

app.commandLine.appendSwitch('enable-features', 'ExtensionsServiceWorker')
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const EXTENSIONS_DIR = path.join(__dirname, 'extensions')
const YT_URL = 'https://music.youtube.com'
const DISCORD_APP_ID = '1064295774592180254'
const DISCORD_ACTIVITY = {
  largeImageKey: 'youtube_music',
  largeImageText: 'YouTube Music',
  smallImagePlayingKey: 'play',
  smallImagePausedKey: 'pause',
  openButtonUrl: YT_URL,
}

let discordClient = null
let discordClientReady = false
let discordUpdateTimer = null
let discordLastSignature = ''
let adBlockingInstalled = false

const AD_REQUEST_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  'pagead2.googlesyndication.com',
  'tpc.googlesyndication.com',
  'securepubads.g.doubleclick.net',
  'pubads.g.doubleclick.net',
  'partnerad.l.google.com',
  'adtrafficquality.google',
  'ads.youtube.com'
]

function errorToMessage(err) {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string') return err.message
    try { return JSON.stringify(err) } catch { return String(err) }
  }
  return String(err)
}

function findExtensionDirs(dir) {
  const results = []
  for (const entry of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, entry)
    if (!fs.statSync(fullPath).isDirectory()) continue
    const manifestPath = path.join(fullPath, 'manifest.json')
    if (fs.existsSync(manifestPath)) {
      results.push(fullPath)
    } else {
      results.push(...findExtensionDirs(fullPath))
    }
  }
  return results
}

function shouldBlockAdRequest(rawUrl) {
  let parsedUrl
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    return false
  }

  const host = parsedUrl.hostname.toLowerCase()
  if (AD_REQUEST_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`))) {
    return true
  }

  const target = `${parsedUrl.pathname}${parsedUrl.search}`.toLowerCase()
  if (host.endsWith('googlevideo.com') && target.includes('adformat=')) {
    return true
  }

  return [
    '/api/stats/ads',
    '/pagead/',
    '/adservice',
    '/ads?',
    '/get_midroll_info',
    'ad_break',
    'adformat=',
    'googleadservices',
    'googlesyndication',
    'doubleclick'
  ].some(token => target.includes(token))
}

function installAdBlocking() {
  if (adBlockingInstalled) return
  adBlockingInstalled = true

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (shouldBlockAdRequest(details.url)) {
      callback({ cancel: true })
      return
    }

    callback({})
  })

  console.log('[adblock] Electron-level ad blocking installed')
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch { return {} }
}

function writeConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

async function ensureDiscordClient() {
  if (discordClientReady && discordClient) return discordClient

  if (discordClient) {
    try { discordClient.destroy() } catch {}
    discordClient = null
  }

  const client = new discordRpc.Client({ transport: 'ipc' })
  client.on('ready', () => {
    discordClientReady = true
    console.log('[discord] Connected')
  })
  client.on('disconnected', () => {
    discordClientReady = false
    console.log('[discord] Disconnected')
  })
  client.on('error', (err) => {
    discordClientReady = false
    console.log(`[discord] Error: ${errorToMessage(err)}`)
  })

  await client.login({ clientId: DISCORD_APP_ID })
  discordClient = client
  discordClientReady = true
  return discordClient
}

async function clearDiscordPresence() {
  if (!discordClientReady || !discordClient) return
  try {
    await discordClient.clearActivity()
  } catch (e) {
    console.log(`[discord] Clear failed: ${errorToMessage(e)}`)
  }
  discordLastSignature = ''
}

async function readYouTubeMusicState(win) {
  if (!win || win.isDestroyed()) return null

  try {
    return await win.webContents.executeJavaScript(`(() => {
      const media = navigator.mediaSession && navigator.mediaSession.metadata ? navigator.mediaSession.metadata : null
      const playerResponse = window.ytInitialPlayerResponse || null
      const videoDetails = playerResponse && playerResponse.videoDetails ? playerResponse.videoDetails : null
      const player = document.querySelector('video, audio')
      const text = (value) => (value || '').replace(/\\s+/g, ' ').trim()
      const pick = (...selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector)
          if (node) return node
        }
        return null
      }
      const pickText = (...selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector)
          const value = node && (node.textContent || node.getAttribute('title') || node.getAttribute('aria-label'))
          const clean = text(value)
          if (clean) return clean
        }
        return ''
      }
      const pickImg = (...selectors) => {
        for (const selector of selectors) {
          const node = document.querySelector(selector)
          const value = node && (node.src || node.getAttribute('src') || node.getAttribute('data-src'))
          if (value) return value
        }
        return ''
      }
      const playerThumbnail = videoDetails && videoDetails.thumbnail && Array.isArray(videoDetails.thumbnail.thumbnails) && videoDetails.thumbnail.thumbnails.length
        ? videoDetails.thumbnail.thumbnails[videoDetails.thumbnail.thumbnails.length - 1].url
        : ''
      const videoId = (videoDetails && videoDetails.videoId) || ''
      const title = text((videoDetails && videoDetails.title) || (media && media.title) || pickText(
        'ytmusic-player-bar .title',
        'ytmusic-player-bar .ytmusic-player-bar.title',
        'ytmusic-player-bar .content-info-wrapper yt-formatted-string.title',
        'ytmusic-player-bar .song-info .title',
        'ytmusic-player-page .title',
        'ytmusic-player-page yt-formatted-string.title',
        '[data-testid="title"]',
        'h1'
      ) || document.title.replace(/\\s*-\\s*YouTube Music\\s*$/, ''))
      const artist = text((videoDetails && videoDetails.author) || (media && media.artist) || pickText(
        'ytmusic-player-bar .byline',
        'ytmusic-player-bar yt-formatted-string.byline',
        'ytmusic-player-page .byline',
        'ytmusic-player-page yt-formatted-string.byline',
        '[data-testid="artist"]'
      ))
      const artistNode = pick(
        'ytmusic-player-bar .byline a',
        'ytmusic-player-page .byline a',
        'ytmusic-player-page #channel-name a',
        'ytmusic-player-bar #channel-name a',
        'a[href*="/channel/"]',
        'a[href*="/@"]'
      )
      const artistUrl = artistNode ? artistNode.href || artistNode.getAttribute('href') || '' : ''
      const album = text((media && media.album) || pickText(
        'ytmusic-player-bar .subtitle',
        'ytmusic-player-page .subtitle'
      ))
      const artwork = playerThumbnail || (media && media.artwork && media.artwork.length ? media.artwork[0].src : '') || pickImg(
        'ytmusic-player-bar img#img',
        'ytmusic-player-bar img',
        'ytmusic-player-page img#img',
        'ytmusic-player-page img',
        'img[src*="ytimg"]'
      )
      const paused = (navigator.mediaSession && navigator.mediaSession.playbackState === 'paused') || !!(player && player.paused)
      const currentTime = player && Number.isFinite(player.currentTime) ? player.currentTime : null
      const duration = player && Number.isFinite(player.duration) ? player.duration : null
      const videoUrl = videoId ? 'https://music.youtube.com/watch?v=' + videoId : location.href
      return { title, artist, artistUrl, album, artwork, videoId, paused, currentTime, duration, url: videoUrl, pageUrl: location.href }
    })()`, true)
  } catch {
    return null
  }
}

function buildDiscordActivity(state) {
  if (!state || !state.title) return null

  const title = String(state.title).trim()
  const details = title
  const parts = [state.artist, state.album].filter(Boolean).map(v => String(v).trim()).filter(Boolean)
  const largeImageKey = state.artwork || (state.videoId ? `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg` : DISCORD_ACTIVITY.largeImageKey)
  const activity = {
    details,
    state: parts.length > 0 ? parts.join(' • ') : 'YouTube Music',
    type: 2,
    largeImageKey,
    largeImageText: state.title ? `${title}${state.artist ? ` by ${state.artist}` : ''}` : DISCORD_ACTIVITY.largeImageText,
    buttons: [
      { label: 'Listen Along', url: state.url || DISCORD_ACTIVITY.openButtonUrl },
      ...(state.artistUrl ? [{ label: 'View Artist', url: state.artistUrl }] : []),
    ],
    instance: false,
  }

  if (state.paused) {
    activity.smallImageKey = DISCORD_ACTIVITY.smallImagePausedKey
    activity.smallImageText = 'Paused'
  } else {
    activity.smallImageKey = DISCORD_ACTIVITY.smallImagePlayingKey
    activity.smallImageText = 'Listening'
  }

  if (!state.paused && Number.isFinite(state.currentTime) && Number.isFinite(state.duration) && state.duration > 0) {
    const now = Date.now()
    const elapsed = Math.max(0, Math.min(state.currentTime, state.duration))
    const remaining = Math.max(0, state.duration - elapsed)
    activity.startTimestamp = new Date(now - (elapsed * 1000))
    activity.endTimestamp = new Date(now + (remaining * 1000))
  }

  return activity
}

async function updateDiscordPresence(win) {
  const state = await readYouTubeMusicState(win)
  if (!state || !state.title || state.paused) {
    await clearDiscordPresence()
    return
  }

  const activity = buildDiscordActivity(state)
  if (!activity) {
    await clearDiscordPresence()
    return
  }

  const signature = JSON.stringify(activity)
  if (signature === discordLastSignature) return

  const client = await ensureDiscordClient()
  await client.setActivity(activity)
  discordLastSignature = signature
}

function startDiscordPresence(win) {
  let stopped = false

  const tick = async () => {
    if (stopped || !win || win.isDestroyed()) return
    try {
      await updateDiscordPresence(win)
    } catch (e) {
      discordClientReady = false
      console.log(`[discord] Update failed: ${errorToMessage(e)}`)
    }
  }

  const stop = async () => {
    stopped = true
    if (discordUpdateTimer) {
      clearInterval(discordUpdateTimer)
      discordUpdateTimer = null
    }
    await clearDiscordPresence()
    if (discordClient) {
      try { await discordClient.destroy() } catch {}
      discordClient = null
    }
    discordClientReady = false
    discordLastSignature = ''
  }

  win.webContents.on('did-finish-load', tick)
  win.webContents.on('did-navigate-in-page', tick)
  win.webContents.on('did-navigate', tick)

  discordUpdateTimer = setInterval(tick, 15000)
  win.on('closed', () => {
    stop().catch(() => {})
  })

  tick()
}

function promptForText(parent, { title, message, value = '', placeholder = '' }) {
  return new Promise((resolve) => {
    const responseChannel = `oauth-prompt-response-${crypto.randomUUID()}`
    const promptWin = new BrowserWindow({
      width: 520,
      height: 260,
      title,
      parent: parent || undefined,
      modal: !!parent,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      }
    })

    const cleanup = () => {
      ipcMain.removeAllListeners(responseChannel)
      if (!promptWin.isDestroyed()) promptWin.destroy()
    }

    ipcMain.once(responseChannel, (_event, result) => {
      cleanup()
      resolve(typeof result === 'string' ? result : null)
    })

    promptWin.on('closed', () => {
      ipcMain.removeAllListeners(responseChannel)
      resolve(null)
    })

    promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${title}</title>
          <style>
            body {
              margin: 0;
              background: #111;
              color: #fff;
              font-family: Segoe UI, Arial, sans-serif;
            }
            .wrap {
              padding: 20px;
            }
            h1 {
              margin: 0 0 12px;
              font-size: 18px;
              font-weight: 600;
            }
            p {
              margin: 0 0 16px;
              color: #cfcfcf;
              line-height: 1.4;
            }
            input {
              width: 100%;
              box-sizing: border-box;
              border: 1px solid #444;
              border-radius: 6px;
              background: #1b1b1b;
              color: #fff;
              padding: 10px 12px;
              font-size: 14px;
              outline: none;
            }
            .buttons {
              margin-top: 16px;
              display: flex;
              justify-content: flex-end;
              gap: 10px;
            }
            button {
              border: 0;
              border-radius: 6px;
              padding: 8px 14px;
              font-size: 14px;
              cursor: pointer;
            }
            .cancel {
              background: #2b2b2b;
              color: #fff;
            }
            .ok {
              background: #4c8bf5;
              color: #fff;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <h1>${title}</h1>
            <p>${message}</p>
            <input id="value" value="${String(value).replace(/"/g, '&quot;')}" placeholder="${placeholder}" />
            <div class="buttons">
              <button class="cancel" id="cancel">Cancel</button>
              <button class="ok" id="ok">Save</button>
            </div>
          </div>
          <script>
            const { ipcRenderer } = require('electron')
            const channel = ${JSON.stringify(responseChannel)}
            const input = document.getElementById('value')
            const send = (result) => ipcRenderer.send(channel, result)
            document.getElementById('ok').addEventListener('click', () => send(input.value))
            document.getElementById('cancel').addEventListener('click', () => send(null))
            window.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') send(input.value)
              if (event.key === 'Escape') send(null)
            })
            input.focus()
            input.select()
          </script>
        </body>
      </html>
    `)}`)
  })
}

function openOAuthWindow(parent, url) {
  const authWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Google Sign-In',
    parent: parent || undefined,
    modal: !!parent,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  authWin.loadURL(url)
  return authWin
}

function findHelium() {
  const p = `${process.env.LOCALAPPDATA}\\imput\\Helium\\Application\\chrome.exe`
  return fs.existsSync(p) ? p : null
}

function startOAuthServer(port) {
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`)
    if (parsed.pathname === '/oauth/callback') {
      const code = parsed.searchParams.get('code')
      const error = parsed.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="background:#111;color:#0f0;font:16px sans-serif;padding:40px;text-align:center">
        <h2>${error ? 'Error: ' + error : 'Signed in!'}</h2>
        <p>You can close this tab and go back to the app.</p>
      </body></html>`)
      server._callback(error ? { error } : { code })
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OAuth server running')
    }
  })
  server._callback = null
  server.waitForCallback = function() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sign-in timeout')), 300000)
      server._callback = (result) => {
        clearTimeout(timeout)
        if (result.error) reject(new Error(errorToMessage(result.error)))
        else resolve(result.code)
      }
    })
  }
  return server
}

async function oauthFlow(win) {
  let config = readConfig()

  if (!config.oauthClientId) {
    dialog.showErrorBox('OAuth Setup',
      'You need a Google OAuth Client ID.\n\n' +
      '1. Go to https://console.cloud.google.com/apis/credentials\n' +
      '2. Create a "Desktop" OAuth 2.0 Client ID\n' +
      '3. Add "http://127.0.0.1/oauth/callback" as an Authorized Redirect URI\n' +
      '4. Edit config.json in %APPDATA%\\ytmusic-client and add "oauthClientId": "your-id"\n' +
      '5. If Google shows a client secret for that client, add "oauthClientSecret" too')
    return
  }

  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

  const server = startOAuthServer(0)
  let oauthPort = null
  let authWin = null
  server.listen(0, '127.0.0.1', async () => {
    oauthPort = server.address().port

    const params = new URLSearchParams({
      client_id: config.oauthClientId,
      redirect_uri: `http://127.0.0.1:${oauthPort}/oauth/callback`,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
    console.log(`[oauth] Opening browser to ${authUrl}`)
    authWin = openOAuthWindow(win, authUrl)
  })

  try {
    const code = await server.waitForCallback()

    console.log('[oauth] Exchanging code for tokens...')

    const tokens = await new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        code,
        client_id: config.oauthClientId,
        ...(config.oauthClientSecret ? { client_secret: config.oauthClientSecret } : {}),
        redirect_uri: `http://127.0.0.1:${oauthPort}/oauth/callback`,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString()
      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, res => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch { reject(new Error(data)) }
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })

    if (tokens.error) {
      const tokenError = errorToMessage(tokens.error_description || tokens.error)
      throw new Error(tokenError)
    }

    config = readConfig()
    config.oauthTokens = tokens
    writeConfig(config)

    console.log('[oauth] Tokens obtained successfully')
    if (authWin && !authWin.isDestroyed()) authWin.close()
    if (win) win.loadURL(YT_URL)

  } catch (e) {
    throw new Error(errorToMessage(e))
  } finally {
    if (authWin && !authWin.isDestroyed()) authWin.close()
    server.close()
  }
}

async function loadExtensions() {
  if (!fs.existsSync(EXTENSIONS_DIR)) {
    console.log('[ext] No extensions folder found, skipping.')
    return
  }

  for (const extPath of findExtensionDirs(EXTENSIONS_DIR)) {
    const name = path.basename(extPath)
    try {
      await session.defaultSession.loadExtension(extPath, {
        allowFileAccess: true
      })
      console.log(`[ext] Loaded: ${name}`)
    } catch (e) {
      console.log(`[ext] Failed to load ${name}: ${e.message}`)
    }
  }
}

function openExtensionPage(url, title, width = 420, height = 540) {
  const win = new BrowserWindow({
    width,
    height,
    title: title || 'Extension',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  win.loadURL(url)
  return win
}

function buildExtensionsMenu() {
  const extensions = session.defaultSession.getAllExtensions()
  const items = []

  for (const ext of extensions) {
    const manifest = ext.manifest
    const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup
    const optionsPath = manifest.options_ui?.page || manifest.options_page
    const submenu = []

    if (popupPath) {
      const url = `chrome-extension://${ext.id}/${popupPath.replace(/^\//, '')}`
      submenu.push({
        label: 'Open Popup',
        click: () => openExtensionPage(url, ext.name, 400, 540)
      })
    }

    if (optionsPath) {
      const url = `chrome-extension://${ext.id}/${optionsPath.replace(/^\//, '')}`
      submenu.push({
        label: 'Options',
        click: () => openExtensionPage(url, `${ext.name} Options`, 600, 500)
      })
    }

    if (manifest.homepage_url) {
      submenu.push({
        label: 'Visit Homepage',
        click: () => shell.openExternal(manifest.homepage_url)
      })
    }

    if (submenu.length === 0) {
      submenu.push({ label: 'No actions available', enabled: false })
    }

    items.push({ label: ext.name, submenu })
  }

  if (items.length === 0) {
    items.push({ label: 'No extensions loaded', enabled: false })
  }

  return items
}

function resizeWindow(width, height) {
  const win = BrowserWindow.getFocusedWindow()
  if (win) { win.setSize(width, height); win.center() }
}

function getActiveWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
}

function registerWindowControls() {
  ipcMain.removeHandler('window-control:minimize')
  ipcMain.handle('window-control:minimize', () => {
    const win = getActiveWindow()
    if (win) win.minimize()
    return null
  })

  ipcMain.removeHandler('window-control:toggle-maximize')
  ipcMain.handle('window-control:toggle-maximize', () => {
    const win = getActiveWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })

  ipcMain.removeHandler('window-control:close')
  ipcMain.handle('window-control:close', () => {
    const win = getActiveWindow()
    if (win) win.close()
    return null
  })

  ipcMain.removeHandler('window-control:is-maximized')
  ipcMain.handle('window-control:is-maximized', () => {
    const win = getActiveWindow()
    return !!win && win.isMaximized()
  })
}

function setupMenu() {
  const menuTemplate = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Sign in with Google...',
          click: () => {
            const win = BrowserWindow.getAllWindows()[0]
            oauthFlow(win).catch(e => {
              dialog.showErrorBox('Sign In Failed', errorToMessage(e))
            })
          }
        },
        {
          label: 'Set OAuth Client ID...',
          click: () => {
            const config = readConfig()
            const win = BrowserWindow.getAllWindows()[0]
            promptForText(win, {
              title: 'OAuth Client ID',
              message: 'Paste your Google OAuth Client ID.',
              placeholder: '1234567890-abc.apps.googleusercontent.com',
              value: config.oauthClientId || ''
            }).then(async (id) => {
              if (!id || !id.trim()) return
              config.oauthClientId = id.trim()
              writeConfig(config)
              await dialog.showMessageBox(win, { type: 'info', message: 'OAuth client ID saved.' })
            }).catch((e) => {
              dialog.showErrorBox('OAuth Setup Failed', errorToMessage(e))
            })
          }
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Extensions',
      submenu: buildExtensionsMenu()
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: 'Compact Window (Ctrl+1)',
          accelerator: 'CmdOrCtrl+1',
          click: () => resizeWindow(800, 600)
        },
        {
          label: 'Default Window (Ctrl+2)',
          accelerator: 'CmdOrCtrl+2',
          click: () => resizeWindow(1280, 800)
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(menuTemplate)
  Menu.setApplicationMenu(menu)
}

async function createWindow() {
  installAdBlocking()
  await loadExtensions()
  registerWindowControls()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'YouTube Music',
    backgroundColor: '#030303',
    icon: path.join(__dirname, 'assets', 'ytmusic.png'),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  })

  setupMenu()
  // DO NOT CHANGE THIS UNLESS YOU wANT CLOUDFLARE TO YELL AT US
  //win.webContents.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

  startDiscordPresence(win)
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window-control:maximize-state', true)
  })
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window-control:maximize-state', false)
  })
  win.on('restore', () => {
    if (!win.isDestroyed()) win.webContents.send('window-control:maximize-state', false)
  })
  win.loadURL(YT_URL)

  win.on('page-title-updated', (e) => e.preventDefault())
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

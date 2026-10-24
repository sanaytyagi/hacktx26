import { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer, session, systemPreferences, safeStorage, protocol, net } from 'electron'
import { join } from 'node:path'
import { rmSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRelay, type Relay } from './bootstrap'
import { dispatch, type Services, type PlatformHooks } from './ipc/router'
import type { SecretBox } from './core/context'
import { actorFor, canSeeOwner } from './core/authz'
import { getSetting } from './core/settings'

const isDev = !app.isPackaged
const appRoot = app.getAppPath()
const resourcesDir = isDev ? join(appRoot, 'resources') : join(process.resourcesPath, 'resources')
const pythonDir = isDev ? join(appRoot, 'python') : join(process.resourcesPath, 'python')
const dataRoot = process.env.RELAY_DATA_DIR ?? join(app.getPath('userData'), 'workspace')

protocol.registerSchemesAsPrivileged([{ scheme: 'relay-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

if (!app.requestSingleInstanceLock()) app.quit()

let mainWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let relay: Relay | null = null
let pendingSource: string | null = null

function secretBox(): SecretBox {
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : 'os'
  if (safeStorage.isEncryptionAvailable() && backend !== 'basic_text') {
    return { kind: 'os_keychain', encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) }
  }
  // No OS keychain (e.g. Linux without a secret service): stored unencrypted, and Settings says so.
  return { kind: 'plaintext_fallback', encrypt: (s) => Buffer.from(s, 'utf8'), decrypt: (b) => b.toString('utf8') }
}

function loadRenderer(win: BrowserWindow, hash = '') {
  if (isDev && process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash ? `#${hash}` : ''}`)
  else win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

function hardenWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = (isDev && process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) || url.startsWith('file://')
    if (!allowed) e.preventDefault()
  })
}

function webPreferences() {
  return { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webSecurity: true }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: 'Relay',
    show: false,
    backgroundColor: '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: webPreferences()
  })
  hardenWindow(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  loadRenderer(mainWindow)
  mainWindow.on('closed', () => {
    mainWindow = null
    hudWindow?.close()
  })
}

function showHud(show: boolean) {
  if (!show) {
    hudWindow?.close()
    hudWindow = null
    return
  }
  if (hudWindow) return
  hudWindow = new BrowserWindow({
    width: 300,
    height: 64,
    resizable: false,
    alwaysOnTop: true,
    frame: false,
    skipTaskbar: true,
    focusable: true,
    title: 'Relay recording',
    backgroundColor: '#18181b',
    webPreferences: webPreferences()
  })
  hudWindow.setAlwaysOnTop(true, 'floating')
  hardenWindow(hudWindow)
  loadRenderer(hudWindow, '/recording-hud')
  hudWindow.on('closed', () => (hudWindow = null))
}

const platform: PlatformHooks = {
  async openFile(opts) {
    const r = await dialog.showOpenDialog(mainWindow!, { title: opts.title, filters: opts.filters, properties: [opts.directory ? 'openDirectory' : 'openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  revealPath: (p) => shell.showItemInFolder(p),
  async captureSources() {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
    return sources
      .filter((s) => !s.name.startsWith('Relay recording'))
      .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? ('screen' as const) : ('window' as const), thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }))
  },
  selectCaptureSource: (id) => {
    pendingSource = id
  },
  screenPermission: () => ({ status: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted', platform: process.platform }),
  openScreenSettings: () => {
    if (process.platform === 'darwin') void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  },
  showRecordingHud: showHud,
  hudCommand: (command) => mainWindow?.webContents.send('relay:event', { type: 'recorder.command', command }),
  relaunchAfterReset: () => {
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--reset-workspace'), '--reset-workspace'] })
    app.exit(0)
  },
  appInfo: () => ({ version: app.getVersion(), dataDir: dataRoot, platform: `${process.platform} ${process.arch}`, electron: process.versions.electron })
}

app.whenReady().then(async () => {
  if (process.argv.includes('--reset-workspace') || process.env.RELAY_RESET === '1') rmSync(dataRoot, { recursive: true, force: true })
  relay = await createRelay({
    dataDir: dataRoot,
    resourcesDir,
    pythonDir,
    appRoot,
    secrets: secretBox(),
    emit: (e) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('relay:event', e)
    }
  })
  const services: Services = { ctx: relay.ctx, engine: relay.engine, api: relay.api, python: relay.python, platform }

  ipcMain.handle('relay:invoke', async (event, method: unknown, input: unknown) => {
    // Only our own windows may call the API.
    const origin = event.senderFrame?.url ?? ''
    if (!(origin.startsWith('file://') || (isDev && process.env.ELECTRON_RENDERER_URL && origin.startsWith(process.env.ELECTRON_RENDERER_URL)))) return { ok: false, error: { code: 'forbidden', message: 'Untrusted sender' } }
    if (typeof method !== 'string') return { ok: false, error: { code: 'invalid', message: 'Bad request' } }
    return dispatch(services, method, input)
  })

  // Screen capture only proceeds with a source the user explicitly picked in Relay's picker.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    if (!pendingSource) return callback({})
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
    const chosen = sources.find((s) => s.id === pendingSource)
    pendingSource = null
    if (!chosen) return callback({})
    callback({ video: chosen })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture' || permission === 'notifications'))

  // Recording playback: only recordings the current persona may see.
  protocol.handle('relay-media', async (req) => {
    const url = new URL(req.url)
    const id = url.pathname.replace(/^\//, '')
    const rec = relay!.ctx.db.get<{ file_path: string; owner_id: string }>('SELECT file_path, owner_id FROM recordings WHERE id = ?', id)
    const actor = actorFor(relay!.ctx, getSetting(relay!.ctx, 'persona', 'u_alex'))
    if (url.hostname !== 'recording' || !rec || !canSeeOwner(relay!.ctx, actor, rec.owner_id) || !existsSync(rec.file_path)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(rec.file_path).toString(), { headers: req.headers })
  })

  createWindow()
  await relay.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

let stopping = false
app.on('before-quit', (e) => {
  if (!relay || stopping) return
  e.preventDefault()
  stopping = true
  relay
    .stop()
    .catch(() => undefined)
    .finally(() => app.exit(0))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

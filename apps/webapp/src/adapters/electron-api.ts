/**
 * Web adapter for window.electronAPI
 * Routes all ElectronAPI calls to backend /api/rpc endpoint
 * and listens to /api/events SSE for streaming events
 */

import type { ElectronAPI, SessionEvent } from '../../electron/src/shared/types'

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : ''

// SSE connection for streaming events
let eventSource: EventSource | null = null
const eventListeners: Map<string, Set<(event: SessionEvent) => void>> = new Map()

// Generic event listeners (menu events, theme changes, etc.)
const genericListeners: Map<string, Set<(...args: unknown[]) => void>> = new Map()

/**
 * Make an RPC call to the backend
 */
async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`${API_BASE}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  
  const data = await response.json() as { result?: T; error?: string }
  
  if (data.error) {
    throw new Error(data.error)
  }
  
  return data.result as T
}

/**
 * Connect to SSE endpoint for streaming events
 */
function connectSSE(): void {
  if (eventSource) return
  
  eventSource = new EventSource(`${API_BASE}/api/events`)
  
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as SessionEvent
      
      // Notify all session event listeners
      const listeners = eventListeners.get('session') || new Set()
      for (const listener of listeners) {
        listener(data)
      }
    } catch (err) {
      console.error('Error parsing SSE event:', err)
    }
  }
  
  eventSource.onerror = () => {
    console.warn('SSE connection error, reconnecting...')
    eventSource?.close()
    eventSource = null
    // Reconnect after 1 second
    setTimeout(connectSSE, 1000)
  }
}

/**
 * Add a listener for a specific event type
 */
function addListener(type: string, callback: (...args: unknown[]) => void): () => void {
  if (!genericListeners.has(type)) {
    genericListeners.set(type, new Set())
  }
  genericListeners.get(type)!.add(callback)
  
  return () => {
    genericListeners.get(type)?.delete(callback)
  }
}

// Initialize SSE connection
connectSSE()

/**
 * Web implementation of ElectronAPI
 */
export const webElectronAPI: ElectronAPI = {
  // Session management
  getSessions: () => rpc('getSessions'),
  getSessionMessages: (sessionId) => rpc('getSessionMessages', sessionId),
  createSession: (workspaceId, options) => rpc('createSession', workspaceId, options),
  deleteSession: (sessionId) => rpc('deleteSession', sessionId),
  sendMessage: (sessionId, message, attachments, storedAttachments, options) => 
    rpc('sendMessage', sessionId, message, attachments, storedAttachments, options),
  cancelProcessing: (sessionId, silent) => rpc('cancelProcessing', sessionId, silent),
  killShell: (sessionId, shellId) => rpc('killShell', sessionId, shellId),
  getTaskOutput: (taskId) => rpc('getTaskOutput', taskId),
  respondToPermission: (sessionId, requestId, allowed, alwaysAllow) => 
    rpc('respondToPermission', sessionId, requestId, allowed, alwaysAllow),
  respondToCredential: (sessionId, requestId, response) => 
    rpc('respondToCredential', sessionId, requestId, response),
  
  // Session commands
  sessionCommand: (sessionId, command) => rpc('sessionCommand', sessionId, command),
  getPendingPlanExecution: (sessionId) => rpc('getPendingPlanExecution', sessionId),
  
  // Workspace management
  getWorkspaces: () => rpc('getWorkspaces'),
  createWorkspace: (folderPath, name) => rpc('createWorkspace', folderPath, name),
  checkWorkspaceSlug: (slug) => rpc('checkWorkspaceSlug', slug),
  
  // Window management (stubs for web)
  getWindowWorkspace: () => rpc('getWindowWorkspace'),
  getWindowMode: () => rpc('getWindowMode'),
  openWorkspace: (workspaceId) => rpc('openWorkspace', workspaceId),
  openSessionInNewWindow: (workspaceId, sessionId) => rpc('openSessionInNewWindow', workspaceId, sessionId),
  switchWorkspace: (workspaceId) => rpc('switchWorkspace', workspaceId),
  closeWindow: () => rpc('closeWindow'),
  confirmCloseWindow: () => rpc('confirmCloseWindow'),
  onCloseRequested: (callback) => addListener('closeRequested', callback),
  setTrafficLightsVisible: (visible) => rpc('setTrafficLightsVisible', visible),
  
  // Event listeners
  onSessionEvent: (callback) => {
    if (!eventListeners.has('session')) {
      eventListeners.set('session', new Set())
    }
    eventListeners.get('session')!.add(callback)
    
    return () => {
      eventListeners.get('session')?.delete(callback)
    }
  },
  
  // File operations
  readFile: (path) => rpc('readFile', path),
  openFileDialog: () => rpc('openFileDialog'),
  readFileAttachment: (path) => rpc('readFileAttachment', path),
  storeAttachment: (sessionId, attachment) => rpc('storeAttachment', sessionId, attachment),
  generateThumbnail: (base64, mimeType) => rpc('generateThumbnail', base64, mimeType),
  searchFiles: (basePath, query) => rpc('searchFiles', basePath, query),
  debugLog: (...args) => rpc('debugLog', ...args),
  
  // Theme
  getSystemTheme: () => {
    // Detect system theme client-side
    return Promise.resolve(window.matchMedia('(prefers-color-scheme: dark)').matches)
  },
  onSystemThemeChange: (callback) => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => callback(e.matches)
    mediaQuery.addEventListener('change', handler)
    return () => mediaQuery.removeEventListener('change', handler)
  },
  
  // System
  getVersions: () => ({ node: 'N/A', chrome: navigator.userAgent, electron: 'N/A (webapp)' }),
  getHomeDir: () => rpc('getHomeDir'),
  isDebugMode: () => rpc('isDebugMode'),
  
  // Auto-update (not applicable for web)
  checkForUpdates: () => Promise.resolve({ available: false } as any),
  getUpdateInfo: () => Promise.resolve({ available: false } as any),
  installUpdate: () => Promise.resolve(),
  dismissUpdate: () => Promise.resolve(),
  getDismissedUpdateVersion: () => Promise.resolve(null),
  onUpdateAvailable: () => () => {},
  onUpdateDownloadProgress: () => () => {},
  
  // Shell operations
  openUrl: (url) => {
    window.open(url, '_blank')
    return Promise.resolve()
  },
  openFile: (path) => rpc('openFile', path),
  showInFolder: (path) => rpc('showInFolder', path),
  
  // Menu event listeners
  onMenuNewChat: (callback) => addListener('menuNewChat', callback),
  onMenuOpenSettings: (callback) => addListener('menuOpenSettings', callback),
  onMenuKeyboardShortcuts: (callback) => addListener('menuKeyboardShortcuts', callback),
  
  // Deep link
  onDeepLinkNavigate: (callback) => addListener('deepLinkNavigate', callback),
  
  // Auth
  showLogoutConfirmation: () => Promise.resolve(window.confirm('Are you sure you want to logout?')),
  showDeleteSessionConfirmation: (name) => Promise.resolve(window.confirm(`Delete session "${name}"?`)),
  logout: () => rpc('logout'),
  
  // Onboarding
  getAuthState: () => rpc('getAuthState'),
  getSetupNeeds: () => rpc('getSetupNeeds'),
  startWorkspaceMcpOAuth: () => Promise.reject(new Error('OAuth not supported in webapp')),
  saveOnboardingConfig: (config) => rpc('saveOnboardingConfig', config),
  startClaudeOAuth: () => Promise.reject(new Error('OAuth not supported in webapp')),
  exchangeClaudeCode: () => Promise.reject(new Error('OAuth not supported in webapp')),
  hasClaudeOAuthState: () => Promise.resolve(false),
  clearClaudeOAuthState: () => Promise.resolve({ success: true }),
  
  // Settings - API Setup
  getApiSetup: () => rpc('getApiSetup'),
  updateApiSetup: (authType, credential, anthropicBaseUrl, customModel) => 
    rpc('updateApiSetup', authType, credential, anthropicBaseUrl, customModel),
  testApiConnection: (apiKey, baseUrl, modelName) => 
    rpc('testApiConnection', apiKey, baseUrl, modelName),
  
  // Settings - Model
  getModel: () => rpc('getModel'),
  setModel: (model) => rpc('setModel', model),
  getSessionModel: (sessionId, workspaceId) => rpc('getSessionModel', sessionId, workspaceId),
  setSessionModel: (sessionId, workspaceId, model) => rpc('setSessionModel', sessionId, workspaceId, model),
  
  // Workspace Settings
  getWorkspaceSettings: (workspaceId) => rpc('getWorkspaceSettings', workspaceId),
  updateWorkspaceSetting: (workspaceId, key, value) => rpc('updateWorkspaceSetting', workspaceId, key, value),
  
  // Folder dialog
  openFolderDialog: () => rpc('openFolderDialog'),
  
  // User Preferences
  readPreferences: () => rpc('readPreferences'),
  writePreferences: (content) => rpc('writePreferences', content),
  
  // Session Drafts
  getDraft: (sessionId) => rpc('getDraft', sessionId),
  setDraft: (sessionId, text) => rpc('setDraft', sessionId, text),
  deleteDraft: (sessionId) => rpc('deleteDraft', sessionId),
  getAllDrafts: () => rpc('getAllDrafts'),
  
  // Session Info Panel
  getSessionFiles: (sessionId) => rpc('getSessionFiles', sessionId),
  getSessionNotes: (sessionId) => rpc('getSessionNotes', sessionId),
  setSessionNotes: (sessionId, content) => rpc('setSessionNotes', sessionId, content),
  watchSessionFiles: () => Promise.resolve(),
  unwatchSessionFiles: () => Promise.resolve(),
  onSessionFilesChanged: () => () => {},
  
  // Sources
  getSources: (workspaceId) => rpc('getSources', workspaceId),
  createSource: (workspaceId, config) => rpc('createSource', workspaceId, config),
  deleteSource: (workspaceId, sourceSlug) => rpc('deleteSource', workspaceId, sourceSlug),
  startSourceOAuth: () => Promise.reject(new Error('OAuth not supported in webapp')),
  saveSourceCredentials: (workspaceId, sourceSlug, credential) => 
    rpc('saveSourceCredentials', workspaceId, sourceSlug, credential),
  getSourcePermissionsConfig: (workspaceId, sourceSlug) => 
    rpc('getSourcePermissionsConfig', workspaceId, sourceSlug),
  getWorkspacePermissionsConfig: (workspaceId) => rpc('getWorkspacePermissionsConfig', workspaceId),
  getDefaultPermissionsConfig: () => rpc('getDefaultPermissionsConfig'),
  getMcpTools: (workspaceId, sourceSlug) => rpc('getMcpTools', workspaceId, sourceSlug),
  onSourcesChanged: (callback) => addListener('sourcesChanged', callback),
  onDefaultPermissionsChanged: (callback) => addListener('defaultPermissionsChanged', callback),
  
  // Skills
  getSkills: (workspaceId) => rpc('getSkills', workspaceId),
  getSkillFiles: (workspaceId, skillSlug) => rpc('getSkillFiles', workspaceId, skillSlug),
  deleteSkill: (workspaceId, skillSlug) => rpc('deleteSkill', workspaceId, skillSlug),
  openSkillInEditor: (workspaceId, skillSlug) => rpc('openSkillInEditor', workspaceId, skillSlug),
  openSkillInFinder: (workspaceId, skillSlug) => rpc('openSkillInFinder', workspaceId, skillSlug),
  onSkillsChanged: (callback) => addListener('skillsChanged', callback),
  
  // Statuses
  listStatuses: (workspaceId) => rpc('listStatuses', workspaceId),
  reorderStatuses: (workspaceId, orderedIds) => rpc('reorderStatuses', workspaceId, orderedIds),
  onStatusesChanged: (callback) => addListener('statusesChanged', callback),
  
  // Labels
  listLabels: (workspaceId) => rpc('listLabels', workspaceId),
  createLabel: (workspaceId, input) => rpc('createLabel', workspaceId, input),
  deleteLabel: (workspaceId, labelId) => rpc('deleteLabel', workspaceId, labelId),
  onLabelsChanged: (callback) => addListener('labelsChanged', callback),
  
  // Views
  listViews: (workspaceId) => rpc('listViews', workspaceId),
  saveViews: (workspaceId, views) => rpc('saveViews', workspaceId, views),
  
  // Workspace images
  readWorkspaceImage: (workspaceId, relativePath) => rpc('readWorkspaceImage', workspaceId, relativePath),
  writeWorkspaceImage: (workspaceId, relativePath, base64, mimeType) => 
    rpc('writeWorkspaceImage', workspaceId, relativePath, base64, mimeType),
  
  // Theme
  getAppTheme: () => rpc('getAppTheme'),
  loadPresetThemes: () => rpc('loadPresetThemes'),
  loadPresetTheme: (themeId) => rpc('loadPresetTheme', themeId),
  getColorTheme: () => rpc('getColorTheme'),
  setColorTheme: (themeId) => rpc('setColorTheme', themeId),
  onAppThemeChange: (callback) => addListener('appThemeChange', callback),
  
  // Logo URL
  getLogoUrl: (serviceUrl, provider) => rpc('getLogoUrl', serviceUrl, provider),
  
  // Notifications
  showNotification: (title, body, workspaceId, sessionId) => 
    rpc('showNotification', title, body, workspaceId, sessionId),
  getNotificationsEnabled: () => rpc('getNotificationsEnabled'),
  setNotificationsEnabled: (enabled) => rpc('setNotificationsEnabled', enabled),
  updateBadgeCount: () => Promise.resolve(),
  clearBadgeCount: () => Promise.resolve(),
  setDockIconWithBadge: () => Promise.resolve(),
  onBadgeDraw: () => () => {},
  getWindowFocusState: () => Promise.resolve(document.hasFocus()),
  onWindowFocusChange: (callback) => {
    const handler = () => callback(document.hasFocus())
    window.addEventListener('focus', handler)
    window.addEventListener('blur', handler)
    return () => {
      window.removeEventListener('focus', handler)
      window.removeEventListener('blur', handler)
    }
  },
  onNotificationNavigate: (callback) => addListener('notificationNavigate', callback),
  
  // Theme preferences sync
  broadcastThemePreferences: () => Promise.resolve(),
  onThemePreferencesChange: (callback) => addListener('themePreferencesChange', callback),
  
  // Git
  getGitBranch: (dirPath) => rpc('getGitBranch', dirPath),
  checkGitBash: () => rpc('checkGitBash'),
  browseForGitBash: () => rpc('browseForGitBash'),
  setGitBashPath: (path) => rpc('setGitBashPath', path),
}

// Install the web adapter as window.electronAPI
;(window as any).electronAPI = webElectronAPI

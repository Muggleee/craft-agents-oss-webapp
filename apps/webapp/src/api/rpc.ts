/**
 * RPC handler - routes method calls to appropriate handlers
 * Mirrors Electron's ipcMain.handle pattern
 */

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import type { SessionEvent, Session, Workspace, SetupNeeds, AuthState, ApiSetupInfo } from '../../../electron/src/shared/types'
import { 
  getAuthType, 
  loadStoredConfig, 
  getModel, 
  setModel,
  getAnthropicBaseUrl,
  getCustomModel,
  getSessionDraft,
  setSessionDraft,
  deleteSessionDraft,
  getAllSessionDrafts,
} from '@craft-agent/shared/config'
import { getAuthState, getSetupNeeds } from '@craft-agent/shared/auth'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { SessionManager } from './session-manager'

// Type for broadcast function
type BroadcastFn = (event: SessionEvent) => void

// Default workspace directory
const DEFAULT_WORKSPACES_DIR = join(homedir(), '.craft-agent', 'workspaces')

// Ensure default directories exist
if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
  mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true })
}

// Initialize session manager (singleton)
let sessionManager: SessionManager | null = null

function getSessionManager(broadcast: BroadcastFn): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(broadcast)
  }
  return sessionManager
}

/**
 * RPC method dispatcher
 */
export async function rpcHandler(
  method: string, 
  args: unknown[],
  broadcast: BroadcastFn
): Promise<unknown> {
  const sm = getSessionManager(broadcast)
  
  switch (method) {
    // ============================================================
    // Phase 0: Basic UI Loading APIs
    // ============================================================
    
    case 'getSetupNeeds': {
      const authState = await getAuthState()
      return getSetupNeeds(authState)
    }
    
    case 'getAuthState':
      return getAuthState()
    
    case 'getWorkspaces':
      return sm.getWorkspaces()
    
    case 'getSessions':
      return sm.getSessions()
    
    case 'getModel':
      return getModel()
    
    case 'setModel': {
      const [model] = args as [string]
      setModel(model)
      return
    }
    
    case 'getApiSetup': {
      const authType = getAuthType()
      const credManager = getCredentialManager()
      const hasCredential = await credManager.hasCredential(authType)
      const baseUrl = getAnthropicBaseUrl()
      const customModel = getCustomModel()
      return {
        authType,
        hasCredential,
        anthropicBaseUrl: baseUrl,
        customModel,
      } satisfies ApiSetupInfo
    }
    
    case 'getAllDrafts':
      return getAllSessionDrafts()
    
    case 'getDraft': {
      const [sessionId] = args as [string]
      return getSessionDraft(sessionId)
    }
    
    case 'setDraft': {
      const [sessionId, text] = args as [string, string]
      setSessionDraft(sessionId, text)
      return
    }
    
    case 'deleteDraft': {
      const [sessionId] = args as [string]
      deleteSessionDraft(sessionId)
      return
    }
    
    case 'getAppTheme':
      // For webapp, return null (use default theme)
      return null
    
    case 'getNotificationsEnabled':
      // Web notifications are handled differently
      return false
    
    case 'getSystemTheme':
      // Cannot detect system theme server-side, let client handle it
      return false
    
    case 'getHomeDir':
      return homedir()
    
    case 'isDebugMode':
      return process.env.DEBUG === 'true'
    
    case 'getVersions':
      return { node: process.version, chrome: 'N/A', electron: 'N/A' }
    
    // ============================================================
    // Window Management (stubs for webapp - single "window")
    // ============================================================
    
    case 'getWindowWorkspace':
      // Return first workspace or null
      const workspaces = sm.getWorkspaces()
      return workspaces.length > 0 ? workspaces[0].id : null
    
    case 'getWindowMode':
      return 'main'
    
    case 'openWorkspace':
    case 'openSessionInNewWindow':
    case 'switchWorkspace':
    case 'closeWindow':
    case 'confirmCloseWindow':
    case 'setTrafficLightsVisible':
      // No-op for webapp
      return
    
    // ============================================================
    // Session Management
    // ============================================================
    
    case 'getSessionMessages': {
      const [sessionId] = args as [string]
      return sm.getSession(sessionId)
    }
    
    case 'createSession': {
      const [workspaceId, options] = args as [string, unknown]
      return sm.createSession(workspaceId, options)
    }
    
    case 'deleteSession': {
      const [sessionId] = args as [string]
      return sm.deleteSession(sessionId)
    }
    
    case 'sendMessage': {
      const [sessionId, message, attachments, storedAttachments, options] = args as [string, string, unknown, unknown, unknown]
      // Fire and forget - results come via SSE
      sm.sendMessage(sessionId, message, attachments, storedAttachments, options).catch(err => {
        broadcast({
          type: 'error',
          sessionId,
          error: err instanceof Error ? err.message : 'Unknown error',
        })
        broadcast({
          type: 'complete',
          sessionId,
        })
      })
      return { started: true }
    }
    
    case 'cancelProcessing': {
      const [sessionId, silent] = args as [string, boolean | undefined]
      return sm.cancelProcessing(sessionId, silent)
    }
    
    case 'killShell': {
      const [sessionId, shellId] = args as [string, string]
      return sm.killShell(sessionId, shellId)
    }
    
    case 'getTaskOutput': {
      const [taskId] = args as [string]
      return sm.getTaskOutput(taskId)
    }
    
    case 'respondToPermission': {
      const [sessionId, requestId, allowed, alwaysAllow] = args as [string, string, boolean, boolean]
      return sm.respondToPermission(sessionId, requestId, allowed, alwaysAllow)
    }
    
    case 'respondToCredential': {
      const [sessionId, requestId, response] = args as [string, string, unknown]
      return sm.respondToCredential(sessionId, requestId, response)
    }
    
    case 'sessionCommand': {
      const [sessionId, command] = args as [string, unknown]
      return sm.handleSessionCommand(sessionId, command)
    }
    
    case 'getPendingPlanExecution': {
      const [sessionId] = args as [string]
      return sm.getPendingPlanExecution(sessionId)
    }
    
    // ============================================================
    // Workspace Management
    // ============================================================
    
    case 'createWorkspace': {
      const [folderPath, name] = args as [string, string]
      return sm.createWorkspace(folderPath, name)
    }
    
    case 'checkWorkspaceSlug': {
      const [slug] = args as [string]
      const workspacePath = join(DEFAULT_WORKSPACES_DIR, slug)
      return { exists: existsSync(workspacePath), path: workspacePath }
    }
    
    // ============================================================
    // File Operations (stubs - to be implemented)
    // ============================================================
    
    case 'readFile':
    case 'openFileDialog':
    case 'readFileAttachment':
    case 'storeAttachment':
    case 'generateThumbnail':
    case 'searchFiles':
    case 'openFolderDialog':
      throw new Error(`Method ${method} not yet implemented for webapp`)
    
    // ============================================================
    // Theme & Notifications (stubs)
    // ============================================================
    
    case 'getColorTheme':
      return 'system'
    
    case 'setColorTheme':
      return
    
    case 'loadPresetThemes':
      return []
    
    case 'loadPresetTheme':
      return null
    
    case 'setNotificationsEnabled':
      return
    
    case 'showNotification':
    case 'updateBadgeCount':
    case 'clearBadgeCount':
    case 'setDockIconWithBadge':
    case 'broadcastThemePreferences':
      return
    
    // ============================================================
    // Shell Operations
    // ============================================================
    
    case 'openUrl': {
      // Can't open URLs from server - let client handle
      return
    }
    
    case 'openFile':
    case 'showInFolder':
      // Not applicable for webapp
      return
    
    // ============================================================
    // Auth & Onboarding
    // ============================================================
    
    case 'showLogoutConfirmation':
      return true // Always confirm in webapp
    
    case 'showDeleteSessionConfirmation':
      return true // Always confirm in webapp
    
    case 'logout':
      // Clear credentials
      return
    
    case 'saveOnboardingConfig': {
      const [config] = args as [unknown]
      return sm.saveOnboardingConfig(config)
    }
    
    case 'updateApiSetup': {
      const [authType, credential, anthropicBaseUrl, customModel] = args as [string, string | undefined, string | null | undefined, string | null | undefined]
      return sm.updateApiSetup(authType, credential, anthropicBaseUrl, customModel)
    }
    
    case 'testApiConnection': {
      const [apiKey, baseUrl, modelName] = args as [string, string | undefined, string | undefined]
      return sm.testApiConnection(apiKey, baseUrl, modelName)
    }
    
    // OAuth - not supported in webapp (API key only)
    case 'startClaudeOAuth':
    case 'exchangeClaudeCode':
    case 'hasClaudeOAuthState':
    case 'clearClaudeOAuthState':
    case 'startWorkspaceMcpOAuth':
      throw new Error('OAuth not supported in webapp mode. Please use API key authentication.')
    
    // ============================================================
    // Sources, Skills, Labels, Views
    // ============================================================
    
    case 'getSources': {
      const [workspaceId] = args as [string]
      return sm.getSources(workspaceId)
    }
    
    case 'getSkills': {
      const [workspaceId] = args as [string]
      return sm.getSkills(workspaceId)
    }
    
    case 'listLabels': {
      const [workspaceId] = args as [string]
      return sm.listLabels(workspaceId)
    }
    
    case 'listStatuses': {
      const [workspaceId] = args as [string]
      return sm.listStatuses(workspaceId)
    }
    
    case 'listViews': {
      const [workspaceId] = args as [string]
      return sm.listViews(workspaceId)
    }
    
    // Stubs for other methods
    case 'createSource':
    case 'deleteSource':
    case 'startSourceOAuth':
    case 'saveSourceCredentials':
    case 'getSourcePermissionsConfig':
    case 'getWorkspacePermissionsConfig':
    case 'getDefaultPermissionsConfig':
    case 'getMcpTools':
    case 'getSkillFiles':
    case 'deleteSkill':
    case 'openSkillInEditor':
    case 'openSkillInFinder':
    case 'createLabel':
    case 'deleteLabel':
    case 'reorderStatuses':
    case 'saveViews':
    case 'readWorkspaceImage':
    case 'writeWorkspaceImage':
      throw new Error(`Method ${method} not yet implemented for webapp`)
    
    // ============================================================
    // Settings
    // ============================================================
    
    case 'getWorkspaceSettings': {
      const [workspaceId] = args as [string]
      return sm.getWorkspaceSettings(workspaceId)
    }
    
    case 'updateWorkspaceSetting': {
      const [workspaceId, key, value] = args as [string, string, unknown]
      return sm.updateWorkspaceSetting(workspaceId, key, value)
    }
    
    case 'getSessionModel': {
      const [sessionId, workspaceId] = args as [string, string]
      return sm.getSessionModel(sessionId, workspaceId)
    }
    
    case 'setSessionModel': {
      const [sessionId, workspaceId, model] = args as [string, string, string | null]
      return sm.setSessionModel(sessionId, workspaceId, model)
    }
    
    case 'readPreferences':
      return sm.readPreferences()
    
    case 'writePreferences': {
      const [content] = args as [string]
      return sm.writePreferences(content)
    }
    
    // ============================================================
    // Session Info Panel
    // ============================================================
    
    case 'getSessionFiles': {
      const [sessionId] = args as [string]
      return sm.getSessionFiles(sessionId)
    }
    
    case 'getSessionNotes': {
      const [sessionId] = args as [string]
      return sm.getSessionNotes(sessionId)
    }
    
    case 'setSessionNotes': {
      const [sessionId, content] = args as [string, string]
      return sm.setSessionNotes(sessionId, content)
    }
    
    case 'watchSessionFiles':
    case 'unwatchSessionFiles':
      // File watching not implemented for webapp
      return
    
    // ============================================================
    // Git Operations
    // ============================================================
    
    case 'getGitBranch': {
      const [dirPath] = args as [string]
      return sm.getGitBranch(dirPath)
    }
    
    case 'checkGitBash':
      return { available: false, reason: 'Not applicable on this platform' }
    
    case 'browseForGitBash':
    case 'setGitBashPath':
      return null
    
    // ============================================================
    // Auto-update (not applicable for webapp)
    // ============================================================
    
    case 'checkForUpdates':
    case 'getUpdateInfo':
      return { available: false }
    
    case 'installUpdate':
    case 'dismissUpdate':
    case 'getDismissedUpdateVersion':
      return null
    
    // ============================================================
    // Logo URL
    // ============================================================
    
    case 'getLogoUrl': {
      const [serviceUrl, provider] = args as [string, string | undefined]
      return sm.getLogoUrl(serviceUrl, provider)
    }
    
    case 'getWindowFocusState':
      return true // Always focused in webapp
    
    // ============================================================
    // Debug
    // ============================================================
    
    case 'debugLog': {
      console.log('[renderer]', ...args)
      return
    }
    
    default:
      throw new Error(`Unknown RPC method: ${method}`)
  }
}

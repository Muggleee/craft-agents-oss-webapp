/**
 * SessionManager for webapp - handles session and workspace management
 * Full implementation with CraftAgent integration for AI chat streaming
 */

import { homedir } from 'os'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { execSync } from 'child_process'
import type { SessionEvent, Session, Workspace, FileAttachment, StoredAttachment, SendMessageOptions, Message } from '../../../electron/src/shared/types'
import {
  loadStoredConfig,
  saveConfig,
  getWorkspaces,
  getWorkspaceByNameOrId,
  addWorkspace,
  setActiveWorkspace,
  getAnthropicBaseUrl,
  setAnthropicBaseUrl,
  getCustomModel,
  setCustomModel,
  getAuthType,
  setAuthType,
  getPreferencesPath,
  resolveModelId,
  type Workspace as ConfigWorkspace,
} from '@craft-agent/shared/config'
import {
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  updateSessionMetadata,
  getSessionPath as getSessionStoragePath,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { loadWorkspaceSources, type LoadedSource } from '@craft-agent/shared/sources'
import { loadWorkspaceSkills, type LoadedSkill } from '@craft-agent/shared/skills'
import { listLabels } from '@craft-agent/shared/labels/storage'
import { listStatuses } from '@craft-agent/shared/statuses'
import { listViews } from '@craft-agent/shared/views/storage'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CraftAgent, type AgentEvent, AbortReason, setPathToClaudeCodeExecutable, setInterceptorPath, setExecutable } from '@craft-agent/shared/agent'
import { generateSessionTitle } from '@craft-agent/shared/utils'
import { getAuthState } from '@craft-agent/shared/auth'

// Type for broadcast function
type BroadcastFn = (event: SessionEvent) => void

// Default workspace directory
const DEFAULT_WORKSPACES_DIR = join(homedir(), '.craft-agent', 'workspaces')

// Generate unique message ID
function generateMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

// Active agent sessions (for streaming)
interface ManagedSession {
  id: string
  session: Session
  workspace: ConfigWorkspace
  agent?: CraftAgent
  isProcessing: boolean
  streamingText: string
  messages: Message[]
  pendingTools: Map<string, string>  // toolUseId -> toolName
  parentToolStack: string[]  // Stack of parent tool IDs for nesting
  toolToParentMap: Map<string, string>  // toolUseId -> parentToolUseId
  pendingTextParent?: string  // Parent tool ID for streaming text
}

/**
 * Convert stored session to API session format
 */
function storedToSession(stored: StoredSession, workspaceId: string): Session {
  return {
    id: stored.id,
    workspaceId,
    name: stored.title || 'New Chat',
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    messages: stored.messages?.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      toolCalls: m.toolCalls,
      toolResults: m.toolResults,
      attachments: m.attachments,
      thinkingContent: m.thinkingContent,
    })) || [],
    isProcessing: false,
    isFlagged: stored.isFlagged || false,
    todoState: stored.todoState,
    isUnread: stored.isUnread || false,
    labels: stored.labels || [],
    workingDirectory: stored.workingDirectory,
  }
}

export class SessionManager {
  private broadcast: BroadcastFn
  private managedSessions: Map<string, ManagedSession> = new Map()
  private authInitialized: boolean = false
  private sdkInitialized: boolean = false
  
  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast
    // Ensure config is loaded
    loadStoredConfig()
  }
  
  // ============================================================
  // SDK and Authentication Setup (Critical for SDK to work)
  // ============================================================
  
  /**
   * Initialize SDK paths - must be called before any chat operations.
   * Sets up the path to the Claude Code SDK executable (cli.js) and network interceptor.
   */
  private initializeSdk(): void {
    if (this.sdkInitialized) return
    
    try {
      // Find the SDK cli.js in node_modules
      // For webapp, we resolve relative to the current module
      const { createRequire } = require('module')
      const require_ = createRequire(import.meta.url || __filename)
      const sdkPath = require_.resolve('@anthropic-ai/claude-agent-sdk/cli.js')
      
      console.log(`[SessionManager] Setting SDK path: ${sdkPath}`)
      setPathToClaudeCodeExecutable(sdkPath)
      
      // Set the bun executable path - needed when bun is not in PATH
      // Try to find bun in common locations
      const bunLocations = [
        join(homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
      ]
      for (const bunPath of bunLocations) {
        if (existsSync(bunPath)) {
          console.log(`[SessionManager] Setting bun executable: ${bunPath}`)
          setExecutable(bunPath)
          break
        }
      }
      
      // Try to set interceptor path (optional, for network error capture)
      // The interceptor is in packages/shared/src/network-interceptor.ts
      try {
        const interceptorPath = join(__dirname, '../../../../packages/shared/src/network-interceptor.ts')
        if (existsSync(interceptorPath)) {
          console.log(`[SessionManager] Setting interceptor path: ${interceptorPath}`)
          setInterceptorPath(interceptorPath)
        } else {
          // Try monorepo root path
          const monorepoInterceptorPath = join(__dirname, '../../../../../packages/shared/src/network-interceptor.ts')
          if (existsSync(monorepoInterceptorPath)) {
            console.log(`[SessionManager] Setting interceptor path: ${monorepoInterceptorPath}`)
            setInterceptorPath(monorepoInterceptorPath)
          } else {
            console.warn('[SessionManager] Network interceptor not found, skipping')
          }
        }
      } catch (e) {
        console.warn('[SessionManager] Could not set interceptor path:', e)
      }
      
      this.sdkInitialized = true
      console.log('[SessionManager] SDK initialized successfully')
    } catch (error) {
      console.error('[SessionManager] Failed to initialize SDK:', error)
      throw new Error(`SDK initialization failed: ${error}`)
    }
  }
  
  async reinitializeAuth(): Promise<void> {
    try {
      const authState = await getAuthState()
      const { billing } = authState
      const customBaseUrl = getAnthropicBaseUrl()
      
      console.log(`[SessionManager] Reinitializing auth with billing type: ${billing.type}`, customBaseUrl ? `(custom base URL: ${customBaseUrl})` : '')
      
      // Priority 1: Custom base URL (Ollama, OpenRouter, etc.)
      if (customBaseUrl) {
        process.env.ANTHROPIC_BASE_URL = customBaseUrl
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        
        if (billing.apiKey) {
          process.env.ANTHROPIC_API_KEY = billing.apiKey
          console.log(`[SessionManager] Using custom provider at ${customBaseUrl}`)
        } else {
          // Set a placeholder key for providers like Ollama that don't validate keys
          process.env.ANTHROPIC_API_KEY = 'not-needed'
          console.warn('[SessionManager] Custom base URL configured but no API key set. Using placeholder key.')
        }
      } else if (billing.type === 'oauth_token' && billing.claudeOAuthToken) {
        // Priority 2: Claude Max subscription via OAuth token
        process.env.CLAUDE_CODE_OAUTH_TOKEN = billing.claudeOAuthToken
        delete process.env.ANTHROPIC_API_KEY
        delete process.env.ANTHROPIC_BASE_URL
        console.log('[SessionManager] Set Claude Max OAuth Token')
      } else if (billing.apiKey) {
        // Priority 3: API key with default Anthropic endpoint
        process.env.ANTHROPIC_API_KEY = billing.apiKey
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        delete process.env.ANTHROPIC_BASE_URL
        console.log('[SessionManager] Set Anthropic API Key (prefix:', billing.apiKey.substring(0, 10) + '...)')
      } else {
        console.error('[SessionManager] No authentication configured!')
      }
      
      this.authInitialized = true
    } catch (error) {
      console.error('[SessionManager] Error reinitializing auth:', error)
    }
  }
  
  // ============================================================
  // Workspace Management
  // ============================================================
  
  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }
  
  createWorkspace(folderPath: string, name: string): Workspace {
    const workspace = addWorkspace({ name, rootPath: folderPath })
    setActiveWorkspace(workspace.id)
    return workspace
  }
  
  // ============================================================
  // Session Management
  // ============================================================
  
  getSessions(): Session[] {
    const workspaces = getWorkspaces()
    const allSessions: Session[] = []
    
    for (const workspace of workspaces) {
      try {
        const storedSessions = listStoredSessions(workspace.rootPath)
        for (const stored of storedSessions) {
          allSessions.push(storedToSession(stored, workspace.id))
        }
      } catch (err) {
        console.error(`Error loading sessions for workspace ${workspace.id}:`, err)
      }
    }
    
    // Sort by updatedAt descending
    return allSessions.sort((a, b) => 
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  }
  
  async getSession(sessionId: string): Promise<Session | null> {
    const workspaces = getWorkspaces()
    
    for (const workspace of workspaces) {
      try {
        const stored = await loadStoredSession(workspace.rootPath, sessionId)
        if (stored) {
          return storedToSession(stored, workspace.id)
        }
      } catch {
        // Not in this workspace
      }
    }
    
    return null
  }
  
  async createSession(workspaceId: string, options?: unknown): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`)
    }
    
    const opts = options as { name?: string; workingDirectory?: string } | undefined
    const stored = await createStoredSession(workspace.rootPath, {
      name: opts?.name,
      workingDirectory: opts?.workingDirectory || workspace.rootPath,
    })
    
    return storedToSession(stored, workspaceId)
  }
  
  async deleteSession(sessionId: string): Promise<void> {
    const workspaces = getWorkspaces()
    
    for (const workspace of workspaces) {
      try {
        await deleteStoredSession(workspace.rootPath, sessionId)
        this.managedSessions.delete(sessionId)
        return
      } catch {
        // Not in this workspace
      }
    }
  }
  
  // ============================================================
  // Get or Create Managed Session
  // ============================================================
  
  private async getOrCreateManagedSession(sessionId: string): Promise<ManagedSession> {
    let managed = this.managedSessions.get(sessionId)
    if (managed) {
      return managed
    }
    
    // Find session and workspace
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    
    const workspace = getWorkspaceByNameOrId(session.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${session.workspaceId}`)
    }
    
    // Create managed session
    managed = {
      id: sessionId,
      session,
      workspace,
      isProcessing: false,
      streamingText: '',
      messages: session.messages as Message[] || [],
      pendingTools: new Map(),
      parentToolStack: [],
      toolToParentMap: new Map(),
    }
    
    this.managedSessions.set(sessionId, managed)
    return managed
  }
  
  // ============================================================
  // Get or Create Agent
  // ============================================================
  
  private async getOrCreateAgent(managed: ManagedSession): Promise<CraftAgent> {
    if (managed.agent) {
      return managed.agent
    }
    
    // Load stored session to get session config
    const storedSession = await loadStoredSession(managed.workspace.rootPath, managed.id)
    
    console.log(`[SessionManager] Creating CraftAgent for session ${managed.id}`)
    console.log(`[SessionManager] Workspace: ${managed.workspace.rootPath}`)
    console.log(`[SessionManager] Session config: ${JSON.stringify(storedSession ? { id: storedSession.id, sdkSessionId: storedSession.sdkSessionId } : null)}`)
    
    // Create CraftAgent
    const agent = new CraftAgent({
      workspace: managed.workspace,
      session: storedSession || undefined,
      onSdkSessionIdUpdate: (sdkSessionId) => {
        console.log(`[SessionManager] SDK session ID updated: ${sdkSessionId}`)
      },
    })
    
    managed.agent = agent
    return agent
  }
  
  // ============================================================
  // Message Sending (Phase 1 - Full Implementation)
  // ============================================================
  
  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions
  ): Promise<void> {
    // Ensure SDK is initialized (paths to cli.js, etc.)
    this.initializeSdk()
    
    // Ensure auth is initialized before sending any message
    if (!this.authInitialized) {
      await this.reinitializeAuth()
    }
    
    const managed = await this.getOrCreateManagedSession(sessionId)
    
    // If currently processing, abort previous
    if (managed.isProcessing && managed.agent) {
      console.log(`[SessionManager] Session ${sessionId} is processing, aborting previous`)
      managed.agent.forceAbort(AbortReason.Redirect)
    }
    
    // Create user message
    const userMessage: Message = {
      id: generateMessageId(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
      attachments: storedAttachments,
    }
    managed.messages.push(userMessage)
    
    // Emit user_message event
    this.broadcast({
      type: 'user_message',
      sessionId,
      message: userMessage,
      status: 'accepted',
    })
    
    // Set processing state
    managed.isProcessing = true
    managed.streamingText = ''
    managed.pendingTools.clear()
    managed.parentToolStack = []
    managed.toolToParentMap.clear()
    
    // Get or create agent
    const agent = await this.getOrCreateAgent(managed)
    
    try {
      console.log(`[SessionManager] Starting chat for session: ${sessionId}`)
      console.log(`[SessionManager] Message: ${message}`)
      console.log(`[SessionManager] Agent model: ${agent.getModel()}`)
      
      // Process the message through the agent
      console.log(`[SessionManager] Calling agent.chat()...`)
      const chatIterator = agent.chat(message, attachments)
      console.log(`[SessionManager] Got chat iterator, starting iteration...`)
      
      for await (const event of chatIterator) {
        // Log events
        console.log(`[SessionManager] Event: ${event.type}`)
        
        // Process event
        this.processEvent(managed, event)
        
        // Handle complete event
        if (event.type === 'complete') {
          console.log(`[SessionManager] Chat completed for session: ${sessionId}`)
          managed.isProcessing = false
          this.broadcast({
            type: 'complete',
            sessionId,
          })
          return
        }
      }
    } catch (error) {
      console.error(`[SessionManager] Error in sendMessage:`, error)
      managed.isProcessing = false
      
      // Send error event
      this.broadcast({
        type: 'error',
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      
      // Send complete event
      this.broadcast({
        type: 'complete',
        sessionId,
      })
    }
  }
  
  // ============================================================
  // Process Agent Events
  // ============================================================
  
  private processEvent(managed: ManagedSession, event: AgentEvent): void {
    const sessionId = managed.id
    
    switch (event.type) {
      case 'text_delta':
        // Capture parent on first delta
        if (managed.streamingText === '') {
          managed.pendingTextParent = managed.parentToolStack.length > 0
            ? managed.parentToolStack[managed.parentToolStack.length - 1]
            : undefined
        }
        managed.streamingText += event.text
        
        // Send delta to client
        this.broadcast({
          type: 'text_delta',
          sessionId,
          delta: event.text,
          turnId: event.turnId,
        })
        break
        
      case 'text_complete': {
        const textParentToolUseId = event.isIntermediate ? managed.pendingTextParent : undefined
        
        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: Date.now(),
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: textParentToolUseId,
        }
        managed.messages.push(assistantMessage)
        managed.streamingText = ''
        managed.pendingTextParent = undefined
        
        this.broadcast({
          type: 'text_complete',
          sessionId,
          text: event.text,
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: textParentToolUseId,
        })
        break
      }
      
      case 'tool_start': {
        // Track tool
        managed.pendingTools.set(event.toolUseId, event.toolName)
        
        // Determine parent
        const PARENT_TOOLS = ['Task', 'TaskOutput']
        const isParentTool = PARENT_TOOLS.includes(event.toolName)
        
        let parentToolUseId: string | undefined
        if (isParentTool) {
          parentToolUseId = undefined
        } else if (event.parentToolUseId) {
          parentToolUseId = event.parentToolUseId
        } else if (managed.parentToolStack.length > 0) {
          parentToolUseId = managed.parentToolStack[managed.parentToolStack.length - 1]
        }
        
        // Push parent tool to stack
        if (isParentTool) {
          managed.parentToolStack.push(event.toolUseId)
        }
        
        // Store parent mapping
        if (parentToolUseId) {
          managed.toolToParentMap.set(event.toolUseId, parentToolUseId)
        }
        
        // Add tool message
        const toolStartMessage: Message = {
          id: generateMessageId(),
          role: 'tool',
          content: `Running ${event.toolName}...`,
          timestamp: Date.now(),
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          toolInput: event.input,
          toolStatus: 'pending',
          toolIntent: event.intent,
          toolDisplayName: event.displayName,
          turnId: event.turnId,
          parentToolUseId,
        }
        managed.messages.push(toolStartMessage)
        
        this.broadcast({
          type: 'tool_start',
          sessionId,
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          toolInput: event.input || {},
          toolIntent: event.intent,
          toolDisplayName: event.displayName,
          turnId: event.turnId,
          parentToolUseId,
        })
        break
      }
      
      case 'tool_result': {
        const toolName = managed.pendingTools.get(event.toolUseId) || 'unknown'
        managed.pendingTools.delete(event.toolUseId)
        
        // Remove from parent stack if parent tool
        const PARENT_TOOLS = ['Task', 'TaskOutput']
        const stackIndex = managed.parentToolStack.indexOf(event.toolUseId)
        if (stackIndex !== -1) {
          managed.parentToolStack.splice(stackIndex, 1)
        }
        
        // Get stored parent
        const storedParentId = managed.toolToParentMap.get(event.toolUseId)
        managed.toolToParentMap.delete(event.toolUseId)
        
        // Update existing tool message
        const existingToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        if (existingToolMsg) {
          existingToolMsg.content = event.result || ''
          existingToolMsg.toolResult = event.result
          existingToolMsg.toolStatus = 'completed'
          existingToolMsg.isError = event.isError
        }
        
        const finalParentToolUseId = existingToolMsg?.parentToolUseId || storedParentId
        
        this.broadcast({
          type: 'tool_result',
          sessionId,
          toolUseId: event.toolUseId,
          toolName: toolName,
          result: event.result || '',
          turnId: event.turnId,
          parentToolUseId: finalParentToolUseId,
          isError: event.isError,
        })
        break
      }
      
      case 'status':
        this.broadcast({
          type: 'status',
          sessionId,
          message: event.message,
        })
        break
        
      case 'info':
        this.broadcast({
          type: 'info',
          sessionId,
          message: event.message,
        })
        break
        
      case 'error':
        this.broadcast({
          type: 'error',
          sessionId,
          error: event.message,
        })
        break
        
      case 'thinking_delta':
        this.broadcast({
          type: 'thinking_delta',
          sessionId,
          delta: event.text,
          turnId: event.turnId,
        })
        break
        
      case 'thinking_complete':
        this.broadcast({
          type: 'thinking_complete',
          sessionId,
          text: event.text,
          turnId: event.turnId,
        })
        break
        
      case 'permission_request':
        this.broadcast({
          type: 'permission_request',
          sessionId,
          requestId: event.requestId,
          toolName: event.toolName,
          command: event.command,
          description: event.description,
        })
        break
      
      case 'typed_error':
        // Log typed errors with full details
        console.log(`[SessionManager] Typed error:`, JSON.stringify(event, null, 2))
        this.broadcast({
          type: 'error',
          sessionId,
          error: (event as any).message || (event as any).error || 'Unknown typed error',
        })
        break
        
      default:
        // Log unhandled events with full details
        console.log(`[SessionManager] Unhandled event type: ${(event as any).type}`, JSON.stringify(event, null, 2))
    }
  }
  
  // ============================================================
  // Processing Control
  // ============================================================
  
  async cancelProcessing(sessionId: string, silent?: boolean): Promise<void> {
    const managed = this.managedSessions.get(sessionId)
    if (managed?.agent && managed.isProcessing) {
      managed.agent.forceAbort(AbortReason.UserStop)
      managed.isProcessing = false
      
      if (!silent) {
        this.broadcast({
          type: 'complete',
          sessionId,
        })
      }
    }
  }
  
  async killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }> {
    // TODO: Implement shell management
    return { success: false, error: 'Not implemented' }
  }
  
  async getTaskOutput(taskId: string): Promise<string | null> {
    // TODO: Implement task output
    return null
  }
  
  async respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean): Promise<boolean> {
    const managed = this.managedSessions.get(sessionId)
    if (!managed?.agent) {
      return false
    }
    
    // Use agent's permission resolver
    managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
    return true
  }
  
  async respondToCredential(sessionId: string, requestId: string, response: unknown): Promise<boolean> {
    // TODO: Implement credential handling
    return false
  }
  
  // ============================================================
  // Session Commands
  // ============================================================
  
  async handleSessionCommand(sessionId: string, command: unknown): Promise<unknown> {
    const cmd = command as { type: string; [key: string]: unknown }
    const session = await this.getSession(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    
    const workspace = getWorkspaceByNameOrId(session.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found: ${session.workspaceId}`)
    }
    
    switch (cmd.type) {
      case 'flag':
        await updateSessionMetadata(workspace.rootPath, sessionId, { isFlagged: true })
        return
      case 'unflag':
        await updateSessionMetadata(workspace.rootPath, sessionId, { isFlagged: false })
        return
      case 'rename':
        await updateSessionMetadata(workspace.rootPath, sessionId, { title: cmd.name as string })
        return
      case 'setTodoState':
        await updateSessionMetadata(workspace.rootPath, sessionId, { todoState: cmd.state as string })
        return
      case 'markRead':
        await updateSessionMetadata(workspace.rootPath, sessionId, { isUnread: false })
        return
      case 'markUnread':
        await updateSessionMetadata(workspace.rootPath, sessionId, { isUnread: true })
        return
      case 'setLabels':
        await updateSessionMetadata(workspace.rootPath, sessionId, { labels: cmd.labels as string[] })
        return
      case 'showInFinder':
      case 'copyPath':
        // Not applicable for webapp
        return { success: false }
      default:
        console.warn(`Unhandled session command: ${cmd.type}`)
        return
    }
  }
  
  async getPendingPlanExecution(sessionId: string): Promise<{ planPath: string; awaitingCompaction: boolean } | null> {
    // TODO: Implement
    return null
  }
  
  // ============================================================
  // Sources, Skills, Labels, etc.
  // ============================================================
  
  getSources(workspaceId: string): LoadedSource[] {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    return loadWorkspaceSources(workspace.rootPath)
  }
  
  getSkills(workspaceId: string): LoadedSkill[] {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    return loadWorkspaceSkills(workspace.rootPath)
  }
  
  listLabels(workspaceId: string): unknown[] {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    return listLabels(workspace.rootPath)
  }
  
  listStatuses(workspaceId: string): unknown[] {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    return listStatuses(workspace.rootPath)
  }
  
  listViews(workspaceId: string): unknown[] {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return []
    return listViews(workspace.rootPath)
  }
  
  // ============================================================
  // Settings
  // ============================================================
  
  getWorkspaceSettings(workspaceId: string): unknown {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return null
    // TODO: Load workspace-specific settings
    return {}
  }
  
  updateWorkspaceSetting(workspaceId: string, key: string, value: unknown): void {
    // TODO: Implement
  }
  
  getSessionModel(sessionId: string, workspaceId: string): string | null {
    // TODO: Implement session-specific model
    return null
  }
  
  setSessionModel(sessionId: string, workspaceId: string, model: string | null): void {
    // TODO: Implement
  }
  
  async readPreferences(): Promise<{ content: string; exists: boolean; path: string }> {
    const path = getPreferencesPath()
    try {
      const content = await readFile(path, 'utf-8')
      return { content, exists: true, path }
    } catch {
      return { content: '', exists: false, path }
    }
  }
  
  async writePreferences(content: string): Promise<{ success: boolean; error?: string }> {
    const path = getPreferencesPath()
    try {
      await writeFile(path, content, 'utf-8')
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  }
  
  // ============================================================
  // Session Info Panel
  // ============================================================
  
  async getSessionFiles(sessionId: string): Promise<unknown[]> {
    // TODO: Implement
    return []
  }
  
  async getSessionNotes(sessionId: string): Promise<string> {
    // TODO: Implement
    return ''
  }
  
  async setSessionNotes(sessionId: string, content: string): Promise<void> {
    // TODO: Implement
  }
  
  // ============================================================
  // Onboarding & API Setup
  // ============================================================
  
  async saveOnboardingConfig(config: unknown): Promise<unknown> {
    const cfg = config as {
      authType?: string
      credential?: string
      anthropicBaseUrl?: string | null
      customModel?: string | null
    }
    
    if (cfg.authType) {
      setAuthType(cfg.authType as 'api_key' | 'oauth')
    }
    
    if (cfg.credential) {
      const credManager = getCredentialManager()
      const authType = cfg.authType || getAuthType()
      await credManager.setCredential(authType as 'api_key' | 'oauth', cfg.credential)
    }
    
    if (cfg.anthropicBaseUrl !== undefined) {
      setAnthropicBaseUrl(cfg.anthropicBaseUrl)
    }
    
    if (cfg.customModel !== undefined) {
      setCustomModel(cfg.customModel)
    }
    
    saveConfig()
    
    return { success: true }
  }
  
  async updateApiSetup(
    authType: string,
    credential?: string,
    anthropicBaseUrl?: string | null,
    customModel?: string | null
  ): Promise<void> {
    setAuthType(authType as 'api_key' | 'oauth')
    
    if (credential) {
      const credManager = getCredentialManager()
      await credManager.setCredential(authType as 'api_key' | 'oauth', credential)
    }
    
    if (anthropicBaseUrl !== undefined) {
      setAnthropicBaseUrl(anthropicBaseUrl)
    }
    
    if (customModel !== undefined) {
      setCustomModel(customModel)
    }
    
    saveConfig()
  }
  
  async testApiConnection(apiKey: string, baseUrl?: string, modelName?: string): Promise<{ success: boolean; error?: string; modelCount?: number }> {
    try {
      // Simple test - try to list models
      const url = baseUrl || 'https://api.anthropic.com'
      const response = await fetch(`${url}/v1/models`, {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      })
      
      if (!response.ok) {
        const text = await response.text()
        return { success: false, error: `API error: ${response.status} ${text}` }
      }
      
      const data = await response.json() as { data?: unknown[] }
      return { success: true, modelCount: data.data?.length || 0 }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Connection failed' }
    }
  }
  
  // ============================================================
  // Git Operations
  // ============================================================
  
  getGitBranch(dirPath: string): string | null {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
      return branch || null
    } catch {
      return null
    }
  }
  
  // ============================================================
  // Logo URL
  // ============================================================
  
  async getLogoUrl(serviceUrl: string, provider?: string): Promise<string | null> {
    // TODO: Implement logo fetching
    return null
  }
}

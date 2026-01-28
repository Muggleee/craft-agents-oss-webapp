/**
 * Webapp initialization - loads web adapter then boots the app
 */

// Import web adapter first - this injects window.electronAPI
import '../adapters/electron-api'

// Now load the main app (same as electron renderer)
import '../../../electron/src/renderer/main.tsx'

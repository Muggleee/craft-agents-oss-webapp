/**
 * TerminalPreviewOverlay - Overlay for terminal output (Bash/Grep/Glob tools)
 *
 * Uses PreviewOverlay for presentation and TerminalOutput for display.
 */

import * as React from 'react'
import { Terminal, Search, FolderSearch } from 'lucide-react'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'
import { TerminalOutput, type ToolType } from '../terminal/TerminalOutput'

export interface TerminalPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** The command that was executed */
  command: string
  /** The output from the command */
  output: string
  /** Exit code (0 = success) */
  exitCode?: number
  /** Tool type for display styling */
  toolType?: ToolType
  /** Optional description of what the command does */
  description?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Error message if the command failed to execute */
  error?: string
  /** Render inline without dialog (for playground) */
  embedded?: boolean
}

function getToolConfig(toolType: ToolType): {
  icon: typeof Terminal
  label: string
  variant: BadgeVariant
} {
  switch (toolType) {
    case 'grep':
      return { icon: Search, label: 'Grep', variant: 'green' }
    case 'glob':
      return { icon: FolderSearch, label: 'Glob', variant: 'purple' }
    default:
      return { icon: Terminal, label: 'Bash', variant: 'gray' }
  }
}

export function TerminalPreviewOverlay({
  isOpen,
  onClose,
  command,
  output,
  exitCode,
  toolType = 'bash',
  description,
  theme = 'light',
  error,
  embedded,
}: TerminalPreviewOverlayProps) {
  const config = getToolConfig(toolType)

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      badge={{
        icon: config.icon,
        label: config.label,
        variant: config.variant,
      }}
      title={description || ''}
      error={error ? { label: 'Command Failed', message: error } : undefined}
      embedded={embedded}
      className="bg-foreground-3"
    >
      {/* Terminal frame - chaps.app inspired */}
      <div className="absolute inset-0 flex items-center justify-center p-6 overflow-auto">
        <div
          className="relative w-full max-w-[850px] h-full max-h-[80vh] flex flex-col rounded-2xl overflow-hidden backdrop-blur-sm shadow-strong bg-background"
        >
          {/* Title Bar with traffic lights */}
          <div className="flex justify-between items-center px-4 py-3 border-b border-foreground/12 select-none shrink-0">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full border border-foreground/15"></div>
              <div className="w-3 h-3 rounded-full border border-foreground/15"></div>
              <div className="w-3 h-3 rounded-full border border-foreground/15"></div>
            </div>
            <div className="text-xs font-semibold tracking-wider text-foreground/30">
              Terminal
            </div>
            <div className="w-12"></div>
          </div>

          {/* Content Area */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <TerminalOutput
              command={command}
              output={output}
              exitCode={exitCode}
              toolType={toolType}
              description={description}
              theme={theme}
            />
          </div>
        </div>
      </div>
    </PreviewOverlay>
  )
}

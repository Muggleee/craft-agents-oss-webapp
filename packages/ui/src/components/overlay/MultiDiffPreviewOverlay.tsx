/**
 * MultiDiffPreviewOverlay - Overlay for multiple file changes (Edit/Write tools)
 *
 * Features:
 * - Sidebar navigation when multiple files changed
 * - Consolidated view (group by file) or individual changes
 * - Unified diff viewer for each change
 * - Focused change support (jump to specific change)
 */

import * as React from 'react'
import { useState, useMemo, useCallback, useEffect } from 'react'
import { PencilLine, FilePlus, ChevronDown, Check } from 'lucide-react'
import { parseDiffFromFile, type FileContents } from '@pierre/diffs'
import { ShikiDiffViewer, getDiffStats } from '../code-viewer/ShikiDiffViewer'
import { DiffViewerControls } from '../code-viewer/DiffViewerControls'
import { truncateFilePath, LANGUAGE_MAP } from '../code-viewer/language-map'
import { PreviewOverlay, type BadgeVariant } from './PreviewOverlay'

/**
 * A single file change (Edit or Write)
 */
export interface FileChange {
  /** Unique ID for this change */
  id: string
  /** Absolute file path */
  filePath: string
  /** Tool type: Edit or Write */
  toolType: 'Edit' | 'Write'
  /** For Edit: the old_string; For Write: empty or previous content if available */
  original: string
  /** For Edit: the new_string; For Write: the written content */
  modified: string
  /** Error message if the tool failed */
  error?: string
}

/**
 * Diff viewer display preferences
 * Passed from parent to avoid localStorage usage - all settings stored in preferences.json
 */
export interface DiffViewerSettings {
  diffStyle: 'unified' | 'split'
  disableBackground: boolean
}

export interface MultiDiffPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** List of file changes to display */
  changes: FileChange[]
  /** Whether to consolidate changes by file path (default: true) */
  consolidated?: boolean
  /** ID of change to focus on initially */
  focusedChangeId?: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Callback to open file in external editor */
  onOpenFile?: (filePath: string) => void
  /** Render inline without dialog (for playground) */
  embedded?: boolean
  /** Initial diff viewer settings (from user preferences) */
  diffViewerSettings?: Partial<DiffViewerSettings>
  /** Callback when diff viewer settings change (to persist to preferences) */
  onDiffViewerSettingsChange?: (settings: DiffViewerSettings) => void
}

// ============================================
// Sidebar Components
// ============================================

interface SidebarEntry {
  key: string
  filePath: string
  changes: FileChange[]
  toolType?: 'Edit' | 'Write'
}

function createSidebarEntries(changes: FileChange[], consolidated: boolean): SidebarEntry[] {
  // Filter out errored changes for display
  const successfulChanges = changes.filter(c => !c.error)

  if (!consolidated) {
    return successfulChanges.map(change => ({
      key: change.id,
      filePath: change.filePath,
      changes: [change],
      toolType: change.toolType,
    }))
  }

  // Group by file path
  const byPath = new Map<string, FileChange[]>()
  for (const change of successfulChanges) {
    const existing = byPath.get(change.filePath) || []
    existing.push(change)
    byPath.set(change.filePath, existing)
  }

  return Array.from(byPath.entries()).map(([filePath, fileChanges]) => ({
    key: filePath,
    filePath,
    changes: fileChanges,
  }))
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

function getParentDir(filePath: string): string {
  const parts = filePath.split('/')
  if (parts.length <= 2) return ''
  return parts.slice(-3, -1).join('/')
}

interface SidebarItemProps {
  entry: SidebarEntry
  isSelected: boolean
  onClick: () => void
  theme: 'light' | 'dark'
}

function SidebarItem({ entry, isSelected, onClick, theme }: SidebarItemProps) {
  const fileName = getFileName(entry.filePath)
  const parentDir = getParentDir(entry.filePath)
  const changeCount = entry.changes.length

  const textColor = 'var(--foreground)'
  const mutedColor = 'var(--foreground-50)'

  return (
    <button
      onClick={onClick}
      title={entry.filePath}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left rounded-md transition-colors"
      style={{
        color: textColor,
        backgroundColor: isSelected ? 'var(--foreground-5)' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.backgroundColor = 'var(--foreground-3)'
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.backgroundColor = 'transparent'
        }
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{fileName}</div>
        {parentDir && (
          <div className="text-[10px] truncate" style={{ color: mutedColor }}>
            {parentDir}
          </div>
        )}
      </div>
      {changeCount > 1 && (
        <span className="text-xs shrink-0" style={{ color: mutedColor }}>
          ({changeCount})
        </span>
      )}
    </button>
  )
}

interface SidebarProps {
  entries: SidebarEntry[]
  selectedKey: string | null
  onSelect: (key: string) => void
  theme: 'light' | 'dark'
}

function Sidebar({ entries, selectedKey, onSelect, theme }: SidebarProps) {
  const mutedColor = 'var(--foreground-50)'

  return (
    <div className="space-y-0.5">
      <div
        className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide"
        style={{ color: mutedColor }}
      >
        Changes
      </div>
      {entries.map(entry => (
        <SidebarItem
          key={entry.key}
          entry={entry}
          isSelected={selectedKey === entry.key}
          onClick={() => onSelect(entry.key)}
          theme={theme}
        />
      ))}
    </div>
  )
}

// ============================================
// View Mode Dropdown (Snippet vs Full File)
// ============================================

interface ViewModeDropdownProps {
  viewMode: 'snippet' | 'full'
  onViewModeChange: (mode: 'snippet' | 'full') => void
  disabled?: boolean
  theme: 'light' | 'dark'
}

function ViewModeDropdown({ viewMode, onViewModeChange, disabled }: ViewModeDropdownProps) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="relative ml-auto">
      <button
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 h-[26px] px-2.5 rounded-[6px] text-[13px] font-medium transition-colors"
        style={{
          backgroundColor: 'var(--foreground-5)',
          color: 'var(--foreground)',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'wait' : 'pointer',
        }}
      >
        {viewMode === 'full' ? 'Full File' : 'Snippet'}
        <ChevronDown className="w-3.5 h-3.5" />
      </button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />

          {/* Dropdown menu */}
          <div
            className="absolute right-0 top-full mt-1 z-20 py-1 rounded-lg shadow-lg min-w-[120px]"
            style={{
              backgroundColor: 'var(--foreground-5)',
              border: '1px solid var(--foreground-10)',
            }}
          >
            <button
              onClick={() => { onViewModeChange('snippet'); setIsOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-sm transition-colors"
              style={{ color: 'var(--foreground)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--foreground-5)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              Snippet
              <Check className={`w-3.5 h-3.5 ${viewMode !== 'snippet' ? 'opacity-0' : ''}`} />
            </button>
            <button
              onClick={() => { onViewModeChange('full'); setIsOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-sm transition-colors"
              style={{ color: 'var(--foreground)' }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--foreground-5)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              Full File
              <Check className={`w-3.5 h-3.5 ${viewMode !== 'full' ? 'opacity-0' : ''}`} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ============================================
// Main Component
// ============================================

export function MultiDiffPreviewOverlay({
  isOpen,
  onClose,
  changes,
  consolidated = true,
  focusedChangeId,
  theme = 'light',
  onOpenFile,
  embedded,
  diffViewerSettings,
  onDiffViewerSettingsChange,
}: MultiDiffPreviewOverlayProps) {
  // Create sidebar entries
  const sidebarEntries = useMemo(() => {
    return createSidebarEntries(changes, consolidated)
  }, [changes, consolidated])

  // Selection state
  const [selectedKey, setSelectedKey] = useState<string | null>(() => {
    // If focusedChangeId provided, find and select it
    if (focusedChangeId) {
      if (!consolidated) {
        return focusedChangeId
      }
      // In consolidated mode, find the file that contains this change
      const change = changes.find(c => c.id === focusedChangeId)
      if (change) {
        return change.filePath
      }
    }
    // Default to first entry
    return sidebarEntries[0]?.key || null
  })

  // View mode state (snippet vs full file)
  // Note: Full file mode requires reading from filesystem which isn't available in overlay
  // So we only support snippet mode in the overlay version
  const [viewMode] = useState<'snippet' | 'full'>('snippet')

  // Diff viewer controls state - initialized from props (user preferences)
  // Settings are persisted via onDiffViewerSettingsChange callback to preferences.json
  const [diffStyle, setDiffStyleInternal] = useState<'unified' | 'split'>(
    diffViewerSettings?.diffStyle ?? 'unified'
  )
  const [disableBackground, setDisableBackgroundInternal] = useState(
    diffViewerSettings?.disableBackground ?? false
  )

  // Wrap setters to also call the persistence callback
  const setDiffStyle = useCallback((style: 'unified' | 'split') => {
    setDiffStyleInternal(style)
    onDiffViewerSettingsChange?.({ diffStyle: style, disableBackground })
  }, [disableBackground, onDiffViewerSettingsChange])

  const setDisableBackground = useCallback((disabled: boolean) => {
    setDisableBackgroundInternal(disabled)
    onDiffViewerSettingsChange?.({ diffStyle, disableBackground: disabled })
  }, [diffStyle, onDiffViewerSettingsChange])

  // Reset selection when focusedChangeId changes (user clicked a specific change)
  // Note: We intentionally don't include selectedKey to avoid resetting user selections
  useEffect(() => {
    if (focusedChangeId) {
      if (!consolidated) {
        setSelectedKey(focusedChangeId)
      } else {
        const change = changes.find(c => c.id === focusedChangeId)
        if (change) {
          setSelectedKey(change.filePath)
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedChangeId])

  // Reset to first entry if current selection becomes invalid (e.g., changes array updated)
  useEffect(() => {
    if (sidebarEntries.length > 0) {
      setSelectedKey(prevKey => {
        // Keep current selection if it's still valid
        if (prevKey && sidebarEntries.find(e => e.key === prevKey)) {
          return prevKey
        }
        // Otherwise select first entry
        return sidebarEntries[0]?.key || null
      })
    }
  }, [sidebarEntries])

  // Get selected entry
  const selectedEntry = useMemo(() => {
    if (!selectedKey) return null
    return sidebarEntries.find(e => e.key === selectedKey) || null
  }, [sidebarEntries, selectedKey])

  // Compute combined diff for the selected entry
  const combinedDiff = useMemo(() => {
    if (!selectedEntry) return { original: '', modified: '' }

    const entryChanges = selectedEntry.changes
    if (entryChanges.length === 1) {
      const firstChange = entryChanges[0]
      return {
        original: firstChange?.original ?? '',
        modified: firstChange?.modified ?? '',
      }
    }

    // Multiple changes to same file - combine with separator
    const separator = '\n\n// ───────────────────────────────────────\n\n'
    return {
      original: entryChanges.map(c => c.original).join(separator),
      modified: entryChanges.map(c => c.modified).join(separator),
    }
  }, [selectedEntry])

  // Calculate diff stats for the header controls
  // Uses the same diff parsing logic as ShikiDiffViewer
  const diffStats = useMemo(() => {
    if (!selectedEntry || !combinedDiff.original && !combinedDiff.modified) {
      return { additions: 0, deletions: 0 }
    }

    const ext = selectedEntry.filePath.split('.').pop()?.toLowerCase() || ''
    const lang = LANGUAGE_MAP[ext] || 'text'

    const oldFile: FileContents = {
      name: selectedEntry.filePath,
      contents: combinedDiff.original,
      lang: lang as any,
    }
    const newFile: FileContents = {
      name: selectedEntry.filePath,
      contents: combinedDiff.modified,
      lang: lang as any,
    }

    const fileDiff = parseDiffFromFile(oldFile, newFile)
    return getDiffStats(fileDiff)
  }, [selectedEntry, combinedDiff])

  const handleSelectEntry = useCallback((key: string) => {
    setSelectedKey(key)
  }, [])

  // Determine if we should show sidebar
  const showSidebar = sidebarEntries.length > 1

  // Compute header badge dynamically based on selected entry
  const badge = useMemo((): { icon: typeof PencilLine; label: string; variant: BadgeVariant } => {
    if (selectedEntry) {
      const hasWrite = selectedEntry.changes.some(c => c.toolType === 'Write')
      return {
        icon: hasWrite ? FilePlus : PencilLine,
        label: selectedEntry.changes.length > 1
          ? `${selectedEntry.changes.length} ${hasWrite ? 'Write' : 'Edit'}s`
          : (hasWrite ? 'Write' : 'Edit'),
        variant: hasWrite ? 'green' : 'orange',
      }
    }
    return { icon: PencilLine, label: 'Edit', variant: 'orange' }
  }, [selectedEntry])

  const headerTitle = selectedEntry
    ? truncateFilePath(selectedEntry.filePath)
    : `${sidebarEntries.length} file${sidebarEntries.length !== 1 ? 's' : ''}`
  const headerTitleClick = selectedEntry && onOpenFile
    ? () => onOpenFile(selectedEntry.filePath)
    : undefined

  // Header actions with diff controls
  const headerActions = selectedEntry ? (
    <DiffViewerControls
      additions={diffStats.additions}
      deletions={diffStats.deletions}
      diffStyle={diffStyle}
      onDiffStyleChange={setDiffStyle}
      disableBackground={disableBackground}
      onBackgroundChange={setDisableBackground}
    />
  ) : null

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      badge={badge}
      title={headerTitle}
      onTitleClick={headerTitleClick}
      headerActions={headerActions}
      embedded={embedded}
    >
      {/* Sidebar + diff content fills the available space */}
      <div className="absolute inset-0 flex">
        {/* Sidebar navigation for multiple files */}
        {showSidebar && (
          <div className="w-64 shrink-0 h-full overflow-y-auto">
            <div className="px-2 py-2">
              <Sidebar
                entries={sidebarEntries}
                selectedKey={selectedKey}
                onSelect={handleSelectEntry}
                theme={theme}
              />
            </div>
          </div>
        )}

        {/* Main diff area */}
        <div className="flex-1 min-w-0 h-full">
          {selectedEntry ? (
            <ShikiDiffViewer
              key={`${selectedKey}-${diffStyle}-${disableBackground}`}
              original={combinedDiff.original}
              modified={combinedDiff.modified}
              filePath={selectedEntry.filePath}
              diffStyle={diffStyle}
              disableBackground={disableBackground}
              theme={theme}
            />
          ) : (
            <div
              className="h-full flex items-center justify-center"
              style={{ color: 'var(--foreground-50)' }}
            >
              Select a file to view changes
            </div>
          )}
        </div>
      </div>
    </PreviewOverlay>
  )
}

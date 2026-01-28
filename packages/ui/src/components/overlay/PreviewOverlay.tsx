/**
 * PreviewOverlay - Base component for all preview overlays
 *
 * Provides unified presentation logic for modal/fullscreen overlays:
 * - Portal rendering to document.body (via FullscreenOverlayBase for fullscreen mode)
 * - Responsive modal (>=1200px) vs fullscreen (<1200px) modes
 * - Escape key to close
 * - Backdrop click to close (modal mode)
 * - Consistent header layout with badge, title, close button
 * - Optional error banner
 *
 * Used by: CodePreviewOverlay, TerminalPreviewOverlay, GenericOverlay
 */

import { useEffect, type ReactNode } from 'react'
import * as ReactDOM from 'react-dom'
import { X, type LucideIcon } from 'lucide-react'
import { useOverlayMode, OVERLAY_LAYOUT } from '../../lib/layout'
import { PreviewHeader, PreviewHeaderBadge, type PreviewBadgeVariant } from '../ui/PreviewHeader'
import { FullscreenOverlayBase } from './FullscreenOverlayBase'

/** Badge color variants - re-export for backwards compatibility */
export type BadgeVariant = PreviewBadgeVariant

/** Shared background class for all overlay modes - single source of truth */
const OVERLAY_BG = 'bg-background'

export interface PreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** Theme mode */
  theme?: 'light' | 'dark'

  /** Header badge configuration */
  badge: {
    icon: LucideIcon
    label: string
    variant: BadgeVariant
  }

  /** Main title (e.g., file path) */
  title: string
  /** Callback when title is clicked (e.g., to open file) */
  onTitleClick?: () => void
  /** Optional subtitle (e.g., line range info) */
  subtitle?: ReactNode

  /** Optional error state */
  error?: {
    label: string
    message: string
  }

  /** Actions to show in header (rendered after badges) */
  headerActions?: ReactNode

  /** Main content */
  children: ReactNode

  /** Render inline (no dialog/portal) — for embedding in design system playground */
  embedded?: boolean

  /** Custom class names for the overlay container (e.g., to override bg-background) */
  className?: string
}

export function PreviewOverlay({
  isOpen,
  onClose,
  theme = 'light',
  badge,
  title,
  onTitleClick,
  subtitle,
  error,
  headerActions,
  children,
  embedded = false,
  className,
}: PreviewOverlayProps) {
  // Use custom className if provided, otherwise fall back to default bg
  const bgClass = className || OVERLAY_BG
  const responsiveMode = useOverlayMode()
  const isModal = responsiveMode === 'modal'

  // Handle Escape key for modal mode only (fullscreen mode uses FullscreenOverlayBase which handles ESC)
  useEffect(() => {
    if (!isOpen || !isModal) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, isModal, onClose])

  if (!isOpen && !embedded) return null

  const header = (
    <PreviewHeader onClose={onClose} height={48} rightActions={headerActions}>
      <PreviewHeaderBadge
        icon={badge.icon}
        label={badge.label}
        variant={badge.variant}
      />
      <PreviewHeaderBadge label={title} onClick={onTitleClick} shrinkable />
      {subtitle && <PreviewHeaderBadge label={String(subtitle)} />}
    </PreviewHeader>
  )

  const errorBanner = error && (
    <div className="px-4 py-3 bg-destructive/10 border-b border-destructive/20 flex items-start gap-3">
      <X className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-destructive/70 mb-0.5">{error.label}</div>
        <p className="text-sm text-destructive whitespace-pre-wrap break-words">{error.message}</p>
      </div>
    </div>
  )

  const contentArea = <div className="flex-1 min-h-0 relative">{children}</div>

  // Embedded mode — renders inline without dialog/portal, for design system playground
  if (embedded) {
    return (
      <div className={`flex flex-col ${bgClass} h-full w-full overflow-hidden rounded-lg border border-foreground/5`}>
        {header}
        {errorBanner}
        {contentArea}
      </div>
    )
  }

  // Fullscreen mode - uses FullscreenOverlayBase for portal, traffic lights, and ESC handling
  if (!isModal) {
    return (
      <FullscreenOverlayBase
        isOpen={isOpen}
        onClose={onClose}
        className={`flex flex-col ${bgClass}`}
      >
        <div className="flex flex-col flex-1 min-h-0">
          {header}
          {errorBanner}
          {contentArea}
        </div>
      </FullscreenOverlayBase>
    )
  }

  // Modal mode - uses its own portal with backdrop click to close
  return ReactDOM.createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center ${OVERLAY_LAYOUT.modalBackdropClass}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className={`flex flex-col ${bgClass} shadow-3xl overflow-hidden smooth-corners`}
        style={{
          width: '90vw',
          maxWidth: OVERLAY_LAYOUT.modalMaxWidth,
          height: `${OVERLAY_LAYOUT.modalMaxHeightPercent}vh`,
          borderRadius: 16,
        }}
      >
        {header}
        {errorBanner}
        {contentArea}
      </div>
    </div>,
    document.body
  )
}

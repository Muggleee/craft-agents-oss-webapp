/**
 * SSE (Server-Sent Events) handler for streaming SessionEvents
 */

import type { SessionEvent } from '../../../electron/src/shared/types'

// Connected SSE clients
const clients = new Set<ReadableStreamController<Uint8Array>>()

/**
 * Handle SSE connection
 */
export function sseHandler(req: Request): Response {
  const encoder = new TextEncoder()
  
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.add(controller)
      
      // Send initial connection event
      const data = JSON.stringify({ type: 'connected', timestamp: Date.now() })
      controller.enqueue(encoder.encode(`data: ${data}\n\n`))
      
      // Handle client disconnect via abort signal
      req.signal.addEventListener('abort', () => {
        clients.delete(controller)
        try {
          controller.close()
        } catch {
          // Already closed
        }
      })
    },
    cancel() {
      // Client disconnected
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

/**
 * Broadcast a SessionEvent to all connected clients
 */
export function broadcastEvent(event: SessionEvent): void {
  const encoder = new TextEncoder()
  const data = JSON.stringify(event)
  const message = encoder.encode(`data: ${data}\n\n`)
  
  for (const controller of clients) {
    try {
      controller.enqueue(message)
    } catch {
      // Client disconnected, remove from set
      clients.delete(controller)
    }
  }
}

/**
 * Get number of connected clients (for debugging)
 */
export function getClientCount(): number {
  return clients.size
}

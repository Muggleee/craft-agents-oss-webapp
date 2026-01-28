/**
 * Webapp backend server for Craft Agents
 * Provides /api/rpc for method calls and /api/events for SSE streaming
 */

import { serve } from 'bun'
import { homedir } from 'os'
import { join } from 'path'
import { rpcHandler } from './api/rpc'
import { sseHandler, broadcastEvent } from './api/sse'

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001

// Initialize default workspace path
const DEFAULT_WORKSPACES_DIR = join(homedir(), '.craft-agent', 'workspaces')

console.log(`Starting Craft Agent webapp server...`)
console.log(`  Default workspaces directory: ${DEFAULT_WORKSPACES_DIR}`)

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    
    // CORS headers for development
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    // Handle preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    // SSE endpoint for streaming events
    if (url.pathname === '/api/events' && req.method === 'GET') {
      return sseHandler(req)
    }

    // RPC endpoint for method calls
    if (url.pathname === '/api/rpc' && req.method === 'POST') {
      try {
        const body = await req.json() as { method: string; args: unknown[] }
        const result = await rpcHandler(body.method, body.args, broadcastEvent)
        return new Response(JSON.stringify({ result }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        return new Response(JSON.stringify({ error: message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // Health check
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // 404 for unknown routes
    return new Response('Not Found', { status: 404, headers: corsHeaders })
  },
})

console.log(`Craft Agent webapp server running at http://localhost:${server.port}`)

// Export for programmatic use
export { server, broadcastEvent }

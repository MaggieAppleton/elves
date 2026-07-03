import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { ChangeSet } from '../src/model/changeset'
import type { PresenceMessage } from '../src/model/presence'

export function attachRealtime(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('error', (err) => console.error('[ws] client error', err))
    ws.on('close', () => clients.delete(ws))
  })

  function send(msg: string) {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  // Tagged with the project id so a client only applies change-sets for the
  // project it currently has open (see connectRealtime on the client).
  function broadcast(projectId: string, changeSet: ChangeSet) {
    send(JSON.stringify({ projectId, changeSet }))
  }

  // Ephemeral presence — where the agent is looking. Same socket, a separate
  // `presence` key so the client routes it to the glow overlay, never the
  // document. Fire-and-forget: if no tab is open, it simply vanishes.
  function broadcastPresence(projectId: string, presence: PresenceMessage) {
    send(JSON.stringify({ projectId, presence }))
  }

  return { broadcast, broadcastPresence, wss }
}

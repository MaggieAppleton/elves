import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { ChangeSet } from '../src/model/changeset'

export function attachRealtime(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('error', (err) => console.error('[ws] client error', err))
    ws.on('close', () => clients.delete(ws))
  })

  // Tagged with the project id so a client only applies change-sets for the
  // project it currently has open (see connectRealtime on the client).
  function broadcast(projectId: string, changeSet: ChangeSet) {
    const msg = JSON.stringify({ projectId, changeSet })
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  return { broadcast, wss }
}

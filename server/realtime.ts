import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'node:http'
import type { ChangeSet } from '../src/model/changeset'

export function attachRealtime(httpServer: Server) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  const clients = new Set<WebSocket>()

  wss.on('connection', (ws) => {
    clients.add(ws)
    ws.on('close', () => clients.delete(ws))
  })

  function broadcast(changeSet: ChangeSet) {
    const msg = JSON.stringify(changeSet)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  return { broadcast, wss }
}

import { ChangeSet } from '../model/changeset'
import { PresenceMessage } from '../model/presence'

const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

// Messages are tagged with the project id; the caller decides whether the
// change-set / presence signal is for the project it currently has open. Two
// message kinds share the socket: `{ changeSet }` (durable document ops) and
// `{ presence }` (ephemeral "the agent is looking here" — never persisted).
export function connectRealtime(
  onChangeSet: (projectId: string, cs: ChangeSet) => void,
  onPresence?: (projectId: string, presence: PresenceMessage) => void,
): () => void {
  const url = BASE.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(url)
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.changeSet) onChangeSet(msg.projectId, msg.changeSet)
      else if (msg.presence) onPresence?.(msg.projectId, msg.presence)
    } catch (err) {
      console.error('Elves: bad realtime message', err)
    }
  }
  ws.onerror = (err) => console.error('Elves: realtime socket error', err)
  return () => ws.close()
}

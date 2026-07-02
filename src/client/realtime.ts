import { ChangeSet } from '../model/changeset'

const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

// Messages are tagged with the project id; the caller decides whether the
// change-set is for the project it currently has open.
export function connectRealtime(
  onMessage: (projectId: string, cs: ChangeSet) => void,
): () => void {
  const url = BASE.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(url)
  ws.onmessage = (e) => {
    try {
      const { projectId, changeSet } = JSON.parse(e.data)
      onMessage(projectId, changeSet)
    } catch (err) {
      console.error('Elves: bad change-set message', err)
    }
  }
  ws.onerror = (err) => console.error('Elves: realtime socket error', err)
  return () => ws.close()
}

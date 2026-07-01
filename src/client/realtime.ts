import { ChangeSet } from '../model/changeset'

const BASE =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export function connectRealtime(onChangeSet: (cs: ChangeSet) => void): () => void {
  const url = BASE.replace(/^http/, 'ws') + '/ws'
  const ws = new WebSocket(url)
  ws.onmessage = (e) => {
    try {
      onChangeSet(JSON.parse(e.data))
    } catch (err) {
      console.error('Elves: bad change-set message', err)
    }
  }
  ws.onerror = (err) => console.error('Elves: realtime socket error', err)
  return () => ws.close()
}

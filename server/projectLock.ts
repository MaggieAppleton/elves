import { resolve } from 'node:path'

const chains = new Map<string, Promise<unknown>>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve()
  const run = tail.then(task, task)
  const settled = run.then(() => undefined, () => undefined)
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })
  return run
}

function projectKey(dataRoot: string, id: string): string {
  return `project:${resolve(dataRoot, 'projects', encodeURIComponent(id))}`
}

function namespaceKey(dataRoot: string): string {
  return `namespace:${resolve(dataRoot, 'projects')}`
}

export function withProjectLock<T>(
  dataRoot: string,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueue(projectKey(dataRoot, id), task)
}

export function withProjectLocks<T>(
  dataRoot: string,
  ids: readonly string[],
  task: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(ids.map((id) => projectKey(dataRoot, id)))].sort()
  const acquire = (index: number): Promise<T> =>
    index === keys.length ? Promise.resolve().then(task) : enqueue(keys[index], () => acquire(index + 1))
  return acquire(0)
}

export function withProjectNamespaceLock<T>(
  dataRoot: string,
  task: () => Promise<T>,
): Promise<T> {
  return enqueue(namespaceKey(dataRoot), task)
}

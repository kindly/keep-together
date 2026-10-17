/**
 * Per-field three-way merge for a live form (ADR 0017).
 *
 * `base` is the server state the form was last reconciled against, `local`
 * is what the user has typed since, `remote` is what the subscription just
 * delivered. A field changed only remotely takes the remote value; changed
 * only locally keeps the local value; changed on both sides to different
 * values is a conflict — the local value is kept and the field is listed so
 * the UI can flag it.
 */

export type Merge<T> = { value: T; conflicts: Array<keyof T & string> }

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function threeWayMerge<T extends Record<string, unknown>>(
  base: T,
  local: T,
  remote: T,
): Merge<T> {
  const value = { ...local }
  const conflicts: Array<keyof T & string> = []
  for (const key of Object.keys({ ...base, ...local, ...remote }) as Array<
    keyof T & string
  >) {
    const localChanged = !same(local[key], base[key])
    const remoteChanged = !same(remote[key], base[key])
    if (!remoteChanged) continue
    if (!localChanged || same(local[key], remote[key])) {
      value[key] = remote[key]
      continue
    }
    conflicts.push(key)
  }
  return { value, conflicts }
}

/**
 * Counters are the echo filter: a server update whose counter for a slice
 * is not newer than the counter we last saved for it is our own write
 * coming back, and must not be merged over in-progress typing.
 */
export function isEcho(
  lastSaved: Record<string, number>,
  incoming: Record<string, number>,
): boolean {
  return Object.keys(incoming).every(
    (slice) => incoming[slice] <= (lastSaved[slice] ?? -1),
  )
}

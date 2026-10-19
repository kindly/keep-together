import { useConvex, useMutation } from 'convex/react'
import { ConvexError } from 'convex/values'
import { useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { api } from '../../convex/_generated/api'
import type { SourceCodeDescription } from '../../convex/sources/code'
import { useTenant } from '../lib/tenant'
import { useHistoryHold } from './contact-history'
import { SourceCodePicker } from './source-code-picker'
import type { ShownCode } from './source-code-picker'

/** A user-facing line for a refused `setAcquisition`. */
function failure(err: unknown): string {
  if (!(err instanceof ConvexError)) return 'Could not save the source code'
  const d = err.data as {
    kind?: string
    message?: string
    problems?: Array<{ message: string }>
  }
  if (d.kind === 'stale')
    return 'Someone else changed the source code just now: check it and pick again'
  if (d.kind === 'invalid' && d.problems?.length)
    return d.problems.map((p) => p.message).join('; ')
  return d.message ?? d.kind ?? 'Could not save the source code'
}

/**
 * The contact's acquisition code (source codes plan, step 5): how they
 * were recruited. Saved on pick or clear through `setAcquisition`, outside
 * the form's autosave: it is one choice, never typed into, and its own
 * named action in history. A code archived since still shows, marked.
 */
export function ContactAcquisition({
  id,
  counter,
  acquisition,
  disabled,
}: {
  id: Id<'contacts'>
  counter: number
  acquisition: SourceCodeDescription | null
  disabled: boolean
}) {
  const tenant = useTenant()
  const convex = useConvex()
  const setAcquisition = useMutation(api.contacts.mutations.setAcquisition)
  const history = useHistoryHold(id)
  // The pick being saved: shown until the contact carries it.
  const [pending, setPending] = useState<{ shown: ShownCode | null } | null>(
    null,
  )
  const [error, setError] = useState<string | null>(null)

  async function save(
    codeId: Id<'sourceCodes'> | null,
    shown: ShownCode | null,
  ) {
    setError(null)
    setPending({ shown })
    // The page reads the new code's description by its id once the root
    // carries it: subscribe now, so it is there when the save lands.
    if (codeId) {
      convex.prewarmQuery({
        query: api.contacts.queries.getAcquisition,
        args: { tenantId: tenant._id, codeId },
      })
    }
    // No history fetch may be subscribed when the save commits (see
    // ContactForm's save).
    history.hold()
    try {
      await setAcquisition({
        tenantId: tenant._id,
        id,
        expected: counter,
        codeId,
      })
    } catch (err) {
      setError(failure(err))
    } finally {
      history.release()
      setPending(null)
    }
  }

  const shown = pending ? pending.shown : acquisition
  return (
    <section>
      <h2 className="mb-3 text-lg font-medium">Source code</h2>
      <p className="mb-2 text-xs text-neutral-500">How they were recruited.</p>
      <SourceCodePicker
        value={shown}
        pending={pending !== null}
        disabled={disabled || pending !== null}
        onPick={(entry) =>
          void save(entry.versionId, {
            code: entry.code,
            isActive: true,
            startDate: entry.startDate,
            endDate: entry.endDate,
          })
        }
        onClear={() => void save(null, null)}
      />
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  )
}

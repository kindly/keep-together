import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { QueryKey } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { Id } from '../../convex/_generated/dataModel'
import { useMembers } from '../lib/data'
import type { Member } from '../lib/data'
import { ownWrite } from '../lib/data/events'
import { RustApiError, get, post, tenantPath } from '../lib/data/rust/client'
import { keys } from '../lib/data/rust/keys'
import type { ArchivedContact } from '../lib/data/rust-types/ArchivedContact'
import type { ContactView as WireContact } from '../lib/data/rust-types/ContactView'
import type { FieldRestoreNote } from '../lib/data/rust-types/FieldRestoreNote'
import type { Moment } from '../lib/data/rust-types/Moment'
import type { MomentPage } from '../lib/data/rust-types/MomentPage'
import type { RestoredContact } from '../lib/data/rust-types/RestoredContact'
import { useCanWrite, useTenant } from '../lib/tenant'

export type { Moment }

/** Revisions per history page ("Load older" asks for the next 10). */
export const PAGE = 10
// One formatter for every moment: `toLocaleString` with options builds a
// new one per call, on every render of the page (each save re-renders it).
const AT = new Intl.DateTimeFormat([], {
  dateStyle: 'short',
  timeStyle: 'short',
})

/**
 * Pages of moments, newest first, as one list: a group cut by a page
 * boundary ends one page and starts the next, so join those two halves.
 */
export function joinMoments(moments: Array<Moment>): Array<Moment> {
  const out: Array<Moment> = []
  for (const m of moments) {
    const last = out.at(-1)
    if (last && last.key === m.key) {
      out[out.length - 1] = {
        ...last,
        slices: [...new Set([...last.slices, ...m.slices])],
        retired: last.retired && m.retired,
      }
    } else {
      out.push(m)
    }
  }
  return out
}

/**
 * An entity's history (`GET …/history?before&limit`, answering
 * `MomentPage`), newest first, a page of PAGE revisions at a time. Every
 * loaded page is fetched again, in order, when `queryKey` is invalidated
 * (the entity's events and this tab's writes do that), so the pages stay
 * contiguous however many revisions land on top. Failures are state, with
 * a retry, never thrown. Shared by the contact's panel and the gift's.
 */
export function useHistoryMoments(queryKey: QueryKey, path: string) {
  const history = useInfiniteQuery({
    queryKey,
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: String(PAGE) })
      if (pageParam !== null) q.set('before', String(pageParam))
      return get<MomentPage>(path, q)
    },
    getNextPageParam: (page) => page.nextBefore,
  })
  const moments = useMemo(
    () =>
      history.data && joinMoments(history.data.pages.flatMap((p) => p.moments)),
    [history.data],
  )
  const olderFailed = history.isFetchNextPageError
  return {
    moments,
    loading: history.isFetchingNextPage,
    loadOlder:
      history.hasNextPage && !history.isFetching && !olderFailed
        ? () => void history.fetchNextPage()
        : undefined,
    error: history.isError && !olderFailed ? history.error : null,
    retry: () => void history.refetch(),
    olderError: olderFailed ? history.error : null,
    retryOlder: () => void history.fetchNextPage(),
  }
}

/** Who made a moment, as history names them. */
export function actorName(
  members: Array<Member> | undefined,
  actor: number | null,
): string {
  if (actor === null) return 'system'
  return (
    members?.find((m) => (m.userId as unknown as number) === actor)?.name ??
    'someone'
  )
}

/**
 * The moments, newest first: when, what (the group's name, or the slices
 * it touched), who and how. `onRestore` offers "Restore to here" on every
 * moment but the newest, except one made only of retired contracts.
 */
export function MomentList({
  moments,
  members,
  onRestore,
}: {
  moments: Array<Moment>
  members: Array<Member> | undefined
  onRestore?: (m: Moment) => void
}) {
  return (
    <ol className="flex flex-col gap-2">
      {moments.map((m, i) => (
        <li
          key={m.key}
          data-revision={m.revisionId}
          data-at={m.at}
          className="rounded border border-neutral-200 bg-white p-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <time className="text-neutral-600">{AT.format(m.at)}</time>
            {i === 0 && (
              <span className="rounded bg-neutral-200 px-1 text-xs">
                current
              </span>
            )}
            {m.restored && (
              <span className="rounded bg-blue-100 px-1 text-xs text-blue-800">
                restored
              </span>
            )}
            {m.retired && (
              <span
                title="Tags have been removed: this stays in history but can’t be restored"
                className="rounded bg-neutral-100 px-1 text-xs text-neutral-600"
              >
                read-only
              </span>
            )}
          </div>
          <div className="text-neutral-700">
            {m.groupName ?? m.slices.join(', ')} · {actorName(members, m.actor)}{' '}
            · {m.source}
          </div>
          {m.groupName && (
            <div className="text-xs text-neutral-500">
              {m.slices.join(', ')}
            </div>
          )}
          {i > 0 && onRestore && !m.retired && (
            <button
              type="button"
              onClick={() => onRestore(m)}
              className="mt-1 text-xs text-neutral-600 underline"
            >
              Restore to here
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}

const SKIP_REASONS: Record<FieldRestoreNote['reason'], string> = {
  retired: 'the field has been retired',
  wrong_kind: 'the field no longer applies to this kind of contact',
  added_after: 'the field was added after this point; its value is kept',
}

/**
 * What a restore's `skippedFields` say, as one line, or null when it left
 * no field value out.
 */
export function skippedFieldsNote(
  skipped: Array<FieldRestoreNote>,
): string | null {
  if (skipped.length === 0) return null
  const parts = skipped.map((s) => `${s.label} (${SKIP_REASONS[s.reason]})`)
  return `Restored, except: ${parts.join('; ')}.`
}

/**
 * The contact's timeline as moments, newest first, a page at a time;
 * "Restore to here" re-executes every slice that differs from its state
 * at that moment (archive excepted), from any page. A moment of retired
 * contracts only (tags) is read-only. Restore and archive answer the
 * contact's view, which lands at once; nothing is optimistic.
 */
export function ContactHistory({
  id,
  archived,
  archiveVersion,
}: {
  id: Id<'contacts'>
  archived: boolean
  archiveVersion: number
}) {
  const { slug } = useTenant()
  const canWrite = useCanWrite()
  const qc = useQueryClient()
  const members = useMembers()
  const { moments, loading, loadOlder, error, retry, olderError, retryOlder } =
    useHistoryMoments(
      keys.history(slug, id),
      tenantPath(slug, 'contacts', id, 'history'),
    )
  // What the last restore left as it was (field values it skipped).
  const [restoreNote, setRestoreNote] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  // The write's answer is the view: it lands at once; the history and the
  // lists refetch. A refused one refetches the view too, so the switch
  // and the form catch up.
  const landed = (view: WireContact) => {
    qc.setQueryData(keys.contact(slug, id), view)
    void qc.invalidateQueries({ queryKey: keys.history(slug, id) })
    void qc.invalidateQueries({ queryKey: keys.list(slug) })
    void qc.invalidateQueries({ queryKey: keys.search(slug) })
  }
  const run = async (write: () => Promise<void>) => {
    setFailed(null)
    try {
      await write()
    } catch (e) {
      setFailed(e instanceof RustApiError ? e.message : 'Could not save')
      void qc.invalidateQueries({ queryKey: keys.contacts(slug) })
    }
  }
  const restoreTo = (m: Moment) =>
    run(async () => {
      setRestoreNote(null)
      const done = await post<RestoredContact>(
        tenantPath(slug, 'contacts', id, 'restore'),
        // Exact: up to the moment's newest revision, whatever shares
        // its millisecond.
        { toRevision: m.revisionId },
      )
      for (const contract of done.restored) {
        const slice = contract.split('.')[1] as keyof WireContact['counters']
        ownWrite(slug, id, contract, done.view.counters[slice])
      }
      landed(done.view)
      setRestoreNote(skippedFieldsNote(done.skippedFields))
    })
  const setArchived = () =>
    run(async () => {
      const done = await post<ArchivedContact>(
        tenantPath(slug, 'contacts', id, 'archive'),
        { expected: archiveVersion, archived: !archived },
      )
      ownWrite(slug, id, 'contacts.archive', done.counter)
      landed(done.view)
    })
  return (
    <aside className="flex flex-col gap-4 text-sm">
      {canWrite && (
        <button
          type="button"
          onClick={() => void setArchived()}
          className="self-start rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
      )}
      <h2 className="text-lg font-medium">History</h2>
      {failed && (
        <p role="alert" className="text-red-700">
          {failed}
        </p>
      )}
      {restoreNote && (
        <p
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800"
        >
          {restoreNote}{' '}
          <button
            type="button"
            onClick={() => setRestoreNote(null)}
            className="underline"
          >
            Dismiss
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          History couldn’t load.{' '}
          <button type="button" onClick={retry} className="underline">
            Retry
          </button>
        </p>
      )}
      {moments === undefined ? (
        !error && <p className="text-neutral-500">Loading…</p>
      ) : (
        <MomentList
          moments={moments}
          members={members}
          onRestore={canWrite ? (m) => void restoreTo(m) : undefined}
        />
      )}
      {loading && <p className="text-neutral-500">Loading…</p>}
      {olderError && (
        <p role="alert" className="text-red-700">
          Older history couldn’t load.{' '}
          <button type="button" onClick={retryOlder} className="underline">
            Retry
          </button>
        </p>
      )}
      {loadOlder && (
        <button
          type="button"
          onClick={loadOlder}
          className="self-start text-xs text-neutral-600 underline"
        >
          Load older
        </button>
      )}
    </aside>
  )
}

/**
 * Pure source-code rules: names, the full code, dates and the picker's
 * order. No Convex imports except types — the portability boundary; the
 * contract and queries in this folder call these.
 */
import type { Problem } from '../lib/contracts'
import { invalid } from '../lib/contracts'
import type { SourceCodePayload } from './validators'

export type Level = 'category' | 'detail' | 'version'

/** The level under `parent` (none: a category); null under a version. */
export function childLevel(parent: Level | null): Level | null {
  if (parent === null) return 'category'
  if (parent === 'category') return 'detail'
  if (parent === 'detail') return 'version'
  return null
}

/** What a new detail's first version is called (plan g2q4). */
export const FIRST_VERSION_NAME = '001'

/**
 * Every new tenant's categories, each deletable while unused (plan g1q5).
 * The plan's "Door-to-door" loses its hyphens: a name can't have one.
 */
export const SEED_CATEGORIES = [
  'Street',
  'Door to door',
  'Online',
  'Event',
  'Direct mail',
  'Telephone',
  'Community',
]

/**
 * The most parts a tenant can hold, all levels, archived ones included.
 * The settings tree and the picker read them all in one pass, so the
 * contract refuses one more.
 */
export const SOURCE_CODE_LIMIT = 2000

/** The longest a part's name can be: it is part of a printed code. */
export const SOURCE_NAME_MAX = 40

/** Sibling names are unique case-insensitively. */
export function normaliseSourceName(name: string): string {
  return name.toLowerCase()
}

/** The full code: the names from the category down, joined by hyphens. */
export function joinCode(names: ReadonlyArray<string>): string {
  return names.join('-')
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Name tidied (trimmed, inner whitespace collapsed), required, no hyphen
 * (the full code's separator); description and dates blank → absent;
 * dates YYYY-MM-DD and in order. Which levels may carry dates is the
 * contract's check: the payload doesn't know its level.
 */
export function prepareSourceCode(p: SourceCodePayload): SourceCodePayload {
  const out = {
    ...p,
    name: p.name.trim().replace(/\s+/g, ' '),
    description: p.description?.trim() || undefined,
    startDate: p.startDate?.trim() || undefined,
    endDate: p.endDate?.trim() || undefined,
  }
  const problems: Array<Problem> = []
  if (!out.name) {
    problems.push({ field: 'name', message: 'A source code needs a name' })
  } else if (out.name.includes('-')) {
    problems.push({
      field: 'name',
      message: 'A name can’t contain a hyphen: it separates the parts',
    })
  } else if (out.name.length > SOURCE_NAME_MAX) {
    problems.push({
      field: 'name',
      message: `At most ${SOURCE_NAME_MAX} characters`,
    })
  }
  for (const field of ['startDate', 'endDate'] as const) {
    const value = out[field]
    if (value && !ISO_DATE.test(value)) {
      problems.push({ field, message: 'Dates are YYYY-MM-DD' })
    }
  }
  if (out.startDate && out.endDate && out.endDate < out.startDate) {
    problems.push({
      field: 'endDate',
      message: 'End date is before start date',
    })
  }
  if (problems.length) throw invalid(problems)
  return out
}

export type DateStatus = 'current' | 'notStarted' | 'ended'

/** Where `today` falls in a code's dates. Dates guide, never block. */
export function dateStatus(
  dates: { startDate?: string; endDate?: string },
  today: string,
): DateStatus {
  if (dates.startDate && today < dates.startDate) return 'notStarted'
  if (dates.endDate && today > dates.endDate) return 'ended'
  return 'current'
}

/**
 * A version's dates for the picker: its own, each bound falling back to
 * its detail's (a detail's dates cover its runs unless a run says
 * otherwise).
 */
export function effectiveDates(
  version: { startDate?: string; endDate?: string },
  detail: { startDate?: string; endDate?: string },
): { startDate?: string; endDate?: string } {
  return {
    startDate: version.startDate ?? detail.startDate,
    endDate: version.endDate ?? detail.endDate,
  }
}

const STATUS_RANK: Record<DateStatus, number> = {
  current: 0,
  notStarted: 1,
  ended: 2,
}

/** In date first, then not started, then ended; by code within each. */
export function pickerOrder(
  a: { status: DateStatus; code: string },
  b: { status: DateStatus; code: string },
): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    a.code.toLowerCase().localeCompare(b.code.toLowerCase())
  )
}

/** Whether a picker search matches: anywhere in the full code, any case. */
export function codeMatches(code: string, search: string): boolean {
  const needle = search.trim().toLowerCase()
  return needle === '' || code.toLowerCase().includes(needle)
}

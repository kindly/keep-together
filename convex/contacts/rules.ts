/**
 * Pure contact rules: normalisation and blocking invariants (ADR 0014,
 * ADR 0015). No Convex imports except types — this is the portability
 * boundary; the contracts in ./contracts.ts call these.
 */
import type { Infer } from 'convex/values'
import type { Problem } from '../lib/contracts'
import { invalid } from '../lib/contracts'
import type { Payloads } from './validators'

export type Kind = 'individual' | 'organization' | 'household'

export function computedNames(p: {
  kind: Kind
  firstName: string
  lastName: string
  name: string
}): { displayName: string; sortName: string } {
  if (p.kind === 'individual') {
    const display = [p.firstName, p.lastName].filter(Boolean).join(' ')
    const sort = `${p.lastName}, ${p.firstName}`.replace(/, $/, '')
    return { displayName: display, sortName: sort }
  }
  return { displayName: p.name, sortName: p.name }
}

const trim = (s: string) => s.trim()

/**
 * The lookup form of an email address: trimmed, whole address lowercased.
 * The typed address is kept as is for display and sending.
 */
export function normaliseEmail(address: string): string {
  return address.trim().toLowerCase()
}

export function prepareDetails(p: Payloads['details']): Payloads['details'] {
  const out = {
    ...p,
    title: trim(p.title),
    firstName: trim(p.firstName),
    lastName: trim(p.lastName),
    nickname: trim(p.nickname),
    name: trim(p.name),
    externalIdentifier: trim(p.externalIdentifier),
    birthDate: p.birthDate || undefined,
    deceasedDate: p.deceasedDate || undefined,
  }
  const problems: Array<Problem> = []
  if (out.kind === 'individual') {
    if (!out.lastName) {
      problems.push({
        field: 'lastName',
        message: 'An individual needs a last name',
      })
    }
    if (out.name) {
      problems.push({
        field: 'name',
        message: 'Name is for organisations and households',
      })
    }
  } else {
    if (!out.name) {
      problems.push({ field: 'name', message: `A ${out.kind} needs a name` })
    }
    for (const field of ['firstName', 'lastName', 'birthDate'] as const) {
      if (out[field]) {
        problems.push({
          field,
          message: `${field} only applies to individuals`,
        })
      }
    }
    if (out.isDeceased) {
      problems.push({
        field: 'isDeceased',
        message: 'Only individuals can be marked deceased',
      })
    }
  }
  if (out.deceasedDate && !out.isDeceased) {
    problems.push({
      field: 'deceasedDate',
      message: 'A date of death needs the deceased flag',
    })
  }
  for (const field of ['birthDate', 'deceasedDate'] as const) {
    const value = out[field]
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      problems.push({ field, message: 'Dates are YYYY-MM-DD' })
    }
  }
  if (problems.length) throw invalid(problems)
  return out
}

type Keyed = { key?: string; isPrimary: boolean }

/** Mint missing keys, require unique keys, exactly one primary (or none if empty). */
function prepareRows<TRow extends Keyed>(
  rows: Array<TRow>,
  field: string,
): Array<TRow> {
  const out = rows.map((r) => ({ ...r, key: r.key || crypto.randomUUID() }))
  const keys = new Set<string>()
  for (const r of out) {
    if (keys.has(r.key))
      throw invalid([{ field, message: 'Duplicate row key' }])
    keys.add(r.key)
  }
  const primaries = out.filter((r) => r.isPrimary)
  if (primaries.length > 1) {
    throw invalid([{ field, message: 'Only one entry can be primary' }])
  }
  if (out.length && primaries.length === 0)
    out[0] = { ...out[0], isPrimary: true }
  return out
}

export function prepareMethods(p: Payloads['methods']): Payloads['methods'] {
  const emails = prepareRows(
    p.emails.map((e) => ({ ...e, address: trim(e.address) })),
    'emails',
  )
  const seen = new Set<string>()
  for (const e of emails) {
    const normalised = normaliseEmail(e.address)
    if (seen.has(normalised)) {
      throw invalid([{ field: 'emails', message: 'Duplicate email address' }])
    }
    seen.add(normalised)
  }
  const phones = prepareRows(
    p.phones.map((e) => ({ ...e, number: trim(e.number) })),
    'phones',
  )
  return { emails, phones }
}

export function prepareAddresses(
  p: Payloads['addresses'],
): Payloads['addresses'] {
  const addresses = prepareRows(
    p.addresses.map((a) => {
      const country = a.country.trim().toUpperCase()
      if (!/^[A-Z]{2}$/.test(country)) {
        throw invalid([
          {
            field: 'addresses',
            message: 'Country must be a 2-letter ISO code',
          },
        ])
      }
      return {
        ...a,
        line1: trim(a.line1),
        line2: trim(a.line2),
        line3: trim(a.line3),
        town: trim(a.town),
        // Normalised but never rejected — a typo is storable and flagged
        // as an advisory warning instead (ADR 0015).
        postcode: a.postcode.trim().toUpperCase(),
        country,
      }
    }),
    'addresses',
  )
  return { addresses }
}

export function prepareRelationship(
  p: Payloads['relationship'],
): Payloads['relationship'] {
  const out = {
    ...p,
    description: trim(p.description),
    startDate: p.startDate || undefined,
    endDate: p.endDate || undefined,
  }
  const problems: Array<Problem> = []
  if (out.contactA === out.contactB) {
    problems.push({
      field: 'contactB',
      message: 'A relationship needs two different contacts',
    })
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

export function prepareRelationshipType(
  p: Payloads['relationshipType'],
): Payloads['relationshipType'] {
  const out = { ...p, labelAB: trim(p.labelAB), labelBA: trim(p.labelBA) }
  if (!out.labelAB || !out.labelBA) {
    throw invalid([{ field: 'labelAB', message: 'Both labels are required' }])
  }
  return out
}

/** 200 notes (the panel's cap) at this length stay well under the read limit. */
export const NOTE_MAX_LENGTH = 20_000

export function prepareNote(p: Payloads['note']): Payloads['note'] {
  const out = { ...p, body: trim(p.body) }
  if (!out.body) {
    throw invalid([{ field: 'body', message: 'A note needs some text' }])
  }
  if (out.body.length > NOTE_MAX_LENGTH) {
    throw invalid([
      {
        field: 'body',
        message: `A note can be at most ${NOTE_MAX_LENGTH} characters`,
      },
    ])
  }
  return out
}

export type { Infer }

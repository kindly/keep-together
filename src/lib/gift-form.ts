/**
 * The record-gift page's state, its checks and the `recordGift` args it
 * becomes (cash gifts plan, step 3). Pure: the page component holds a
 * draft and renders what these functions say.
 */
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import type { api } from '../../convex/_generated/api'
import type { ShownCode } from '../components/source-code-picker'
import { parsePounds } from './gifts'

/** `giving/queries:donor`: what the page knows about a picked contact. */
export type DonorInfo = NonNullable<
  FunctionReturnType<typeof api.giving.queries.donor>
>

export type RecordGiftArgs = Omit<
  FunctionArgs<typeof api.giving.mutations.recordGift>,
  'tenantId'
>

type ContactKind = Doc<'contacts'>['kind']

/** Who gave: a contact picked from the search, or one typed in (g1q3). */
export type DonorChoice =
  | { kind: 'existing'; id: Id<'contacts'>; displayName: string }
  | {
      kind: 'new'
      contactKind: Exclude<ContactKind, 'household'>
      firstName: string
      lastName: string
      name: string
      email: string
    }

/** The code the form holds: the donor's acquisition code, or one picked. */
export type PickedCode = { id: Id<'sourceCodes'>; shown: ShownCode }

/** The declaration methods staff can pick (`onScreenByDonor` needs a donor screen). */
export type TickMethod = Exclude<
  Doc<'giftAidDeclarations'>['method'],
  'onScreenByDonor'
>

export type GiftDraft = {
  donor: DonorChoice | null
  code: PickedCode | null
  amountText: string
  method: Doc<'contributions'>['method']
  reference: string
  receivedOn: string
  giftAid: boolean
  scope: Doc<'giftAidDeclarations'>['scope']
  declarationMethod: TickMethod
  /** The home address typed under the tick (g3q3). */
  line1: string
  postcode: string
}

/**
 * An empty form. After a save the next one keeps the date and method
 * (g1q7); never the code, which comes from the next donor.
 */
export function freshDraft(
  today: string,
  keep?: Pick<GiftDraft, 'receivedOn' | 'method'>,
): GiftDraft {
  return {
    donor: null,
    code: null,
    amountText: '',
    method: keep?.method ?? 'cash',
    reference: '',
    receivedOn: keep?.receivedOn ?? today,
    giftAid: false,
    scope: 'futureAndPast4y',
    declarationMethod: 'staffTickedNoEvidence',
    line1: '',
    postcode: '',
  }
}

/** Whether the draft holds anything the user typed or picked since `fresh`. */
export function isDirty(draft: GiftDraft, fresh: GiftDraft): boolean {
  return (
    draft.donor !== null ||
    draft.code !== null ||
    draft.amountText.trim() !== '' ||
    draft.reference.trim() !== '' ||
    draft.receivedOn !== fresh.receivedOn ||
    draft.method !== fresh.method ||
    draft.giftAid ||
    draft.line1.trim() !== '' ||
    draft.postcode.trim() !== ''
  )
}

/** What was typed in the search, as a new person's names: "Jo van Dyke" → Jo / van Dyke. */
export function splitName(typed: string): {
  firstName: string
  lastName: string
} {
  const words = typed.trim().split(/\s+/).filter(Boolean)
  if (words.length <= 1) return { firstName: words[0] ?? '', lastName: '' }
  return { firstName: words[0], lastName: words.slice(1).join(' ') }
}

/** A new contact from the search text: a person's names, or an organisation's. */
export function newDonor(
  contactKind: Exclude<ContactKind, 'household'>,
  typed: string,
): DonorChoice {
  return contactKind === 'individual'
    ? { kind: 'new', contactKind, ...splitName(typed), name: '', email: '' }
    : {
        kind: 'new',
        contactKind,
        firstName: '',
        lastName: '',
        name: typed.trim(),
        email: '',
      }
}

/** The donor's kind: known for a new one, read for an existing one. */
export function donorKind(
  donor: DonorChoice | null,
  info: DonorInfo | null | undefined,
): ContactKind | undefined {
  if (!donor) return undefined
  return donor.kind === 'new' ? donor.contactKind : info?.kind
}

/**
 * What the Gift Aid section shows: nothing for an organisation or
 * household (HMRC 3.6.7) or before the donor is known; "✓ covered" for a
 * person with an enduring declaration in force (g2q6); else the tick.
 */
export function giftAidOffer(
  donor: DonorChoice | null,
  info: DonorInfo | null | undefined,
): 'none' | 'covered' | 'tick' {
  if (donorKind(donor, info) !== 'individual') return 'none'
  if (donor?.kind === 'existing' && info?.current) return 'covered'
  return 'tick'
}

/** The home address a declaration would snapshot, when it has both parts. */
export function homeOnFile(
  donor: DonorChoice | null,
  info: DonorInfo | null | undefined,
): { line1: string; postcode: string } | null {
  if (donor?.kind !== 'existing' || !info) return null
  const { line1, postcode } = info.home
  return line1.trim() && postcode.trim() ? { line1, postcode } : null
}

/**
 * Whether the tick shows line 1 and postcode fields: a new person, or an
 * existing one with no complete home address. One with a complete address
 * declares under it, and the page shows it instead of empty fields, so a
 * half-typed address never replaces a whole one (cash-2 review, L1).
 */
export function asksForAddress(
  draft: GiftDraft,
  info: DonorInfo | null | undefined,
): boolean {
  return (
    draft.giftAid &&
    giftAidOffer(draft.donor, info) === 'tick' &&
    homeOnFile(draft.donor, info) === null
  )
}

/**
 * A complete address on file, partly: its fields prefill the tick's
 * fields (an address with line 1 and no postcode gets its postcode typed).
 */
export function partialHome(info: DonorInfo | null | undefined): {
  line1: string
  postcode: string
} {
  return info ? { ...info.home } : { line1: '', postcode: '' }
}

export type Problem = { field: string; message: string }

/**
 * The page's own blocking checks, before anything is sent: who gave, a
 * code, an amount over £0 written as money, a date, a new contact's
 * names, and a half-typed home address (line 1 without postcode, or the
 * reverse: block, so it is completed or cleared). A blank address under
 * the tick saves, with a warning (g3q3). The contract checks the rest.
 */
export function draftProblems(
  draft: GiftDraft,
  info: DonorInfo | null | undefined,
): Array<Problem> {
  const problems: Array<Problem> = []
  const { donor } = draft
  if (!donor) {
    problems.push({ field: 'contact', message: 'Find the donor, or add them' })
  } else if (donor.kind === 'new') {
    if (donor.contactKind === 'individual') {
      if (!donor.firstName.trim())
        problems.push({ field: 'firstName', message: 'A first name is needed' })
      if (!donor.lastName.trim())
        problems.push({ field: 'lastName', message: 'A last name is needed' })
    } else if (!donor.name.trim()) {
      problems.push({ field: 'name', message: 'A name is needed' })
    }
  }
  if (!draft.code) {
    problems.push({ field: 'sourceCode', message: 'Pick a source code' })
  }
  const pence = parsePounds(draft.amountText)
  if (pence === null) {
    problems.push({
      field: 'amount',
      message: draft.amountText.trim()
        ? 'Write the amount in pounds, like 20 or 12.50'
        : 'Enter the amount',
    })
  } else if (pence <= 0n) {
    problems.push({ field: 'amount', message: 'The amount must be over £0' })
  }
  if (!draft.receivedOn) {
    problems.push({ field: 'receivedOn', message: 'Enter the date' })
  }
  if (asksForAddress(draft, info)) {
    const line1 = draft.line1.trim()
    const postcode = draft.postcode.trim()
    if (line1 && !postcode)
      problems.push({
        field: 'postcode',
        message: 'Add the postcode, or clear line 1',
      })
    if (postcode && !line1)
      problems.push({
        field: 'line1',
        message: 'Add the house number or name, or clear the postcode',
      })
  }
  return problems
}

/**
 * The tick with no address: storable, but not claimable until one is
 * added (g3q3).
 */
export function noAddressWarning(
  draft: GiftDraft,
  info: DonorInfo | null | undefined,
): string | null {
  if (!asksForAddress(draft, info)) return null
  if (draft.line1.trim() || draft.postcode.trim()) return null
  return 'No home address: the declaration is saved, but Gift Aid can’t be claimed until one is added'
}

/** The pence a valid draft gives (`draftProblems` is empty). */
export function amountOf(draft: GiftDraft): bigint {
  const pence = parsePounds(draft.amountText)
  if (pence === null) throw new Error('amount checked by draftProblems')
  return pence
}

/**
 * The one save's args for a draft `draftProblems` passed. One allocation
 * for the whole amount (no split entry, chat 1). The address goes only
 * when the tick asked for it and something was typed; a declaration's
 * date is the backend's (today, UK time).
 */
export function toArgs(
  draft: GiftDraft,
  info: DonorInfo | null | undefined,
  clientKey: string,
): RecordGiftArgs {
  const { donor, code } = draft
  if (!donor || !code) throw new Error('checked by draftProblems')
  const amount = amountOf(draft)
  const contact: RecordGiftArgs['contact'] =
    donor.kind === 'existing'
      ? donor.id
      : {
          kind: donor.contactKind,
          firstName: donor.contactKind === 'individual' ? donor.firstName : '',
          lastName: donor.contactKind === 'individual' ? donor.lastName : '',
          name: donor.contactKind === 'individual' ? '' : donor.name,
          ...(donor.contactKind === 'individual' && donor.email.trim()
            ? { email: donor.email.trim() }
            : {}),
        }
  const ticked = draft.giftAid && giftAidOffer(donor, info) === 'tick'
  const typed =
    ticked &&
    asksForAddress(draft, info) &&
    (draft.line1.trim() !== '' || draft.postcode.trim() !== '')
  const reference = draft.reference.trim()
  return {
    clientKey,
    contact,
    ...(typed && {
      home: { line1: draft.line1.trim(), postcode: draft.postcode.trim() },
    }),
    receivedOn: draft.receivedOn,
    amount,
    method: draft.method,
    ...(draft.method === 'card' && reference ? { reference } : {}),
    allocations: [{ sourceCodeId: code.id, amount }],
    ...(ticked && {
      giftAid: { scope: draft.scope, method: draft.declarationMethod },
    }),
  }
}

/** A new contact's or a picked contact's name, for the "Saved" line. */
export function donorName(donor: DonorChoice): string {
  if (donor.kind === 'existing') return donor.displayName
  return donor.contactKind === 'individual'
    ? `${donor.firstName.trim()} ${donor.lastName.trim()}`
    : donor.name.trim()
}

/** The code the donor's own gives a gift: theirs unless archived (g2q1). */
export function defaultCode(info: DonorInfo): PickedCode | null {
  const a = info.acquisition
  if (!a || !a.isActive) return null
  return {
    id: a.versionId,
    shown: {
      code: a.code,
      isActive: true,
      startDate: a.startDate,
      endDate: a.endDate,
    },
  }
}

/**
 * "Differs from Jo's source, Street-Wesser-001" (g2q2): the picked code is
 * not the donor's acquisition code.
 */
export function differsNote(
  draft: GiftDraft,
  info: DonorInfo | null | undefined,
): string | null {
  if (draft.donor?.kind !== 'existing' || !info?.acquisition || !draft.code)
    return null
  if (draft.code.id === info.acquisition.versionId) return null
  const who =
    info.kind === 'individual' && info.firstName
      ? `${info.firstName}’s`
      : `${info.displayName}’s`
  return `Differs from ${who} source, ${info.acquisition.code}`
}

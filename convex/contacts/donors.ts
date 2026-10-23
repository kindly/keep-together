/**
 * What giving may know about a contact, and the contact writes it composes
 * into its one-save `recordGift` (cash gifts plan, step 2). Other modules
 * use these functions, never the contact tables. Each write runs the
 * contacts contracts in the caller's transaction and group: a refusal
 * throws, rolling back the caller's whole mutation.
 */
import type { Doc, Id } from '../_generated/dataModel'
import { executeContract, rejected } from '../lib/contracts'
import type { CommandGroup, ContractCtx } from '../lib/contracts'
import type { ScopedDatabaseReader } from '../lib/tenancy'
import { acquisition, addresses, details, methods } from './contracts'
import type { Payloads } from './validators'

/** A contact as a gift and its Gift Aid declaration need it. */
export type Donor = {
  id: Id<'contacts'>
  kind: Doc<'contacts'>['kind']
  displayName: string
  firstName: string
  lastName: string
  acquisitionCodeId: Id<'sourceCodes'> | null
  /**
   * The primary (else first) address's line 1 and postcode, or empty
   * strings; `completable` when typing a postcode for it completes that
   * row in place (`setHomeAddress`) rather than adding a new one.
   */
  home: { line1: string; postcode: string; completable: boolean }
}

/** The donor, or null for a missing or another tenant's id. Two reads. */
export async function describeDonor(
  db: ScopedDatabaseReader,
  id: Id<'contacts'>,
): Promise<Donor | null> {
  const [contact, rows] = await Promise.all([db.get(id), addressRows(db, id)])
  if (!contact) return null
  const home = rows.find((a) => a.isPrimary) ?? rows.at(0)
  return {
    id,
    kind: contact.kind,
    displayName: contact.displayName,
    firstName: contact.firstName,
    lastName: contact.lastName,
    acquisitionCodeId: contact.acquisitionCodeId ?? null,
    home: {
      line1: home?.line1 ?? '',
      postcode: home?.postcode ?? '',
      completable: home !== undefined && completesInPlace(home),
    },
  }
}

/** A UK home address with no postcode: `setHomeAddress` completes it in place. */
function completesInPlace(a: Doc<'contactAddresses'>): boolean {
  return (
    a.label === 'home' &&
    a.country.trim().toUpperCase() === 'GB' &&
    !a.postcode.trim()
  )
}

function addressRows(db: ScopedDatabaseReader, contactId: Id<'contacts'>) {
  return db
    .query('contactAddresses')
    .withIndex('by_tenant_contact', (q) => q.eq('contactId', contactId))
    .collect()
}

/**
 * A new contact (`contacts.details`, which takes its contact number), with
 * its acquisition code when given, as `contacts/mutations:create` does.
 */
export async function createContact(
  ctx: ContractCtx,
  payload: Payloads['details'],
  opts: { acquisitionCodeId?: Id<'sourceCodes'>; group?: CommandGroup } = {},
): Promise<Id<'contacts'>> {
  const { id } = await executeContract(ctx, details, payload, {
    source: 'ui',
    group: opts.group,
  })
  if (opts.acquisitionCodeId) {
    await executeContract(
      ctx,
      acquisition,
      { codeId: opts.acquisitionCodeId },
      { entityId: id, expected: 0, source: 'ui', group: opts.group },
    )
  }
  return id
}

/** A just-created contact's one email address (its primary). */
export async function addFirstEmail(
  ctx: ContractCtx,
  contactId: Id<'contacts'>,
  address: string,
  group: CommandGroup,
): Promise<void> {
  await executeContract(
    ctx,
    methods,
    {
      emails: [{ label: 'home', address, isPrimary: true }],
      phones: [],
    },
    { entityId: contactId, expected: 0, source: 'ui', group },
  )
}

/**
 * Give the contact a UK home address (line 1 and postcode, what Gift Aid
 * needs), keeping the addresses it has. The row a declaration would
 * snapshot (primary, else first: `describeDonor`'s home) is completed in
 * place, by key, when it is a UK home address with no postcode: it keeps
 * its other fields and stays where it was (addresses are editable in
 * place, ADR 0014). Anything else (an overseas, work or other row, or a
 * home row that has a postcode) is left as it is, and the address is
 * added as the new primary, since claims use the current address (g2q7).
 * Built from the rows read in this transaction, so it needs no
 * `expected`. Returns line 1 and postcode as stored (tidied).
 */
export async function setHomeAddress(
  ctx: ContractCtx,
  contactId: Id<'contacts'>,
  home: { line1: string; postcode: string },
  group: CommandGroup,
): Promise<{ line1: string; postcode: string }> {
  const [contact, rows] = await Promise.all([
    ctx.db.get(contactId),
    addressRows(ctx.db, contactId),
  ])
  if (!contact) throw rejected('unknown_contact', 'Contact must exist')
  const current = rows.find((a) => a.isPrimary) ?? rows.at(0)
  const partial = current && completesInPlace(current) ? current : null
  const kept = rows.map((a) => ({
    key: a.key,
    label: a.label,
    line1: a.key === partial?.key ? home.line1 : a.line1,
    line2: a.line2,
    line3: a.line3,
    town: a.town,
    postcode: a.key === partial?.key ? home.postcode : a.postcode,
    country: a.country,
    // An added address becomes the primary.
    isPrimary: partial ? a.isPrimary : false,
  }))
  const key = partial?.key ?? crypto.randomUUID()
  const added = partial
    ? []
    : [
        {
          key,
          label: 'home' as const,
          line1: home.line1,
          line2: '',
          line3: '',
          town: '',
          postcode: home.postcode,
          country: 'GB',
          isPrimary: true,
        },
      ]
  await executeContract(
    ctx,
    addresses,
    { addresses: [...kept, ...added] },
    {
      entityId: contactId,
      expected: contact.addressesVersion,
      source: 'ui',
      group,
    },
  )
  const stored = await ctx.db
    .query('contactAddresses')
    .withIndex('by_tenant_key', (q) => q.eq('key', key))
    .unique()
  return { line1: stored!.line1, postcode: stored!.postcode }
}

/**
 * Give the contact `codeId` as its acquisition code if it has none (ADR
 * 0022: giving fills an empty acquisition code from the first gift). One
 * it already has stays, archived or not. Returns whether it was filled.
 */
export async function fillAcquisition(
  ctx: ContractCtx,
  contactId: Id<'contacts'>,
  codeId: Id<'sourceCodes'>,
  group: CommandGroup,
): Promise<boolean> {
  const contact = await ctx.db.get(contactId)
  if (!contact) throw rejected('unknown_contact', 'Contact must exist')
  if (contact.acquisitionCodeId !== undefined) return false
  await executeContract(
    ctx,
    acquisition,
    { codeId },
    {
      entityId: contactId,
      expected: contact.acquisitionVersion,
      source: 'ui',
      group,
    },
  )
  return true
}

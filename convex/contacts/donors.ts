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
  /** The primary address's line 1 and postcode, or empty strings. */
  home: { line1: string; postcode: string }
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
    home: { line1: home?.line1 ?? '', postcode: home?.postcode ?? '' },
  }
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
 * Add a UK home address (line 1 and postcode, what Gift Aid needs) to the
 * contact's addresses, keeping the ones it has. It becomes the primary
 * only if there is none. Built from the rows read in this transaction, so
 * it needs no `expected`. Returns line 1 and postcode as stored (tidied).
 */
export async function addHomeAddress(
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
  const kept = rows.map((a) => ({
    key: a.key,
    label: a.label,
    line1: a.line1,
    line2: a.line2,
    line3: a.line3,
    town: a.town,
    postcode: a.postcode,
    country: a.country,
    isPrimary: a.isPrimary,
  }))
  const added = {
    label: 'home' as const,
    line1: home.line1,
    line2: '',
    line3: '',
    town: '',
    postcode: home.postcode,
    country: 'GB',
    isPrimary: !kept.some((a) => a.isPrimary),
  }
  const key = crypto.randomUUID()
  await executeContract(
    ctx,
    addresses,
    { addresses: [...kept, { key, ...added }] },
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

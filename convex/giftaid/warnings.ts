/**
 * Advisory validation (ADR 0015) for a saved declaration: storable but not
 * yet enough for HMRC. Never blocks a save; a later claim step decides
 * which declarations count. Shared by backend and UI.
 */
import { HMRC_MODEL_WORDING_VERSION } from './validators'
import type { DeclarationPayload } from './validators'

export type Warning = {
  /** The declaration field the warning is about; empty = the whole declaration. */
  anchor: string
  label: string
  message: string
}

export function declarationWarnings(
  d: Pick<
    DeclarationPayload,
    | 'method'
    | 'wordingVersion'
    | 'firstName'
    | 'lastName'
    | 'addressLine1'
    | 'postcode'
  >,
): Array<Warning> {
  const warnings: Array<Warning> = []
  // 3.6.2: the donor's name (full name recommended).
  if (!d.firstName || !d.lastName) {
    warnings.push({
      anchor: d.firstName ? 'lastName' : 'firstName',
      label: 'Name',
      message: 'HMRC needs the donor’s first and last name',
    })
  }
  // 3.6.2: a UK home address is enough as house number or name + postcode.
  if (!d.addressLine1 || !d.postcode) {
    warnings.push({
      anchor: d.addressLine1 ? 'postcode' : 'addressLine1',
      label: 'Home address',
      message:
        'No house number or name and postcode: gifts can’t be claimed until the declaration has both',
    })
  }
  // 3.10.1: an oral declaration takes effect once the donor is sent a
  // written record of it; typing it into a database isn't enough.
  if (d.method === 'oral') {
    warnings.push({
      anchor: 'method',
      label: 'Made orally',
      message:
        'Not effective until the donor has been sent a written record of it',
    })
  }
  // Staff ticked with no form in hand: honest, but nothing yet shows the
  // donor made it. A claim leaves these out until evidence is recorded.
  if (d.method === 'staffTickedNoEvidence') {
    warnings.push({
      anchor: 'method',
      label: 'No evidence yet',
      message:
        'Gifts won’t be claimed until there is evidence the donor made this declaration',
    })
  }
  // 3.6.2: the donor must have been given HMRC's tax explanation; an older
  // wording may still be valid but is worth a look.
  if (d.wordingVersion !== HMRC_MODEL_WORDING_VERSION) {
    warnings.push({
      anchor: 'wordingVersion',
      label: 'Wording',
      message: 'Not HMRC’s current model declaration wording',
    })
  }
  return warnings
}

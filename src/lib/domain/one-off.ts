// What staff may take once through GoCardless (a one-off charge on a
// mandate, an Instant Bank Pay link): the twin of
// `giving::rules::ONE_OFF_MAX` and the check in the api's
// `check_one_off`. At most £1,000, for everyone, admins included: more
// is a bank transfer. Pence are bigint (rule 7).

/** £1,000 in pence. */
export const ONE_OFF_MAX = 100_000n

export const ONE_OFF_MAX_MESSAGE =
  'At most £1,000 can be taken this way: for more, ask the donor for a bank transfer'

/** What's wrong with a one-off amount, as the server would say it. */
export function oneOffAmountProblem(amount: bigint): string | null {
  if (amount <= 0n) return 'The amount must be over £0'
  if (amount > ONE_OFF_MAX) return ONE_OFF_MAX_MESSAGE
  return null
}

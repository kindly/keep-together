/**
 * Matching statement lines on the Rust API (bank transfers step 4's
 * `/api/t/{slug}/bank/lines…`, `bank/accept`, `bank/rules`, and 6b's
 * payer reads), through TanStack Query. Staff and admins only: viewers
 * never see statement lines (g1q9).
 *
 * **Never optimistic**: an unmatched line counts for nothing, and every
 * match, split, unmatch and accept shows only the line the server read
 * back after committing (`BankLineDetail`), or its refusal. Every read
 * here sits under the `bank` prefix, so a line's, rule's or forget's
 * event refetches them all. Pence cross the wire as JSON integers and
 * become `bigint` here (rule 7).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { ApiError } from '../rust-types/ApiError'
import type { BankAccepted } from '../rust-types/BankAccepted'
import type { BankConfidence } from '../rust-types/BankConfidence'
import type { BankHandTransfer } from '../rust-types/BankHandTransfer'
import type { BankLine as WireLine } from '../rust-types/BankLine'
import type { BankLineDetail } from '../rust-types/BankLineDetail'
import type { BankLineGift } from '../rust-types/BankLineGift'
import type { BankLineRow } from '../rust-types/BankLineRow'
import type { BankMatchState } from '../rust-types/BankMatchState'
import type { BankPayerView } from '../rust-types/BankPayerView'
import type { BankProposal } from '../rust-types/BankProposal'
import type { BankRule } from '../rust-types/BankRule'
import type { BankRuleField } from '../rust-types/BankRuleField'
import type { BankSuggestion } from '../rust-types/BankSuggestion'
import type { DonorRef } from '../rust-types/DonorRef'
import type { Executed } from '../rust-types/Executed'
import { get, post, tenantPath } from './client'
import { keys } from './keys'

export type {
  BankConfidence,
  BankMatchState,
  BankPayerView,
  BankProposal,
  BankRule,
  BankRuleField,
  BankSuggestion,
  DonorRef,
}

export type StatementLine = Omit<WireLine, 'amount'> & { amount: bigint }
export type LineWithSuggestions = StatementLine & {
  suggestions: Array<BankSuggestion>
}
export type LineGift = Omit<BankLineGift, 'amount'> & { amount: bigint }
export type LineDetail = {
  line: StatementLine
  gifts: Array<LineGift>
  batchId: string | null
  suggestions: Array<BankSuggestion>
}
export type HandTransfer = Omit<BankHandTransfer, 'amount'> & {
  amount: bigint
}

/** One line's outcome of "Accept ticked", as the server answered it. */
export type AcceptOutcome =
  | { lineId: string; ok: true; line: LineDetail }
  | { lineId: string; ok: false; status: number; error: ApiError | null }

/** One gift of a line: who, how much, and (optionally) its code. */
export type SplitPart = {
  contact: DonorRef
  amount: bigint
  sourceCodeId?: string
}

/** The rest of a line that isn't a donation, with why. */
export type Remainder = { amount: bigint; note: string }

const lineFromWire = (l: WireLine): StatementLine => ({
  ...l,
  amount: BigInt(l.amount),
})

export const detailFromWire = (d: BankLineDetail): LineDetail => ({
  line: lineFromWire(d.line),
  gifts: d.gifts.map((g) => ({ ...g, amount: BigInt(g.amount) })),
  batchId: d.batchId,
  suggestions: d.suggestions,
})

/** Pence to the wire, refusing what JSON can't carry exactly. */
function toWire(amount: bigint): number {
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) throw new RangeError('amount out of range')
  return n
}

const remainderToWire = (r?: Remainder) =>
  r && r.amount > 0n
    ? { remainder: { amount: toWire(r.amount), note: r.note } }
    : {}

// ── reads ──────────────────────────────────────────────────────────────────

/** An account's lines in a state (oldest first), each with suggestions. */
export function useLines(
  accountId: string | null,
  state: BankMatchState = 'unmatched',
) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankLines(slug, accountId ?? '', state),
    enabled: accountId !== null,
    queryFn: async (): Promise<Array<LineWithSuggestions>> => {
      const rows = await get<Array<BankLineRow>>(
        tenantPath(slug, 'bank', 'accounts', accountId ?? '', 'lines'),
        new URLSearchParams({ state }),
      )
      return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }))
    },
  })
}

/**
 * An account's unmatched lines without suggestions (oldest first): what a
 * picker chooses from.
 */
export function useLineChoices(accountId: string | null) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankLines(slug, accountId ?? '', 'choices'),
    enabled: accountId !== null,
    queryFn: async (): Promise<Array<StatementLine>> => {
      const rows = await get<Array<WireLine>>(
        tenantPath(slug, 'bank', 'accounts', accountId ?? '', 'line-choices'),
      )
      return rows.map(lineFromWire)
    },
  })
}

/** One line, what it is matched to, and its suggestions. */
export function useLine(id: string | null) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankLine(slug, id ?? ''),
    enabled: id !== null,
    retry: false,
    queryFn: async () =>
      detailFromWire(
        await get<BankLineDetail>(tenantPath(slug, 'bank', 'lines', id ?? '')),
      ),
  })
}

/** Transfers entered by hand near a line's date, not on a statement yet. */
export function useHandTransfers(lineId: string, days = 14) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankHandTransfers(slug, lineId, days),
    queryFn: async (): Promise<Array<HandTransfer>> => {
      const rows = await get<Array<BankHandTransfer>>(
        tenantPath(slug, 'bank', 'lines', lineId, 'hand-transfers'),
        new URLSearchParams({ days: String(days) }),
      )
      return rows.map((g) => ({ ...g, amount: BigInt(g.amount) }))
    },
  })
}

/** The active not-a-donation rules (every account's and each one's). */
export function useRules(enabled = true) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankRules(slug),
    enabled,
    queryFn: () => get<Array<BankRule>>(tenantPath(slug, 'bank', 'rules')),
  })
}

/** A contact's remembered payers (staff and admins). */
export function usePayers(contactId: string, enabled = true) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankPayers(slug, contactId),
    enabled,
    queryFn: () =>
      get<Array<BankPayerView>>(
        tenantPath(slug, 'contacts', contactId, 'bank-payers'),
      ),
  })
}

// ── writes ─────────────────────────────────────────────────────────────────

/**
 * Every way to match a line, each resolving with the line as the server
 * read it back once committed (never what was sent). A line matched
 * meanwhile is `409 stale`, nothing kept. Each refetches every bank read,
 * the gifts and the batches (a match makes or links gifts, clears
 * cheques).
 */
export function useMatchWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  async function after<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } finally {
      void qc.invalidateQueries({ queryKey: keys.bank(slug) })
      void qc.invalidateQueries({ queryKey: keys.gifts(slug) })
      void qc.invalidateQueries({ queryKey: keys.batches(slug) })
    }
  }
  const line = (id: string, what: string, body: unknown) =>
    after(async () =>
      detailFromWire(
        await post<BankLineDetail>(
          tenantPath(slug, 'bank', 'lines', id, what),
          body,
        ),
      ),
    )
  return {
    gifts: (
      id: string,
      expected: number,
      parts: Array<SplitPart>,
      remainder?: Remainder,
    ) =>
      line(id, 'gifts', {
        expected,
        parts: parts.map((p) => ({
          contact: p.contact,
          amount: toWire(p.amount),
          ...(p.sourceCodeId ? { sourceCodeId: p.sourceCodeId } : {}),
        })),
        ...remainderToWire(remainder),
      }),
    matchGifts: (
      id: string,
      expected: number,
      giftIds: Array<string>,
      remainder?: Remainder,
    ) =>
      line(id, 'match-gifts', {
        expected,
        giftIds,
        ...remainderToWire(remainder),
      }),
    matchBatch: (
      id: string,
      expected: number,
      batchId: string,
      batchLineVersion: number,
    ) => line(id, 'match-batch', { expected, batchId, batchLineVersion }),
    notDonation: (id: string, expected: number, note: string) =>
      line(id, 'not-donation', { expected, note }),
    unmatch: (id: string, expected: number) =>
      line(id, 'unmatch', { expected }),
    /** "Accept ticked": one transaction per line, outcomes in order. */
    accept: (
      items: Array<{
        lineId: string
        expected: number
        proposal: BankProposal
      }>,
    ) =>
      after(async () => {
        const out = await post<Array<BankAccepted>>(
          tenantPath(slug, 'bank', 'accept'),
          {
            items,
          },
        )
        return out.map((a): AcceptOutcome =>
          a.status === 200 && a.line
            ? { lineId: a.lineId, ok: true, line: detailFromWire(a.line) }
            : {
                lineId: a.lineId,
                ok: false,
                status: a.status,
                error: a.error ?? null,
              },
        )
      }),
  }
}

/** Create and delete not-a-donation rules. */
export function useRuleWrites() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  async function after<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f()
    } finally {
      await qc.invalidateQueries({ queryKey: keys.bank(slug) })
    }
  }
  return {
    create: (rule: {
      accountId: string | null
      field: BankRuleField
      contains: string
      note: string | null
    }) =>
      after(() =>
        post<Executed>(tenantPath(slug, 'bank', 'rules'), {
          ...rule,
          active: true,
        }),
      ),
    remove: (id: string, expected: number) =>
      after(() =>
        post<Executed>(tenantPath(slug, 'bank', 'rules', id, 'delete'), {
          expected,
        }),
      ),
  }
}

/** Forget every payer remembered for a contact; answers what is left. */
export function useForgetPayers(contactId: string) {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async () => {
    try {
      return await post<Array<BankPayerView>>(
        tenantPath(slug, 'contacts', contactId, 'bank-payers', 'forget'),
      )
    } finally {
      await qc.invalidateQueries({ queryKey: keys.bank(slug) })
    }
  }
}

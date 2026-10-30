/**
 * Bank accounts and statement imports on the Rust API
 * (`/api/t/{slug}/bank/…`, plan bank-transfers.sv step 6a), through
 * TanStack Query. Viewers never see statement lines (g1q9): the pages ask
 * only for staff and admins. Setting an account up is admin only.
 *
 * **Never optimistic** (statement lines become financial records): an
 * import shows only what the server answered once it committed. A
 * statement file goes as the request's whole body; which account and how
 * to read it ride in the query. Pence cross the wire as JSON integers and
 * become `bigint` here (rule 7).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTenant } from '../../tenant'
import type { BankAccountPayload } from '../rust-types/BankAccountPayload'
import type { BankAccountRow } from '../rust-types/BankAccountRow'
import type { BankColumnMapping } from '../rust-types/BankColumnMapping'
import type { BankCsvLayout } from '../rust-types/BankCsvLayout'
import type { BankFileLayout } from '../rust-types/BankFileLayout'
import type { BankImportDetail } from '../rust-types/BankImportDetail'
import type { BankImportLine } from '../rust-types/BankImportLine'
import type { BankImportPreview } from '../rust-types/BankImportPreview'
import type { BankImportRow } from '../rust-types/BankImportRow'
import type { BankImported } from '../rust-types/BankImported'
import type { BankPeekRow } from '../rust-types/BankPeekRow'
import type { BankPreset } from '../rust-types/BankPreset'
import type { BankPresets } from '../rust-types/BankPresets'
import type { BankRowError } from '../rust-types/BankRowError'
import type { BankUndatedRow } from '../rust-types/BankUndatedRow'
import type { Executed } from '../rust-types/Executed'
import { get, post, postFile, tenantPath } from './client'
import { keys } from './keys'

// ── shapes ─────────────────────────────────────────────────────────────────

export type {
  BankAccountPayload,
  BankAccountRow,
  BankColumnMapping,
  BankCsvLayout,
  BankFileLayout,
  BankImportRow,
  BankPeekRow,
  BankPreset,
  BankPresets,
  BankRowError,
}

export type BankLine = Omit<BankImportLine, 'amount'> & { amount: bigint }
export type BankUndated = Omit<BankUndatedRow, 'amount'> & { amount: bigint }

/** What an import would add (a preview) or added (once committed). */
export type BankImportOutcome = {
  newLines: number
  duplicateLines: number
  debitsDropped: number
  firstDate?: string
  lastDate?: string
  /** Rows with money in but no date: skipped, for staff to check. */
  undated: Array<BankUndated>
  undatedCount: number
}

export type BankPreviewOutcome = BankImportOutcome & {
  lines: Array<BankLine>
}

export type BankImportedOutcome = BankImportOutcome & { id: string }

export type BankImportView = Omit<BankImportDetail, 'lines'> & {
  lines: Array<BankLine>
}

// ── wire → page ────────────────────────────────────────────────────────────

const lineFromWire = (l: BankImportLine): BankLine => ({
  ...l,
  amount: BigInt(l.amount),
})

const undatedFromWire = (u: BankUndatedRow): BankUndated => ({
  ...u,
  amount: BigInt(u.amount),
})

function outcomeFromWire<T extends BankImported | BankImportPreview>(o: T) {
  return { ...o, undated: o.undated.map(undatedFromWire) }
}

/** How a file's name says to read it: OFX, QIF, else CSV. */
export function kindOfFile(name: string): 'ofx' | 'qif' | 'csv' {
  const lower = name.toLowerCase()
  if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) return 'ofx'
  if (lower.endsWith('.qif')) return 'qif'
  return 'csv'
}

// ── reads ──────────────────────────────────────────────────────────────────

/** The CSV presets, each with its `verified` flag. */
export function useBankPresets(enabled = true) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankPresets(slug),
    enabled,
    staleTime: Infinity,
    queryFn: () => get<BankPresets>(tenantPath(slug, 'bank', 'presets')),
  })
}

/** Every bank account, in the order they were added. */
export function useBankAccounts(enabled = true) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankAccounts(slug),
    enabled,
    queryFn: () =>
      get<Array<BankAccountRow>>(tenantPath(slug, 'bank', 'accounts')),
  })
}

/** An account's imports, newest first. */
export function useBankImports(accountId: string | null) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankImports(slug, accountId ?? ''),
    enabled: accountId !== null,
    queryFn: () =>
      get<Array<BankImportRow>>(
        tenantPath(slug, 'bank', 'accounts', accountId ?? '', 'imports'),
      ),
  })
}

/** One import and its lines. */
export function useBankImport(id: string) {
  const { slug } = useTenant()
  return useQuery({
    queryKey: keys.bankImport(slug, id),
    retry: false,
    queryFn: async (): Promise<BankImportView> => {
      const d = await get<BankImportDetail>(
        tenantPath(slug, 'bank', 'imports', id),
      )
      return { ...d, lines: d.lines.map(lineFromWire) }
    },
  })
}

// ── writes ─────────────────────────────────────────────────────────────────

/** A new account (admins); resolves with it as the server read it back. */
export function useCreateBankAccount() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (account: BankAccountPayload) => {
    try {
      return await post<BankAccountRow>(
        tenantPath(slug, 'bank', 'accounts'),
        account,
      )
    } finally {
      await qc.invalidateQueries({ queryKey: keys.bankAccounts(slug) })
    }
  }
}

/** Save an account (admins) against its `version`: `409 stale`. */
export function useSaveBankAccount() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (id: string, expected: number, account: BankAccountPayload) => {
    try {
      return await post<Executed>(
        tenantPath(slug, 'bank', 'accounts', id, 'save'),
        { ...account, expected },
      )
    } finally {
      await qc.invalidateQueries({ queryKey: keys.bankAccounts(slug) })
    }
  }
}

function importQuery(
  accountId: string,
  file: File,
  layout: BankFileLayout | null,
  saveLayout = false,
) {
  const q = new URLSearchParams({ accountId, fileName: file.name })
  if (layout) q.set('layout', JSON.stringify(layout))
  if (saveLayout) q.set('saveLayout', 'true')
  return q
}

/** A CSV's first rows as text, for mapping its columns. */
export function usePeekStatement() {
  const { slug } = useTenant()
  return (file: File) =>
    postFile<Array<BankPeekRow>>(
      tenantPath(slug, 'bank', 'peek'),
      new URLSearchParams(),
      file,
    )
}

/**
 * What importing `file` would add, written nowhere. `layout` null: the
 * account's saved layout.
 */
export function usePreviewImport() {
  const { slug } = useTenant()
  return async (
    accountId: string,
    file: File,
    layout: BankFileLayout | null,
  ): Promise<BankPreviewOutcome> => {
    const p = await postFile<BankImportPreview>(
      tenantPath(slug, 'bank', 'imports', 'preview'),
      importQuery(accountId, file, layout),
      file,
    )
    return { ...outcomeFromWire(p), lines: p.lines.map(lineFromWire) }
  }
}

/**
 * Import `file` into an account; with `saveLayout`, its CSV layout is kept
 * on the account in the same transaction. Resolves once committed.
 */
export function useImportStatement() {
  const { slug } = useTenant()
  const qc = useQueryClient()
  return async (
    accountId: string,
    file: File,
    layout: BankFileLayout | null,
    saveLayout: boolean,
  ): Promise<BankImportedOutcome> => {
    try {
      const done = await postFile<BankImported>(
        tenantPath(slug, 'bank', 'imports'),
        importQuery(accountId, file, layout, saveLayout),
        file,
      )
      return outcomeFromWire(done)
    } finally {
      await qc.invalidateQueries({ queryKey: keys.bank(slug) })
    }
  }
}

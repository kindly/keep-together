/**
 * Contracts: the single write path for domain state (ADR 0013 / 0017).
 *
 * A contract owns a disjoint slice of an aggregate root and one integer
 * counter field on it. `executeContract` runs, inside the calling mutation's
 * transaction:
 *
 *   prepare (normalise + invariant checks)
 *     → re-read the root (fresh, in-transaction)
 *     → check `expected` against the slice's counter (stale ⇒ throw, no trace)
 *     → run the pure apply function
 *     → bump the counter
 *     → append a revision (normalised payload + contract name + version)
 *     → run the contract's projection hook, if any (derived rows such as
 *       `contactSearch`, rebuilt from the root's new state)
 *
 * Restore re-executes a stored payload as a NEW command, chaining upcasters
 * by declared version. Nothing is ever rewound.
 */
import { ConvexError, v } from 'convex/values'
import type { ObjectType, PropertyValidators } from 'convex/values'
import { validate } from 'convex-helpers/validators'
import type { Doc, Id, TableNames } from '../_generated/dataModel'
import { requireListManager } from './lists'
import type { Role, ScopedDatabaseWriter, ScopedScheduler } from './tenancy'

export type Source = Doc<'revisions'>['source']

export type ContractCtx = {
  db: ScopedDatabaseWriter
  userId: Id<'users'> | null
  /**
   * The caller's role, which role-gated contracts check (`managesList`:
   * `requireListManager`). `null` means a trusted internal caller and
   * skips those checks: only internal mutations with no user behind them
   * pass it (`internalTenant*`, seeds, migrations, scheduled jobs).
   *
   * A public function must never reach a role-gated contract with
   * `role: null`, e.g. by calling or scheduling an internal mutation that
   * runs one: carry the caller's role through instead.
   */
  role: Role | null
  /** Present in tenant mutations; a projection that fans out needs it. */
  scheduler?: ScopedScheduler
}

/**
 * What `executeContract` tells an apply about the command it is part of.
 * `at` is fixed once per command, so apply stays pure: restore re-runs it
 * with the restore's own time.
 */
export type Command = {
  at: number
  actor: Id<'users'> | null
  /** Where the command came from; restore re-applies history. */
  source: Source
  /** Create-only arguments that are not part of the slice (e.g. a parent id). */
  createWith?: unknown
}

export type Problem = { field: string; message: string }

/** Blocking validation failure: unstorable or invariant-breaking data. */
export function invalid(problems: Array<Problem>): ConvexError<{
  kind: 'invalid'
  problems: Array<Problem>
}> {
  return new ConvexError({ kind: 'invalid' as const, problems })
}

/** A handler refused the command (kind change, immutable child, ownership). */
export function rejected(
  reason: string,
  message: string,
): ConvexError<{ kind: 'rejected'; reason: string; message: string }> {
  return new ConvexError({ kind: 'rejected' as const, reason, message })
}

export type Contract<
  TFields extends PropertyValidators,
  TRoot extends TableNames,
> = {
  /** Stable dotted name, e.g. "contacts.details". */
  name: string
  entity: TRoot
  /** Bump whenever the payload shape or semantics change; register an upcaster. */
  version: number
  /**
   * The root is one of the tenant's lists (tags, identifier types): every
   * execution, restore included, needs a caller who may manage lists
   * (lib/lists). Internal callers (role null) are trusted.
   */
  managesList?: boolean
  /** Integer counter field on the root owned by this contract. */
  counter: keyof Doc<TRoot> & string
  /** Full state of the slice. Reused as mutation args. */
  fields: TFields
  /**
   * Pure normalisation + blocking checks. Returns the payload that is
   * applied AND stored in the revision (so minted keys, upper-cased
   * postcodes etc. are what history replays). Throws `invalid(...)`.
   */
  // Method signatures (not function properties): parameters stay bivariant,
  // so a registry of differently-typed contracts is expressible.
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  prepare?(payload: ObjectType<TFields>): ObjectType<TFields>
  /**
   * Pure state application: no side effects, nothing time-dependent beyond
   * `command.at` — restore re-runs it. `root` is null on create. Returns
   * the root id.
   */
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  apply(
    ctx: ContractCtx,
    payload: ObjectType<TFields>,
    root: Doc<TRoot> | null,
    command: Command,
  ): Promise<Id<TRoot>>
  /**
   * Rebuild derived data from the root's state after the command, in the
   * same transaction (so it is never stale). Derived rows are not domain
   * state: no contract, no revisions; this hook (and its backfill) are
   * their only writers. `before` is the root as the command found it.
   */
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  project?(
    ctx: ContractCtx,
    id: Id<TRoot>,
    before: Doc<TRoot> | null,
  ): Promise<void>
  /** fromVersion → function taking a payload at that version to the next. */
  upcasters?: Record<number, (payload: unknown) => unknown>
}

export function defineContract<
  TFields extends PropertyValidators,
  TRoot extends TableNames,
>(spec: Contract<TFields, TRoot>): Contract<TFields, TRoot> {
  return spec
}

export type AnyContract = Contract<any, any>
export type Registry = Record<string, AnyContract>

export function registry(...contracts: Array<AnyContract>): Registry {
  const out: Registry = {}
  for (const c of contracts) {
    if (c.name in out) throw new Error(`duplicate contract ${c.name}`)
    out[c.name] = c
  }
  return out
}

export type ExecuteOptions<TRoot extends TableNames> = {
  entityId?: Id<TRoot>
  /** Counter value the caller last saw. Always passed by forms. */
  expected?: number
  source: Source
  group?: CommandGroup
  restoredFrom?: Id<'revisions'>
  /** Passed to apply on create only; never stored in the revision. */
  createWith?: unknown
}

export type ExecuteResult<TRoot extends TableNames> = {
  id: Id<TRoot>
  counter: number
}

export async function executeContract<
  TFields extends PropertyValidators,
  TRoot extends TableNames,
>(
  ctx: ContractCtx,
  contract: Contract<TFields, TRoot>,
  input: ObjectType<TFields>,
  opts: ExecuteOptions<TRoot>,
): Promise<ExecuteResult<TRoot>> {
  if (contract.managesList && ctx.role !== null) {
    await requireListManager({ db: ctx.db, role: ctx.role })
  }
  // Shape check matters for restore (stored payloads re-enter here); for
  // live calls the mutation's args validator has already run.
  validate(v.object(contract.fields), input, { throw: true })
  const payload = contract.prepare ? contract.prepare(input) : input

  let root: Doc<TRoot> | null = null
  let counter = 0
  if (opts.entityId !== undefined) {
    // Fresh read inside the transaction: a handler must never work from a
    // document the client sent (it may predate another command).
    root = await ctx.db.get<TRoot>(opts.entityId)
    if (!root) throw new ConvexError({ kind: 'not_found' as const })
    const current = (root as Record<string, unknown>)[contract.counter]
    if (typeof current !== 'number') {
      throw new Error(`${contract.name}: counter ${contract.counter} missing`)
    }
    if (opts.expected !== undefined && opts.expected !== current) {
      throw new ConvexError({
        kind: 'stale' as const,
        contract: contract.name,
        current,
      })
    }
    counter = current + 1
  }

  const id = await contract.apply(ctx, payload, root, {
    at: Date.now(),
    actor: ctx.userId,
    source: opts.source,
    createWith: root === null ? opts.createWith : undefined,
  })
  // Not every apply touches the root row; the counter bump is ours.
  await ctx.db.patch(contract.entity, id, {
    [contract.counter]: counter,
  } as never)

  await ctx.db.insert('revisions', {
    entity: contract.entity,
    entityId: id,
    contract: contract.name,
    version: contract.version,
    counter,
    payload,
    actor: ctx.userId ?? undefined,
    source: opts.source,
    group: opts.group?.id,
    // A group's name never changes; stamped so `history` never reads groups.
    groupName: opts.group?.name,
    restoredFrom: opts.restoredFrom,
  })
  if (contract.project) await contract.project(ctx, id, root)
  return { id, counter }
}

/**
 * A command group as `executeContract` takes it: the id, and the name each
 * revision carries so history needs no second read.
 */
export type CommandGroup = { id: Id<'commandGroups'>; name: string }

/** An *action*: several contracts under one named group in one mutation. */
export async function commandGroup(
  ctx: ContractCtx,
  name: string,
): Promise<CommandGroup> {
  const id = await ctx.db.insert('commandGroups', {
    name,
    actor: ctx.userId ?? undefined,
  })
  return { id, name }
}

// ── restore ────────────────────────────────────────────────────────────────

/** Steps with no registered upcaster between `from` and the code version. */
export function missingUpcasterSteps(
  contract: AnyContract,
  from: number,
): Array<number> {
  const missing: Array<number> = []
  for (let version = from; version < contract.version; version++) {
    if (!contract.upcasters?.[version]) missing.push(version)
  }
  return missing
}

/** Bring a stored payload forward by chaining upcasters. */
export function upcast(
  contract: AnyContract,
  payload: unknown,
  from: number,
): unknown {
  let current = payload
  for (let version = from; version < contract.version; version++) {
    const step = contract.upcasters?.[version]
    if (!step) {
      throw new ConvexError({
        kind: 'missing_upcaster' as const,
        contract: contract.name,
        from: version,
      })
    }
    current = step(current)
  }
  return current
}

/**
 * Re-execute a stored revision as a new command. The revision's declared
 * version decides migration — never the payload's shape.
 */
export async function restore(
  ctx: ContractCtx,
  reg: Registry,
  revisionId: Id<'revisions'>,
  opts: { group?: CommandGroup } = {},
) {
  const revision = await ctx.db.get(revisionId)
  if (!revision) throw new ConvexError({ kind: 'not_found' as const })
  if (!Object.hasOwn(reg, revision.contract)) {
    throw new ConvexError({
      kind: 'unknown_contract' as const,
      contract: revision.contract,
    })
  }
  const contract = reg[revision.contract]
  if (revision.version > contract.version) {
    throw new ConvexError({
      kind: 'newer_than_code' as const,
      contract: contract.name,
      stored: revision.version,
      code: contract.version,
    })
  }
  const payload = upcast(contract, revision.payload, revision.version)
  return executeContract(ctx, contract, payload as never, {
    entityId: revision.entityId as never,
    source: 'restore',
    restoredFrom: revision._id,
    group: opts.group,
  })
}

/**
 * Order-independent view of a payload for change detection: child-row
 * lists sorted by `key`, object keys sorted, `undefined` dropped.
 */
export function canonical(payload: unknown): string {
  return JSON.stringify(sortDeep(payload))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(sortDeep)
    if (
      items.length > 0 &&
      items.every(
        (i): i is { key: unknown } =>
          typeof i === 'object' && i !== null && 'key' in i,
      )
    ) {
      return [...items].sort((a, b) =>
        String(a.key).localeCompare(String(b.key)),
      )
    }
    return items
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[k]
      if (item !== undefined) out[k] = sortDeep(item)
    }
    return out
  }
  return value
}

/**
 * Restore a whole aggregate to its state at time `at` (ms since epoch).
 * Contracts are full-state, so no replay: re-execute the latest revision of
 * each contract at or before `at`, skipping slices already in that state
 * and any `exclude`d contracts, in one named command group.
 *
 * Reads are bounded by the number of contracts, not the length of history:
 * a descending skip-scan of `by_tenant_entity_contract` yields each
 * contract's latest revision in one read, and one more finds its latest
 * at or before `at` when that differs.
 */
export async function restoreEntityTo(
  ctx: ContractCtx,
  reg: Registry,
  entity: TableNames,
  entityId: string,
  at: number,
  opts: { exclude?: Array<string>; label?: string } = {},
): Promise<{ restored: Array<string>; group: Id<'commandGroups'> | null }> {
  const exclude = new Set(opts.exclude ?? [])
  const target = new Map<string, Doc<'revisions'>>()
  const current = new Map<string, Doc<'revisions'>>()
  let below: string | undefined
  for (;;) {
    const bound = below
    const latest = await ctx.db
      .query('revisions')
      .withIndex('by_tenant_entity_contract', (q) => {
        const r = q.eq('entity', entity).eq('entityId', entityId)
        return bound === undefined ? r : r.lt('contract', bound)
      })
      .order('desc')
      .first()
    if (!latest) break
    below = latest.contract
    if (exclude.has(latest.contract)) continue
    current.set(latest.contract, latest)
    const atOrBefore =
      latest._creationTime <= at
        ? latest
        : await ctx.db
            .query('revisions')
            .withIndex('by_tenant_entity_contract', (q) =>
              q
                .eq('entity', entity)
                .eq('entityId', entityId)
                .eq('contract', latest.contract)
                .lte('_creationTime', at),
            )
            .order('desc')
            .first()
    if (atOrBefore) target.set(latest.contract, atOrBefore)
  }
  // Compared at the code's version: a v1 and a v2 payload of the same
  // state are the same state.
  const state = (r: Doc<'revisions'>) =>
    Object.hasOwn(reg, r.contract) && r.version <= reg[r.contract].version
      ? canonical(upcast(reg[r.contract], r.payload, r.version))
      : canonical(r.payload)
  const toRestore = [...target.values()].filter(
    (r) => state(r) !== state(current.get(r.contract)!),
  )
  if (toRestore.length === 0) return { restored: [], group: null }

  const group = await commandGroup(
    ctx,
    opts.label ?? `restore to ${new Date(at).toISOString()}`,
  )
  const restored: Array<string> = []
  for (const r of toRestore.sort((a, b) => a._creationTime - b._creationTime)) {
    await restore(ctx, reg, r._id, { group })
    restored.push(r.contract)
  }
  return { restored, group: group.id }
}

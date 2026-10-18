/**
 * Roles (ADR 0020, auth-roles R3): the scoped constructors enforce `minRole`.
 *
 * The meta-test walks every registered public mutation and action, so a new
 * one that a viewer can call fails here without anyone remembering to add a
 * test for it.
 */
import { makeFunctionReference } from 'convex/server'
import { convexTest } from 'convex-test'
import type { TestConvex } from 'convex-test'
import { describe, expect, test } from 'vitest'
import { api } from '../_generated/api'
import type { Id, TableNames } from '../_generated/dataModel'
import schema from '../schema'
import { errorData, modules, setup } from '../../test/fixture'
import type { Tenant } from '../../test/fixture'
import { tenantAction, tenantMutation, tenantQuery } from './tenancy'
import type { Role } from './tenancy'

type T = TestConvex<typeof schema>

/** A user holding `role` in `tenantId`, as a caller. */
async function member(t: T, tenantId: Id<'tenants'>, role: Role) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('users', { email: `${role}@example.com` })
    await ctx.db.insert('memberships', { tenantId, userId: id, role })
    return id
  })
  return t.withIdentity({ subject: `${userId}|session-${role}` })
}

async function callers(t: T, a: Tenant) {
  return {
    admin: a.as,
    staff: await member(t, a.tenantId, 'staff'),
    viewer: await member(t, a.tenantId, 'viewer'),
  }
}

const person = (lastName: string) => ({
  kind: 'individual' as const,
  title: '',
  firstName: '',
  lastName,
  nickname: '',
  name: '',
  isDeceased: false,
  externalIdentifier: '',
})

// ── every public mutation / action rejects a viewer ────────────────────────

/** Functions registered without a tenant (Convex Auth's sign-in flow). */
const NOT_TENANT_SCOPED = new Set(['auth:signIn', 'auth:signOut'])

/** Modules that register no functions and only load in the Convex runtime. */
const CONFIG_MODULES = new Set(['convex.config', 'auth.config', 'schema'])

type Registered = {
  isPublic?: boolean
  isMutation?: boolean
  isAction?: boolean
  exportArgs: () => string
}

/** Every public mutation and action under convex/, as `module:export`. */
async function publicWrites() {
  const out: Array<{ path: string; kind: 'mutation' | 'action'; args: any }> =
    []
  for (const [file, load] of Object.entries(modules)) {
    if (file.includes('/_generated/') || file.endsWith('.test.ts')) continue
    const module = path(file)
    if (CONFIG_MODULES.has(module)) continue
    const exports = (await load()) as Record<string, unknown>
    for (const [name, fn] of Object.entries(exports)) {
      if (typeof fn !== 'function') continue
      const f = fn as unknown as Registered
      if (!f.isPublic) continue
      if (!f.isMutation && !f.isAction) continue
      out.push({
        path: `${module}:${name}`,
        kind: f.isMutation ? 'mutation' : 'action',
        args: JSON.parse(f.exportArgs()),
      })
    }
  }
  return out
}

/** `../convex/contacts/mutations.ts` → `contacts/mutations`. */
function path(file: string) {
  return file.replace(/^\.\.\/convex\//, '').replace(/\.ts$/, '')
}

/**
 * Valid arguments for a validator (exportArgs JSON), so the call passes
 * argument validation and reaches the role check. Ids are real rows of the
 * caller's tenant; optional fields are left out.
 */
function synth(
  validator: any,
  ids: (table: string) => string,
  field?: string,
): unknown {
  switch (validator.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(validator.value)
          .filter(([, f]: [string, any]) => !f.optional)
          .map(([k, f]: [string, any]) => [k, synth(f.fieldType, ids, k)]),
      )
    case 'id':
      return ids(validator.tableName)
    case 'string':
      return field ?? ''
    case 'number':
      return 0
    case 'bigint':
      return 0n
    case 'boolean':
      return false
    case 'null':
      return null
    case 'literal':
      return validator.value
    case 'union':
      return synth(validator.value[0], ids, field)
    case 'array':
    case 'record':
      return validator.type === 'array' ? [] : {}
    case 'bytes':
      return new ArrayBuffer(0)
    case 'any':
      return {}
    default:
      throw new Error(`synth: unhandled validator ${validator.type}`)
  }
}

describe('every public mutation and action', () => {
  test('rejects a viewer with forbidden, and the role is the reason', async () => {
    const { t, a, b } = await setup()
    const { staff, viewer } = await callers(t, a)

    // One row in every table a public function takes an id of.
    const c1 = await a.as.mutation(api.contacts.mutations.create, {
      tenantId: a.tenantId,
      ...person('Ames'),
    })
    const c2 = await a.as.mutation(api.contacts.mutations.create, {
      tenantId: a.tenantId,
      ...person('Byrne'),
    })
    await a.as.mutation(api.contacts.notes.create, {
      tenantId: a.tenantId,
      contactId: c1,
      body: 'hello',
    })
    const types = await a.as.query(api.contacts.relationships.types, {
      tenantId: a.tenantId,
    })
    await a.as.mutation(api.contacts.relationships.save, {
      tenantId: a.tenantId,
      contactA: c1,
      contactB: c2,
      typeId: types.find((ty) => ty.labelAB === 'Parent of')!._id,
      isActive: true,
      startDate: '',
      endDate: '',
      description: '',
    })
    // Another tenant's rows must never be picked: ids come from tenant A.
    await b.as.mutation(api.contacts.mutations.create, {
      tenantId: b.tenantId,
      ...person('Other'),
    })
    const idsByTable = await t.run(async (ctx) => {
      const out: Record<string, string> = { tenants: a.tenantId }
      for (const table of [
        'contacts',
        'contactNotes',
        'relationships',
        'relationshipTypes',
        'tags',
        'revisions',
      ] as const satisfies ReadonlyArray<TableNames>) {
        const row = (await ctx.db.query(table).collect()).find(
          (r) => r.tenantId === a.tenantId,
        )
        if (row) out[table] = row._id
      }
      return out
    })
    const ids = (table: string) => {
      const id = idsByTable[table]
      if (!id) {
        throw new Error(
          `roles meta-test: add a tenant-A row of '${table}' to the fixture`,
        )
      }
      return id
    }

    const writes = await publicWrites()
    // Guard against the enumeration silently finding nothing.
    expect(writes.map((w) => w.path)).toContain('contacts/mutations:create')
    expect(writes.map((w) => w.path)).toContain('contacts/notes:save')

    const checked: Array<string> = []
    for (const w of writes) {
      if (NOT_TENANT_SCOPED.has(w.path)) continue
      expect(
        w.args.value?.tenantId,
        `${w.path} must be declared with a scoped constructor (no tenantId arg)`,
      ).toBeDefined()
      const args = synth(w.args, ids) as Record<string, unknown>
      const call = (as: typeof viewer) =>
        w.kind === 'mutation'
          ? as.mutation(makeFunctionReference<'mutation'>(w.path), args)
          : as.action(makeFunctionReference<'action'>(w.path), args)

      const asViewer = await errorData(call(viewer)).catch((e: Error) => {
        throw new Error(`${w.path}: a viewer's call ${e.message}`)
      })
      expect(asViewer, w.path).toEqual({ kind: 'forbidden' })
      // The same arguments from staff get past the role check (they may
      // still fail validation further in, but not as forbidden).
      const asStaff = await call(staff).then(
        () => null,
        (e: unknown) => (e as { data?: { kind?: string } }).data?.kind ?? null,
      )
      expect(asStaff, w.path).not.toBe('forbidden')
      checked.push(w.path)
    }
    expect(checked.length).toBeGreaterThanOrEqual(15)
  })
})

// ── representative queries and mutations, two tenants ──────────────────────

describe('roles on contacts', () => {
  test('viewer reads; staff and admin write; nothing carries to tenant B', async () => {
    const { t, a, b } = await setup()
    const roles = await callers(t, a)
    const contactId = await a.as.mutation(api.contacts.mutations.create, {
      tenantId: a.tenantId,
      ...person('Ames'),
    })
    const bContact = await b.as.mutation(api.contacts.mutations.create, {
      tenantId: b.tenantId,
      ...person('Other'),
    })

    for (const role of ['admin', 'staff', 'viewer'] as const) {
      const as = roles[role]
      const list = await as
        .query(api.contacts.queries.list, {
          tenantId: a.tenantId,
        })
        .then((r) => r.rows)
      expect(
        list.map((c) => c._id),
        role,
      ).toContain(contactId)
      expect(
        (
          await as.query(api.contacts.queries.get, {
            tenantId: a.tenantId,
            id: contactId,
          })
        )?.contact._id,
        role,
      ).toBe(contactId)
      expect(
        await errorData(
          as
            .query(api.contacts.queries.list, { tenantId: b.tenantId })
            .then((r) => r.rows),
        ),
        role,
      ).toEqual({ kind: 'forbidden' })
      expect(
        await errorData(
          as.mutation(api.contacts.mutations.create, {
            tenantId: b.tenantId,
            ...person(`From ${role}`),
          }),
        ),
        role,
      ).toEqual({ kind: 'forbidden' })
    }

    for (const role of ['admin', 'staff'] as const) {
      const id = await roles[role].mutation(api.contacts.mutations.create, {
        tenantId: a.tenantId,
        ...person(`By ${role}`),
      })
      expect(id).toBeTruthy()
      await roles[role].mutation(api.contacts.notes.create, {
        tenantId: a.tenantId,
        contactId,
        body: `note by ${role}`,
      })
    }
    expect(
      await errorData(
        roles.viewer.mutation(api.contacts.notes.create, {
          tenantId: a.tenantId,
          contactId,
          body: 'nope',
        }),
      ),
    ).toEqual({ kind: 'forbidden' })
    const notes = await roles.viewer.query(api.contacts.notes.forContact, {
      tenantId: a.tenantId,
      id: contactId,
    })
    expect(notes.notes.map((n) => n.body).sort()).toEqual([
      'note by admin',
      'note by staff',
    ])
    // B still has only its own contact.
    const bList = await b.as
      .query(api.contacts.queries.list, {
        tenantId: b.tenantId,
      })
      .then((r) => r.rows)
    expect(bList.map((c) => c._id)).toEqual([bContact])
  })
})

// ── the minRole option itself ──────────────────────────────────────────────

// Probe functions registered only in this test, through the real
// constructors: one per default and one admin-only of each kind.
const probes = {
  read: tenantQuery({ args: {}, handler: async (ctx) => ctx.role }),
  adminRead: tenantQuery({
    minRole: 'admin',
    args: {},
    handler: async (ctx) => ctx.role,
  }),
  write: tenantMutation({ args: {}, handler: async (ctx) => ctx.role }),
  adminWrite: tenantMutation({
    minRole: 'admin',
    args: {},
    handler: async (ctx) => ctx.role,
  }),
  act: tenantAction({ args: {}, handler: async (ctx) => ctx.role }),
  adminAct: tenantAction({
    minRole: 'admin',
    args: {},
    handler: async (ctx) => ctx.role,
  }),
}
const probeModules = {
  ...modules,
  '../convex/roleProbe.ts': () => Promise.resolve(probes),
}

const PROBE_KIND = {
  read: 'query',
  adminRead: 'query',
  write: 'mutation',
  adminWrite: 'mutation',
  act: 'action',
  adminAct: 'action',
} as const satisfies Record<keyof typeof probes, string>

describe('minRole', () => {
  test('defaults viewer/staff/staff; admin-only rejects staff; per tenant', async () => {
    const t = convexTest(schema, probeModules)
    const tenant = (slug: string) =>
      t.run((ctx) =>
        ctx.db.insert('tenants', { slug, name: slug, status: 'active' }),
      )
    const aId = await tenant('alpha')
    const bId = await tenant('beta')
    const roles = {
      admin: await member(t, aId, 'admin'),
      staff: await member(t, aId, 'staff'),
      viewer: await member(t, aId, 'viewer'),
    }
    const run = (
      as: (typeof roles)['admin'],
      n: keyof typeof probes,
      tenantId: Id<'tenants'>,
    ): Promise<unknown> => {
      const name = `roleProbe:${n}`
      switch (PROBE_KIND[n]) {
        case 'query':
          return as.query(makeFunctionReference<'query'>(name), { tenantId })
        case 'mutation':
          return as.mutation(makeFunctionReference<'mutation'>(name), {
            tenantId,
          })
        case 'action':
          return as.action(makeFunctionReference<'action'>(name), { tenantId })
      }
    }
    const allowed: Record<Role, Array<keyof typeof probes>> = {
      admin: ['read', 'adminRead', 'write', 'adminWrite', 'act', 'adminAct'],
      staff: ['read', 'write', 'act'],
      viewer: ['read'],
    }
    for (const role of ['admin', 'staff', 'viewer'] as const) {
      for (const n of Object.keys(probes) as Array<keyof typeof probes>) {
        const label = `${role} ${n}`
        if (allowed[role].includes(n)) {
          expect(await run(roles[role], n, aId), label).toBe(role)
        } else {
          expect(await errorData(run(roles[role], n, aId)), label).toEqual({
            kind: 'forbidden',
          })
        }
        // A role in A grants nothing in B.
        expect(
          await errorData(run(roles[role], n, bId)),
          `${label} in B`,
        ).toEqual({ kind: 'forbidden' })
      }
    }
  })
})

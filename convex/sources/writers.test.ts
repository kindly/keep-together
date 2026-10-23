/// <reference types="vite/client" />
import { expect, test } from 'vitest'

// Tables with a single home module, which every write to them must be in:
//   - `sourceCodes` in sources/code.ts: it memoises the parts a call reads
//     (`readPart`) and drops the memo before every write it makes, which is
//     only sound while every write is there. A writer anywhere else fails
//     here, not as a stale read in production.
//   - `contactNumberSequences` in contacts/number.ts: the counter behind
//     contact numbers (higher = newer, never reused), taken only there.
//
// Read through Vite, not node:fs: Convex typechecks everything under
// convex/ without Node's types when it deploys.

const HOMES = {
  sourceCodes: 'sources/code.ts',
  contactNumberSequences: 'contacts/number.ts',
}

/** Every non-test, non-generated .ts file under convex/, by path from it. */
const FILES = Object.entries(
  import.meta.glob<string>(
    ['/convex/**/*.ts', '!/convex/**/*.test.ts', '!/convex/_generated/**'],
    {
      query: '?raw',
      import: 'default',
      eager: true,
    },
  ),
).map(([file, text]) => ({ file: file.replace(/^\/convex\//, ''), text }))

/**
 * Every database write in `text`, as its first argument: a quoted table
 * name (`'sourceCodes'`) or the expression in its place (`table`, `id`).
 * Matched over the whole text, so a call prettier wraps across lines
 * (`ctx.db\n  .patch(\n    'sourceCodes', …`) is found too.
 */
function writes(text: string): Array<string> {
  const call = /\bdb\s*\.\s*(?:insert|patch|replace|delete)\s*\(\s*([^,)]*)/g
  return [...text.matchAll(call)].map((m) => m[1].trim())
}

/** `file: first argument` for every write in the module tree. */
const ALL = FILES.flatMap(({ file, text }) =>
  writes(text).map((arg) => ({ file, arg })),
)

test('the matcher finds wrapped calls and the table-less form', () => {
  expect(
    writes(`await ctx.db.patch(
      'sourceCodes',
      id,
      { used: true },
    )
    await ctx.db
      .insert('sourceCodes', {})
    ctx.db.delete(id)
    db.replace(\n  table, id, doc)
    ctx.db.get('sourceCodes', id)`),
  ).toEqual(["'sourceCodes'", "'sourceCodes'", 'id', 'table'])
})

test.each(Object.entries(HOMES))(
  'every write to %s is in %s',
  (table, home) => {
    expect(FILES.length).toBeGreaterThan(20) // the glob found the module tree
    const found = ALL.filter((w) => w.arg === `'${table}'`)
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((w) => w.file !== home)).toEqual([])
  },
)

/**
 * Writes whose table is a variable, so the check above can't see which
 * table they hit: each checked by hand, by file and first argument. A new
 * one fails here until it is.
 */
const DYNAMIC_WRITES = {
  // reconcile(): `table` is a ChildTable, a contact child table.
  'contacts/contracts.ts': ['table'],
  // executeContract's counter bump: on `sources.code` it writes
  // `saveVersion`, which no memoised reader uses (code.ts, `readPart`).
  // No contract's entity is `contactNumberSequences`.
  'lib/contracts.ts': ['contract.entity'],
} as Partial<Record<string, Array<string>>>

test('every write with a variable table is one checked by hand', () => {
  // `db.patch(id, …)` (no table) or `db.patch(table, …)` would write
  // sourceCodes unseen by the check above.
  expect(
    ALL.filter(
      (w) => !w.arg.startsWith("'") && !DYNAMIC_WRITES[w.file]?.includes(w.arg),
    ),
  ).toEqual([])
})

/**
 * The text of the call whose `(` is at `open`, up to its matching `)`.
 * Brackets inside strings would miscount; none of the calls checked has one.
 */
function callText(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1)
  }
  throw new Error('unbalanced call')
}

/** Every write to `contacts` in the module tree, as file and call text. */
const CONTACT_WRITES = FILES.flatMap(({ file, text }) =>
  [
    ...text.matchAll(
      /\bdb\s*\.\s*(insert|patch|replace|delete)\s*(\()\s*'contacts'/g,
    ),
  ].map((m) => ({
    file,
    method: m[1],
    call: callText(text, m.index + m[0].lastIndexOf('(')),
  })),
)

// `contacts.number` is set once, by the details contract's create branch,
// and never changed (not by saves, restores, merge or anonymise). A write
// to `contacts` can only change it by naming it, or by passing an object
// whose keys aren't visible here, so each of those is checked by hand:
//   - details.apply's update patch: `fields`, the details fields by name;
//   - fieldValues.apply: `slotValues(...)`, field slot keys only.
// A new write to `contacts` fails here until it is added and checked.
const CONTACT_WRITERS = {
  'contacts/contracts.ts': 5,
} as Partial<Record<string, number>>

test('contacts.number is written only by the create insert', () => {
  const byFile: Record<string, number> = {}
  for (const w of CONTACT_WRITES) byFile[w.file] = (byFile[w.file] ?? 0) + 1
  expect(byFile).toEqual(CONTACT_WRITERS)
  // A replace would drop the number (or set one); a delete breaks rule 3.
  expect(
    CONTACT_WRITES.filter((w) => w.method !== 'patch' && w.method !== 'insert'),
  ).toEqual([])
  const naming = CONTACT_WRITES.filter((w) => /\bnumber\b/.test(w.call))
  expect(naming.map(({ file, method }) => ({ file, method }))).toEqual([
    { file: 'contacts/contracts.ts', method: 'insert' },
  ])
  const opaque = CONTACT_WRITES.filter(
    (w) => w.method === 'patch' && !/,\s*\{[^}]*\}\s*,?\s*\)$/.test(w.call),
  ).map((w) => w.call.replace(/\s+/g, ' '))
  expect(opaque).toEqual([
    "('contacts', root._id, fields)",
    "('contacts', root._id, slotValues(checked.slots))",
  ])
})

// Migrations on `contacts` write through `migrateOne`'s return, not
// `db.patch`, so they are listed by name: neither touches `number`
// (backfillContactSearch writes `contactSearch`, backfillFieldsVersion
// `fieldsVersion`). A new one fails here until it is checked and added.
test('every contacts migration is one checked by hand', () => {
  const migrations = FILES.flatMap(({ file, text }) =>
    [
      ...text.matchAll(
        /export const (\w+) = \w+\.define\(\{\s*table:\s*'contacts'/g,
      ),
    ].map((m) => `${file}:${m[1]}`),
  )
  expect(migrations).toEqual([
    'contacts/migrations.ts:backfillContactSearch',
    'contacts/migrations.ts:backfillFieldsVersion',
  ])
})

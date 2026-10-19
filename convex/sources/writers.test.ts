import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vitest'

// code.ts memoises the parts a call reads (`readPart`) and drops the memo
// before every write it makes. That is only sound while every write to
// `sourceCodes` is in code.ts, so this test holds the line: a writer
// anywhere else fails here, not as a stale read in production.

const ROOT = path.resolve(__dirname, '..')
const HOME = 'sources/code.ts'

/** Every non-test, non-generated .ts file under convex/, relative to it. */
function sources(): Array<string> {
  return (readdirSync(ROOT, { recursive: true }) as Array<string>)
    .map((f) => f.split(path.sep).join('/'))
    .filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.startsWith('_generated/'),
    )
}

/** `file:line` for each line matching `pattern`. */
function hits(pattern: RegExp): Array<string> {
  return sources().flatMap((f) =>
    readFileSync(path.join(ROOT, f), 'utf8')
      .split('\n')
      .flatMap((line, i) => (pattern.test(line) ? [`${f}:${i + 1}`] : [])),
  )
}

test('every write to sourceCodes is in sources/code.ts', () => {
  const writes = hits(/\.(insert|patch|replace|delete)\(\s*'sourceCodes'/)
  expect(writes.length).toBeGreaterThan(0)
  expect(writes.filter((w) => !w.startsWith(`${HOME}:`))).toEqual([])
})

/**
 * Writes whose table is a variable, so the grep above can't see which
 * table they hit. Each is checked by hand; a new one fails here until it
 * is. Matched by text within the line, so a moved line still matches.
 */
const DYNAMIC_WRITES = {
  // reconcile(): `table` is a ChildTable, a contact child table.
  'contacts/contracts.ts': [
    'ctx.db.delete(table, doc._id)',
    'ctx.db.insert(table, {',
    'ctx.db.patch(table, id, changes as never)',
  ],
  // executeContract's counter bump: on `sources.code` it writes
  // `saveVersion`, which no memoised reader uses (code.ts, `readPart`).
  'lib/contracts.ts': ['ctx.db.patch(contract.entity, id, {'],
} as Partial<Record<string, Array<string>>>

test('every write with a variable table is one checked by hand', () => {
  // `db.patch(id, …)` (no table) or `db.patch(table, …)` would write
  // sourceCodes unseen by the grep above.
  const found = sources().flatMap((f) =>
    readFileSync(path.join(ROOT, f), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) =>
        /\bdb\.(insert|patch|replace|delete)\(\s*[^'\s)]/.test(line),
      )
      .map((line) => [f, line] as const),
  )
  expect(
    found.filter(
      ([f, line]) => !DYNAMIC_WRITES[f]?.some((known) => line.includes(known)),
    ),
  ).toEqual([])
})

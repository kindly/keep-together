import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { tokenSubject } from './query-cache'

// The keep-alive cache is for the contact page only (perf-storage step 2):
// a held `list` would re-run on every contact save and join its wait.
const ALLOWED = [
  'components/contact-history.tsx',
  'components/contact-notes.tsx',
  // The contact page's and form's Convex reads (the data layer, rust spike).
  'lib/data/convex-contact.tsx',
]

function sources(dir: string): Array<string> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(path.join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [path.join(dir, e.name)]
        : [],
  )
}

describe('contact query cache', () => {
  test('only the contact page imports the cached useQuery', () => {
    const src = path.resolve(__dirname, '..')
    const users = sources(src)
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) =>
        /import \{[^}]*\buseQuery\b[^}]*\} from '[^']*\/query-cache'/.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => path.relative(src, f))
      .sort()
    expect(users).toEqual(ALLOWED)
    // Nothing reaches convex-helpers' cache around the wrapper.
    for (const f of sources(src)) {
      if (f.endsWith(path.join('lib', 'query-cache.tsx'))) continue
      if (/\.test\.tsx?$/.test(f)) continue // query-cache.dom.test.tsx pins its internals
      expect(readFileSync(f, 'utf8')).not.toMatch(
        /convex-helpers\/react\/cache/,
      )
    }
  })

  test('the list keeps convex/react’s useQuery', () => {
    // The route, and the data layer's Convex reads for it.
    for (const file of [
      '../routes/t.$slug.contacts.index.tsx',
      './data/convex-list.ts',
    ]) {
      const list = readFileSync(path.resolve(__dirname, file), 'utf8')
      expect(list).toMatch(
        /import \{[^}]*\buseQuery\b[^}]*\} from 'convex\/react'/,
      )
      expect(list).not.toMatch(/query-cache/)
    }
  })

  test('keys on the token subject, stable across a refresh', () => {
    const jwt = (claims: object) =>
      [
        'eyJhbGciOiJSUzI1NiJ9',
        btoa(JSON.stringify(claims))
          .replace(/=+$/, '')
          .replace(/\+/g, '-')
          .replace(/\//g, '_'),
        'sig',
      ].join('.')
    const a1 = jwt({ sub: 'userA|session1', iat: 1, exp: 2 })
    const a2 = jwt({ sub: 'userA|session1', iat: 3, exp: 4 })
    const b = jwt({ sub: 'userB|session2', iat: 1, exp: 2 })
    expect(tokenSubject(a1)).toBe('userA|session1')
    expect(tokenSubject(a2)).toBe(tokenSubject(a1))
    expect(tokenSubject(b)).not.toBe(tokenSubject(a1))
    expect(tokenSubject(null)).toBeNull()
    expect(tokenSubject('garbage')).toBeNull()
    expect(tokenSubject('a.!!!.c')).toBeNull()
  })
})

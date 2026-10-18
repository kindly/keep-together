// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { coverageGaps, readRoutes, routesFrom } from './coverage'

const tree = `
export interface FileRoutesByFullPath {
  '/': typeof IndexRoute
  '/t/$slug': typeof TSlugRouteWithChildren
  '/t/$slug/contacts/': typeof TSlugContactsIndexRoute
}
export interface FileRoutesByTo {
  '/t/$slug/contacts': typeof TSlugContactsIndexRoute
}
`

describe('routesFrom', () => {
  test('reads the full paths, not the `to` paths', () => {
    expect(routesFrom(tree)).toEqual(['/', '/t/$slug', '/t/$slug/contacts/'])
  })

  test('throws when the generated shape changes', () => {
    expect(() => routesFrom('export const x = 1')).toThrow(
      /FileRoutesByFullPath/,
    )
    expect(() => routesFrom('interface FileRoutesByFullPath {\n}')).toThrow(
      /no routes/,
    )
  })

  test('parses the real route tree', () => {
    expect(readRoutes()).toContain('/')
  })
})

describe('coverageGaps', () => {
  test('lists uncovered routes and unknown annotations', () => {
    expect(
      coverageGaps(
        ['/', '/t/$slug', '/t/$slug/contacts/'],
        ['/', '/', '/t/$slug/contact'],
      ),
    ).toEqual({
      uncovered: ['/t/$slug', '/t/$slug/contacts/'],
      unknown: ['/t/$slug/contact'],
    })
  })

  test('nothing to report when every route is annotated', () => {
    expect(coverageGaps(['/'], ['/'])).toEqual({ uncovered: [], unknown: [] })
  })
})

// Early warning only: the gate itself is the QC reporter, which sees the
// annotations of tests that ran. This catches a new route with no spec
// at `pnpm check` time, before anyone runs `pnpm qc`.
test('every route is named in some flow spec', () => {
  const dir = path.join('qc', 'flows')
  const specs = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(path.join(dir, f), 'utf8'))
    .join('\n')
  const unnamed = readRoutes().filter((r) => !specs.includes(`'${r}'`))
  expect(unnamed, 'routes with no flow in qc/flows (see qc/README.md)').toEqual(
    [],
  )
})

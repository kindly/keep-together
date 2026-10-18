import { readFileSync } from 'node:fs'

// The coverage gate (factory/plans/qc-suite.sv, Guardrails): every route
// in src/routeTree.gen.ts needs at least one test that ran and carried a
// `{ type: 'route', description: <fullPath> }` annotation. qc/reporter.ts
// applies it: a full run with a gap fails, a filtered run only warns.
//
// The check lives in the reporter, not in a static parse of the specs,
// because specs add their route annotations at runtime too
// (`test.info().annotations.push`), and only a test that actually ran
// proves its route works. qc/coverage.test.ts adds a cheap early warning
// under `pnpm check`.

export const ROUTE_TREE = 'src/routeTree.gen.ts'

/** The route full paths TanStack Router generated, e.g. `/t/$slug/contacts/`. */
export function routesFrom(source: string): Array<string> {
  const body = /interface FileRoutesByFullPath \{([^}]*)\}/.exec(source)?.[1]
  if (body === undefined) {
    throw new Error(
      `${ROUTE_TREE}: no FileRoutesByFullPath interface; has TanStack Router's output changed?`,
    )
  }
  const routes = [...body.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
  if (!routes.length) throw new Error(`${ROUTE_TREE}: no routes found`)
  return routes
}

export function readRoutes(file = ROUTE_TREE): Array<string> {
  return routesFrom(readFileSync(file, 'utf8'))
}

export interface CoverageGaps {
  /** Routes no test that ran was annotated with. */
  uncovered: Array<string>
  /** Annotations naming a route that doesn't exist (renamed or a typo). */
  unknown: Array<string>
}

export function coverageGaps(
  routes: Array<string>,
  annotated: Iterable<string>,
): CoverageGaps {
  const seen = new Set(annotated)
  const known = new Set(routes)
  return {
    uncovered: routes.filter((r) => !seen.has(r)),
    unknown: [...seen].filter((r) => !known.has(r)).sort(),
  }
}

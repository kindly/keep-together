import { isPorted } from './data'

/** Settings' list tabs, in order; each shows once its slice is ported. */
export const LIST_TABS = [
  { to: '/t/$slug/settings/fields', label: 'Fields' },
  { to: '/t/$slug/settings/identifiers', label: 'Identifier types' },
  { to: '/t/$slug/settings/sources', label: 'Source codes' },
] as const

/** The list tabs this build serves. */
export function portedListTabs() {
  return LIST_TABS.filter((t) => isPorted(t.to))
}

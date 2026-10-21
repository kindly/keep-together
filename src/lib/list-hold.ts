import type { ConvexReactClient } from 'convex/react'
import { api } from '../../convex/_generated/api'
import { firstPage } from './paged-list'
import type { ListFilters } from './paged-list'

/**
 * The contacts list route's hold on `list`'s first page from navigation start until the
 * page's own useQuery has it (or 1 s, if the page never mounts). Every
 * contact write re-runs `list` while anything holds it, so a hold that
 * outlived the page would join the wait of the next create or save
 * (perf-storage lever C). Its own module: the router splits the page
 * component from its loader, and both need this state.
 */
let held: (() => void) | undefined

export function holdList(convex: ConvexReactClient, filters: ListFilters) {
  releaseList()
  const unsubscribe = convex
    .watchQuery(api.contacts.queries.list, firstPage(filters))
    .onUpdate(() => {})
  const timer = setTimeout(releaseList, 1_000)
  held = () => {
    clearTimeout(timer)
    unsubscribe()
  }
}

/** Drop the hold; the page calls it once its own subscription is in place. */
export function releaseList() {
  held?.()
  held = undefined
}

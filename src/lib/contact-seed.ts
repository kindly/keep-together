import type { ContactView } from './domain/contacts'

export type { ContactView }

// A just-created contact's view, handed from the new-contact form to the
// contact page so the page renders on the create's own round trip. The
// page shows it only until its live queries answer, then drops it: never
// a cache, never served twice.
const seeds = new Map<string, ContactView>()

export function seedContact(id: string, view: ContactView) {
  seeds.set(id, view)
}

export function contactSeed(id: string): ContactView | undefined {
  return seeds.get(id)
}

export function dropContactSeed(id: string) {
  seeds.delete(id)
}

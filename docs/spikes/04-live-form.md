# Spike 4 — the live contact form

Date: 2026-10-17 · Status: **built and unit-tested; not yet exercised in a
browser** (no browser in the overnight run — first thing to do in the
morning: `pnpm dev`, sign in, open a group, create a contact, edit it in
two tabs).

## What it is

`/t/<slug>/contacts` (list, search, archived toggle, new) and
`/t/<slug>/contacts/<id>` — one form over the whole aggregate, autosaving,
with history and restore beside it. Groups on the home page link to it.

The form is a thin React component over a **pure reducer**
(`src/lib/contact-form-state.ts`, 8 tests) and the merge helpers
(`src/lib/merge.ts`, 7 tests):

- `base` = server state each slice was last reconciled against; `local` =
  what the user sees. Every live-query update is dispatched as `server`.
- **Echo handling:** counters are the identity of a state. An update
  whose counters equal the form's is the same state (including our own
  save coming back) and is ignored — the reducer returns the same object,
  so nothing re-renders.
- **Clean slice:** follows the server.
- **Dirty slice:** per-field three-way merge (`base`, `local`, `remote`).
  Remote-only changes land under in-progress typing; a field changed by
  both to different values keeps the local value and is listed in
  `conflicts` (badged on the field and in the top notice). After a merge
  the slice is still dirty and a save is re-requested against the new
  counter.
- **Saving:** after 700 ms of quiet (or the Save button), only dirty
  slices are submitted with their `expected` counters to
  `contacts.mutations.saveForm`; the server diffs again. The response's
  `saved` slices become the new `base` (the *submitted* payload, so typing
  during the save keeps the slice dirty), `problems` show inline and keep
  the slice dirty without retrying, `stale` keeps the **old** counter so
  the subscription is allowed to merge the newer state in — the first
  version of the reducer adopted the server's counter and then ignored the
  very update it was waiting for; the test caught it.
- **Identity fields:** editing a saved email address or phone number
  gives the row a new key, so the server sees remove + add (ADR 0014);
  addresses edit in place.
- **ngo-go's UX findings** carried over: `noValidate` on the form; one
  inline slot per field where an error wins over a warning; a top
  placeholder for whole-contact warnings, stale notices and conflicts; a
  fixed save pane with state, "N to fix" / "N to check" and a Save button;
  the display-name header updates from the live query.
- **History:** moments (a command group collapses to one entry), who and
  what, `restored` badge, "Restore to here" calling `restoreTo(at)`;
  archive toggle with its own counter.

## Not done

- No browser verification yet (see above). Likely rough edges: focus
  behaviour when a merged remote change re-renders a row, the "changed by"
  name in the stale notice (the form only knows the slice; the history
  panel shows who).
- Tenant resolution is by route slug, not by hostname (ADR 0017's routing
  HTTP action) — fine until a second domain exists.
- Plain Tailwind; shadcn components arrive with the first designed page.

import type { ListRow } from './domain/contacts'

export type { ListFilters, ListRow } from './domain/contacts'

/** Rows a page of the contacts list asks for (the server's own cap). */
export const LIST_PAGE_SIZE = 100

export type Paged<TRow> = {
  /** Undefined until page 0 has loaded. */
  rows: Array<TRow> | undefined
  /** More may follow (`loadMore`); 'done' only once the last page says so. */
  status: 'loading' | 'more' | 'done'
  loadMore: () => void
}

export type PagedList = Paged<ListRow>

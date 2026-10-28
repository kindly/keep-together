/**
 * An id of a row in `TTable`: a plain string on the wire (32 lower-case
 * hex, `server/README.md`), branded per table so the type checker never
 * lets a contact's id stand in for a gift's. Made only by the wire
 * adapters (`data/rust/*`), which cast what the API answers.
 */
export type Id<TTable extends string> = string & { __tableName: TTable }

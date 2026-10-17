# Spike 1 — moving a tenant between deployments with `_id` preserved

Date: 2026-10-17 · Status: **done, with one hard constraint found**

ADR 0017 says a tenant moves between the shared and dedicated tiers as a
per-tenant export in Convex's snapshot format, imported into the target,
with `_id` and `_creationTime` preserved so `v.id` references survive.
This spike proved it between two cloud dev deployments and found the rule
that makes it work.

## Setup

| | |
|---|---|
| Source | `zany-bird-247` (David's dev deployment, EU) |
| Target | `dev/spike-target` = `hidden-elk-598`, created with `npx convex deployment create dev/spike-target --type dev` (landed in US — see spike 6 for `--region eu`) |
| Data | `platform/devSeed:demoTenant` — one tenant, one owner, 7 relationship types, 3 contacts with emails, 13 revisions |
| Filter | `scripts/tenant-export.py full.zip <tenantId> tenant.zip` — keeps every row with that `tenantId`, the tenant row, the users its memberships reference, and each table's `generated_schema.jsonl` |
| Check | `platform/devSeed:inspectTenant` on both sides: contact ids, email→contact references, membership→user references, revision→entity references |

## What happened

1. **Import into a deployment that already had the schema pushed failed.**
   `npx convex import --append tenant.zip` →
   `New table "tenants" has IDs that conflict with existing table "contactPhones"`.
   Convex ids encode a per-deployment table number. The target had created
   its tables from the schema push in a different order, so the source's
   `tenants` ids decoded as `contactPhones` ids on the target. Even calling
   `inspectTenant` with the source tenant id failed argument validation for
   the same reason.
2. **`--replace-all` into the (empty) target succeeded** and the inspection
   output was byte-identical to the source: same `_id`s, every reference
   resolves, all 13 revisions point at existing documents. The replace-all
   import defines the tables, so the target adopts the source's table
   numbering.
3. **A second tenant then appended cleanly** (`--append`), and the first was
   untouched. Once the table maps agree, per-tenant moves are routine.

## The rule

> **A deployment that will ever receive tenants from another deployment
> must be born from that deployment's snapshot** (`import --replace-all`
> of an export, even a one-tenant one) *before* or *instead of* having
> its tables created by a schema push. After that, tenants move in either
> direction with `--append`. Two deployments whose tables were created
> independently can never exchange documents by id.

Consequences for the architecture:

- Provisioning a dedicated deployment = create it, **import first**, then
  push code (`scripts/dev-instance.sh` should grow an `--from <export>`
  step when the dedicated tier is built).
- New tables added later by schema pushes get numbers in push order on each
  deployment. To keep lineages compatible, **every deployment in the fleet
  must receive schema changes in the same order** — true by construction
  if all run the same bundle and migrations land through CI, but it is a
  rule to write down (added to ADR 0017's consequences).
- Convex's own backup/restore is the same mechanism (whole deployment);
  the per-tenant filter is ours and stays a 40-line script.
- Auth tables (`authSessions` etc.) are deliberately dropped by the filter:
  users re-authenticate on the new deployment; their `users` rows travel so
  memberships keep resolving.

## Repro

```sh
npx convex run platform/devSeed:demoTenant '{"slug":"demo"}'       # → tenantId
npx convex export --path full.zip
python3 scripts/tenant-export.py full.zip <tenantId> tenant.zip
npx convex import --deployment <target> --replace-all -y tenant.zip   # first time
npx convex import --deployment <target> --append -y tenant2.zip       # thereafter
npx convex run --deployment <target> platform/devSeed:inspectTenant '{"tenantId":"<tenantId>"}'
```

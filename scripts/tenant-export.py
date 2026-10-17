#!/usr/bin/env python3
"""Cut one tenant out of a Convex snapshot export.

    npx convex export --path full.zip
    python3 scripts/tenant-export.py full.zip <tenantId> tenant.zip
    npx convex import --deployment <target> tenant.zip   # --append / --replace

Keeps: every row whose `tenantId` is the tenant; the tenant row itself; the
`users` rows referenced by its memberships. Drops every other table (auth
sessions, other tenants). `_id` and `_creationTime` are kept, so references
survive the move (ADR 0017 tier move). `generated_schema.jsonl` per table is
copied so types are preserved.
"""
import json
import sys
import zipfile

src, tenant_id, dst = sys.argv[1:4]

with zipfile.ZipFile(src) as z:
    names = z.namelist()
    tables = sorted({n.split("/")[0] for n in names if n.endswith("/documents.jsonl")})

    def rows(table):
        with z.open(f"{table}/documents.jsonl") as f:
            return [json.loads(line) for line in f if line.strip()]

    memberships = [m for m in rows("memberships") if m["tenantId"] == tenant_id] if "memberships" in tables else []
    user_ids = {m["userId"] for m in memberships}

    kept = {}
    for table in tables:
        if table == "tenants":
            kept[table] = [r for r in rows(table) if r["_id"] == tenant_id]
        elif table == "users":
            kept[table] = [r for r in rows(table) if r["_id"] in user_ids]
        else:
            all_rows = rows(table)
            if all_rows and "tenantId" in all_rows[0]:
                kept[table] = [r for r in all_rows if r.get("tenantId") == tenant_id]
            # tables without tenantId (auth sessions etc.) are dropped

    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as out:
        for table, docs in kept.items():
            out.writestr(f"{table}/documents.jsonl", "".join(json.dumps(d) + "\n" for d in docs))
            schema_name = f"{table}/generated_schema.jsonl"
            if schema_name in names:
                out.writestr(schema_name, z.read(schema_name))

for table, docs in kept.items():
    print(f"{table}: {len(docs)}")

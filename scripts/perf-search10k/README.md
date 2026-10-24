# Contact search/list at 10k contacts

Seeds a rehearsal slot with 10,000 realistic UK contacts (through the public create path) and times `contacts/queries:search` and `:list` from the slot's function logs. Run everything outside the Claude sandbox:

```bash
pnpm rehearsal:claim                       # say it gave slot 1, URL $URL
pnpm rehearsal:run 1 -- deploy --codegen disable -y
pnpm rehearsal:run 1 -- run platform/qcSeed:fixture '{"runId":"perf","worker":0,"password":"perf-password-123"}'
# tenant ids A, B from the output; admins qc-rperfw0-a@example.com, qc-rperfw0-b@example.com
node scripts/perf-search10k/seed.mjs --url $URL --email qc-rperfw0-a@example.com --password perf-password-123 --tenant $A --count 10000 --seed 1 --prefix perfa --workers 16
node scripts/perf-search10k/seed.mjs --url $URL --email qc-rperfw0-b@example.com --password perf-password-123 --tenant $B --count 60 --seed 2 --prefix perfb --workers 8
node scripts/perf-search10k/measure.mjs --slot 1 --url $URL --email qc-rperfw0-a@example.com --emailB qc-rperfw0-b@example.com --password perf-password-123 --tenant $A --tenantB $B --out $TMPDIR/search10k --reps 20
node scripts/perf-search10k/analyze.mjs $TMPDIR/search10k/raw.json
pnpm rehearsal:release 1
```

Keep at most ~16 seed workers in flight: creates contend on the tenant's contact-number sequence row. The seed is resumable (by clientKey). The baseline from main 4e35939 is in `factory/out/tester-search10k-report.md` (smith 487 ms median server time, plain list 57 ms).

# Spike 5 — IRmark

Date: 2026-10-17 · Status: **done** — both HMRC-published samples produce
the published IRmark; the canonical payload matches HMRC's own
canonicalised file byte for byte.

## Sources (all HMRC, Open Government Licence)

- *Generic IRmark specification* v1.2 (2004): hash is over the `<Body>` of
  the GovTalkMessage excluding the `<IRmark>` element; C14N; SHA-1;
  base64 (28 chars) for the element, base32 (32 chars) for display/print.
- *IRmark generation step-by-step guide for Gateway protocol services*
  v2.0 (2011): extract everything inside and including `<Body>`,
  **inherit the namespace declarations of `<GovTalkMessage>` onto
  `<Body>`**, remove the IRmark node preserving surrounding whitespace,
  canonicalise (no comments), SHA-1, encode.
- Worked example (CTF submission + canonicalised payload + response) and
  the *Charities Online valid XML samples* (an HMRC-CHAR-CLM Gift Aid
  claim with its IRmark). Copies: `test/fixtures/hmrc/`.

## Implementation (`convex/giftaid/irmark.ts`)

Because we generate the submission XML ourselves, it is emitted already
canonical (double quotes, sorted attributes, C14N text escaping, LF). So
the IRmark path is string work, not a C14N library: find the
`<GovTalkMessage>` namespace declarations, take the `<Body>` element,
rebuild its start tag with the inherited declarations (default `xmlns`
first), strip the `<IRmark>` element, normalise CRLF, SHA-1 via Web
Crypto, encode. `stampIrmark` fills an empty `<IRmark Type="generic">`
and is idempotent.

Verified:

| Sample | Expected | Result |
|---|---|---|
| Gateway worked example (CTF) | `RPfWtxHeCZRcwfitnIJmK9xc4OQ=` | ✅ and canonical payload == HMRC's file |
| Gift Aid claim `GAValidSample.xml` | `nMs6zamBGcmT7n0selJHXuiQUEw=` | ✅ base32 `TTFTVTNJQEM4TE7OPUWHUUSHL3UJAUCM` |
| CRLF input | same | ✅ |

`convex/giftaid/actions.ts` is a `'use node'` `internalTenantAction`
wrapping it: the mark itself needs only Web Crypto (so it also runs in
the default runtime), but the Gateway client (submit, poll, receipt,
error codes 2021/2022) belongs in Node and this proves that file deploys.

## Limits of this spike

- No R68 claim builder yet. The RIM artefacts v2.0 (`r68-v2-0.xsd`,
  schematron, spec PDF) are downloaded under the scratchpad; the builder
  will emit canonical XML straight from the reclaim record (ADR 0007
  rule 4) and reuse `escapeText` / `escapeAttribute`.
- Not sent to HMRC's test service — that needs a vendor ID from the SDS
  team. The Local Test Service (LTS) can validate offline once the
  builder exists.

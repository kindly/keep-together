<sv-page label="plan: address lookup" category="archive">

<sv-prose id="b1">
## Design tree

*Confirmed by the human in round 1 (2026-10-25): postcode lookup now, autocomplete later (a1q1); cap 100 lookups per group per month (a1q3); everything else as suggested. Ready for building.*

- **What the user sees**: a "Find address" control in the contact form's Addresses section. Type a postcode, pick from the list, and line 1–3, town, postcode and country (GB) fill in. The row then autosaves like a typed one.
  - **Manual entry stays.** The lookup never blocks saving, and anything it fills can be edited.
  - Offered to **staff and admins**, the roles that edit contacts. Viewers don't see it.
- **Who pays: the platform's key**, with a group's own key possible later.
- **Provider: Ideal Postcodes (PAF)**, behind a small `AddressLookup` trait so another provider or a group's own key can be swapped in later.
  - `KEEP_ADDRESS_LOOKUP=ideal|fake|off`. `fake` returns fixed addresses for a few postcodes (tests, local, preview). `off` hides the control.
  - `ideal` needs `KEEP_IDEAL_POSTCODES_KEY`, a Fly secret that never reaches the browser.
- **Through our api, never straight from the browser**: `GET /api/t/{slug}/address-lookup?postcode=…`.
  - The key stays server-side, so we can count use per group and leave the SPA's CSP unchanged.
  - The answer is ids-free display data: `{ addresses: [{ line1, line2, line3, town, postcode }] }`.
- **Autocomplete later** (*human, a1q1*): only the picker changes; the trait gets a second method then.
- **Cost control**:
  - a **monthly cap of 100 lookups per group** (*human, a1q3*), set by env `KEEP_ADDRESS_LOOKUP_CAP` so it can change without a release. Over it, the route answers `429 lookup_cap` and the form says "Lookups used up this month: type the address";
  - a **platform-wide daily ceiling**, so a bug or a loop can't drain the credit;
  - usage is counted per group per month in the platform's own storage, not in domain tables and not as a contract.
- **No caching or storing of PAF results** beyond the request (PAF licence terms). Nothing new is stored on the contact (no UPRN). Addresses are never logged.
- **Failures fall back to typing**: not found gives "No addresses for that postcode", and a provider error or 5s timeout gives "Lookup unavailable: type the address".
- **Staging uses the real key**; nightly QC looks up only the provider's free test postcode.
- **Gift Aid gains** a cleaner house name or number plus postcode for the HMRC claim. No claim code changes.
</sv-prose>

<sv-prose id="b2">
## Cost

- Ideal Postcodes: **1 credit per postcode lookup**, 4.5p (a £9 pack of 200) down to 2.8p. No subscription, credits last 12 months, auto top-up available, and 50 free trial credits.
- A small group adding 50–200 contacts a month spends roughly **£1–8 a month**.
- They advertise a **charity rate ("up to 90%" off)** without figures. Worth asking them before buying more than a small pack.
- Not-found postcodes and the test postcode should cost nothing. **To confirm with them** (step L0).
</sv-prose>

<sv-prose id="b3">
## Steps

| Step | What | Who |
|---|---|---|
| **L0** | Ideal Postcodes account (trial, no card); ask about the charity rate, which requests are charged, and their free test postcode. | you |
| **L1** | `AddressLookup` trait with the `ideal` (reqwest + rustls, 5s timeout) and `fake` providers; boot config and refusals (`ideal` without a key stops the boot); the route, the role check, the per-group cap and the daily ceiling. Tests: isolation (group B can't use group A's slug), viewer refused, cap reached, timeout, no network in tests. | builder |
| **L2** | The "Find address" picker in `AddressFields` (`src/components/contact-form.tsx`): postcode input, list, fill, then autosave. Dom tests, and a QC flow using the fake provider or the provider's free test postcode. | same builder |
| **L3** | `scripts/fly/address-lookup-key.sh` reads the key from your terminal into `fly secrets import --stage` (never argv, never printed). Plus rs/README env table, docs/ops.md, and a short ADR 0014 amendment ("lookup fills fields; nothing extra stored"). | builder, you run the script |

One builder plus one reviewer, about a day. It's all in `rs/` and the SPA, so it doesn't wait for cutover or touch the C1 gate. The nightly QC must stay green.
</sv-prose>

<sv-ask id="a1q1" round="1">
**Lookup style.** Postcode lookup is one request and one credit, with a list of the addresses at that postcode; it's the usual UK CRM pattern. Autocomplete suggests addresses as you type (free), and the pick costs a credit. It's nicer for partial addresses, but more requests and more UI.
- * Postcode lookup only
- Autocomplete only
- Postcode now, autocomplete later
</sv-ask>

<sv-ask id="a1q2" round="1">
**Who pays.** One platform account, with a cap per group, is simple and lets every group use it from day one. Each group bringing its own key means no cost to us, but a setup step for them.
- * Platform key with a per-group cap; a group's own key possible later
- Each group brings its own key
- Platform key, no per-group cap (daily ceiling only)
</sv-ask>

<sv-ask id="a1q3" round="1">
**Monthly cap per group** (lookups). Your call; I've not suggested one. 100 lookups is about £3–4.50 at pack prices.
- 100
- 250
- 500
</sv-ask>

<sv-ask id="a1q4" round="1">
**Keep the UPRN?** Ideal Postcodes returns the property's UPRN free. Storing it would help spot duplicates (two contacts at one address) later. ADR 0014 dropped geocoding and shared addresses, so storing it means a schema step and an ADR note.
- * No, fill the fields only
- Yes, store it on the address row
</sv-ask>

<sv-ask id="a1q5" round="1">
**Staging.** With a real key, the nightly QC uses the provider's free test postcode, so it costs nothing if L0 confirms that. Otherwise staging runs `fake`.
- * Real key on staging, QC on the free test postcode
- `fake` on staging
</sv-ask>

<sv-ask id="a1fin" round="1" role="close">
</sv-ask>

</sv-page>

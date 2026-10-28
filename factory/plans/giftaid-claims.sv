<sv-page label="plan: Gift Aid claims" category="plans">

<sv-prose id="b1">
## Design tree

*Confirmed by the human in round 1 (2026-10-28), all as suggested: schedule spreadsheet now plus the XML as the recognition evidence, direct submission after recognition; claimed gifts locked, with adjustments; aggregation and GASDS later. Ready for building after cutover.*

**The blocker and the way round it.** HMRC wants evidence before giving us a vendor ID, which is needed to send claims direct. Their recognition process asks for the claim XML our product generates from their sample data. So:

- **Now: each group submits through its own HMRC Charities Online account.** We produce HMRC's **Gift Aid schedule spreadsheet** and they upload it. No HMRC recognition is needed, and the money and the claim stay the group's.
- **Also now: the claim XML** (GovTalk, with the IRmark we already have in `giftaid::irmark`), generated but **not sent**. Running HMRC's sample data through it is the evidence for recognition.
- **Later, once recognised:** submit direct and poll for HMRC's answer. That's a separate step, needing a vendor ID and each group's Government Gateway credentials.

**The claim, a real financial record (rule 4):**
- `gift_aid_claims`: status, the period it covers, the totals, and the date marked submitted, HMRC's reference, and the amount and date paid.
- `gift_aid_claim_lines`: the gift, the covering declaration, and a snapshot of what was sent (title, first and last name, house name or number, postcode, date, amount), so the record stays true if the contact changes later.
- The reclaim is 25% of the gift, in integer pence, rounded down, and stored per line and per claim.
- **A gift is in at most one live claim**, enforced by the schema.
- Status: `draft → ready → submitted → paid`, or `rejected`. A claim is removed only while it's a draft. Every change is a contract with revisions.

**Which gifts are eligible:**
- completed (not void);
- covered by a declaration on the gift's date (`giftaid::rules::covers`, the dated chain, rule 1);
- not already claimed;
- received within the last 4 years;
- from a contact who is a person, with a name, a house name or number, and a postcode (`X` for an overseas address).

Every gift left out is listed with its reason ("no declaration on 3 Mar", "no postcode"), so staff can fix it and refresh.

**The steps, all admin only:**
1. On the Gift Aid page, "New claim" with an end date (today by default).
2. A preview: eligible gifts with their total, the excluded gifts with reasons, and the reclaim.
3. Create the claim, which freezes its lines (draft).
4. Download the schedule. Schedules over HMRC's row limit are split into several files.
5. "Mark submitted" (date, HMRC reference).
6. "Mark paid" (amount, date). That's the reclaim, recorded as money received.

**A claimed gift is locked:** its amount, date and contact can't be edited, and voiding it needs a reason. That reason goes into the next claim as an **adjustment** (HMRC's field for reclaims to pay back).

**The group's HMRC details**, set on the admin settings page: the charity's HMRC reference, the regulator and its number, and an authorised official's name.

**Not now:** aggregated small donations, GASDS, connected charities, direct submission.
</sv-prose>

<sv-prose id="b2">
## Steps

| Step | What |
|---|---|
| **G1** | Schema and contracts for claims and claim lines; the eligibility query; preview, create, mark submitted and mark paid; claimed gifts locked; HMRC details in preferences. Routes with isolation tests; QC flows. |
| **G2** | The schedule spreadsheet, built to HMRC's current template from gov.uk (the builder fetches it and cites it). Plus the claim XML against HMRC's schema and samples, and a check that HMRC's sample data produces their valid sample (`test/fixtures/hmrc/GAValidSample.xml`). |
| **G3** | The UI: Gift Aid page, claim list, preview with exclusions, claim detail, downloads. |
| **you** | Once G2 is merged: send the generated XML for HMRC's sample data to SDSTeam@hmrc.gov.uk as the evidence. I'll draft the email. |

One builder for G1 and G2, a second for G3 once G1's routes exist, and a reviewer after each.
</sv-prose>

<sv-ask id="g1q1" round="1">
**First way to claim.** The schedule needs nothing from HMRC and works for any group today. Direct submission needs recognition first.
- * Schedule spreadsheet now (plus the XML for the evidence); direct submission after recognition
- Wait for recognition and go direct only
</sv-ask>

<sv-ask id="g1q2" round="1">
**A gift that's already been claimed.**
- * Locked; voiding it needs a reason and adds an adjustment to the next claim
- Editable, with a warning and an adjustment
</sv-ask>

<sv-ask id="g1q3" round="1">
**Aggregated small donations (£20 and under) and GASDS** (top-up on small cash gifts without a declaration).
- * Later, as separate claim types
- Include aggregation now
</sv-ask>

<sv-ask id="g1fin" round="1" role="close">
</sv-ask>

</sv-page>

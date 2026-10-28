HMRC's Gift Aid donations schedule spreadsheet templates (Crown copyright,
Open Government Licence v3.0), from "Gift Aid schedule spreadsheets to
claim back tax on donations",
https://www.gov.uk/government/publications/gift-aid-schedule-spreadsheets-to-claim-back-tax-on-donations
(publication updated 2024-08-29; fetched 2026-10-28). Guidance:
https://www.gov.uk/guidance/schedule-spreadsheet-to-claim-back-tax-on-gift-aid-donations
(updated 2025-11-28).

| file | attachment | sha256 |
|---|---|---|
| `Gift-Aid-Schedule-Excel.ods` | "Gift Aid donations schedule — Excel", https://assets.publishing.service.gov.uk/media/66d01bb65f85c44e918b229a/Gift-Aid-Schedule-Excel.ods | `66d7dd428bc32da282a47a70234b00bc8b10dec54e6fffa9a1596c108dd080d4` |
| `gift_aid_schedule__libre_.ods` | "Gift Aid donations schedule — LibreOffice", https://assets.publishing.service.gov.uk/media/5cc3193040f0b6403e5c95b2/gift_aid_schedule__libre_.ods | `523aeaec4922406c831df51d40df7f316481b9f6d2df37080f3c55048c16530b` |

Both are one sheet, `R68GAD_V1_00_0_EN` (HMRC: never rename it), no
macros and no cell validations. `giftaid::schedule` fills a copy: Box 1
(earliest donation date) in D13, Box 2 (previously over-claimed tax) in
D17, donations in rows 25–1024, columns C–K (title, first name, last
name, house name or number, postcode, aggregated, sponsored, date,
amount), and the cached value of the J20 total (`SUM(K25:K1024)`). HMRC: download the one
for the software you open it with; don't convert between them.

HMRC-published samples used by the IRmark tests (Crown copyright, Open Government Licence):

- `GAValidSample.xml` — Charities Online Gift Aid claim (HMRC-CHAR-CLM), from
  https://www.gov.uk/government/publications/charities-technical-specifications-valid-xml-samples
  IRmark in the file: `nMs6zamBGcmT7n0selJHXuiQUEw=`
- `irmarkexample-submission.xml` / `irmarkexample-canonicalised.xml` — the worked
  example from https://www.gov.uk/government/publications/hmrc-irmark-for-gateway-protocol-services
  IRmark: `RPfWtxHeCZRcwfitnIJmK9xc4OQ=`
- `r68-v2-0.xsd` — the R68 claim schema from "Charities RIM artefacts version 2.0",
  https://assets.publishing.service.gov.uk/media/5a80052640f0b62305b88af8/hmrc-charities-v2-0.zip
  (`HMRC-Charities-v2-0-20141015/r68-v2-0.xsd`, unchanged). `giftaid::xml`'s tests validate a
  generated claim body against it with `xmllint` when it is installed.

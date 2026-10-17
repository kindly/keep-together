import type { FullResult, Reporter } from '@playwright/test/reporter'

// QC reporter. Step 4 makes it append one line per flow to
// qc-results/history.jsonl and print the flow/median/max/budget table;
// for now it only marks where that output will go.
export default class QcReporter implements Reporter {
  onEnd(result: FullResult) {
    console.log(`qc: ${result.status} (timing table arrives with step 4)`)
  }
}

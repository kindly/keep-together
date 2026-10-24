// Nor can an `OrgTx` be built around some other transaction.
fn forge<'a>(raw: &'a store::RawTx<'a>) -> contracts::OrgTx<'a> {
    contracts::OrgTx { raw }
}

fn main() {}

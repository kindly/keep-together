//! The write path is sealed (M3): domain code holding an `OrgTx` can read,
//! and can write only by executing a contract. These must not compile.

#[test]
fn domain_code_cannot_write_raw_sql() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/sealed/*.rs");
}

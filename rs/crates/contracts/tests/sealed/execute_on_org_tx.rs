// A handler with a transaction tries to write without a contract.
fn handler(ctx: &contracts::Ctx) -> rusqlite::Result<usize> {
    ctx.tx.execute("DELETE FROM contacts", [])
}

fn main() {}

// `OrgTx` is not a connection.
fn handler(ctx: &contracts::Ctx) {
    let _conn: &rusqlite::Connection = ctx.tx;
}

fn main() {}

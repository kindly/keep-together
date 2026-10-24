// Only `contracts::execute` makes a `WriteTx` (or a `ProjectionTx`).
fn handler(ctx: &contracts::Ctx) {
    let w = contracts::WriteTx(ctx.tx.read());
    let p = contracts::ProjectionTx(ctx.tx.read());
    let _ = (w, p);
}

fn main() {}

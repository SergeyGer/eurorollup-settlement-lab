// Offline fixture tool: computes one eligibility leaf hash.
fn main(wallet: Field, class: Field, epoch: Field, expiry: Field, salt: Field) -> pub Field {
    std::hash::pedersen_hash([wallet, class, epoch, expiry, salt])
}

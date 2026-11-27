// Offline fixture tool: computes one Merkle node hash.
fn main(left: Field, right: Field) -> pub Field {
    std::hash::pedersen_hash([left, right])
}

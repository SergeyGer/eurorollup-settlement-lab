// Eligibility membership proof.
//
// Proves that the caller knows a wallet-bound credential committed in the
// issuer's current Merkle root, and binds the proof to the wallet, chain, gate,
// class, epoch and expiry.
//
// Private witness: salt, Merkle path, path indices.
// Public inputs: wallet, root, chain_id, gate, class, epoch, expiry.
//
// The leaf preimage is pedersen_hash([wallet, class, epoch, expiry, salt]); the
// tree is a binary Merkle tree over 2^3 leaves with pedersen_hash as the node
// function. The circuit is intentionally generic: the gate/class policy
// (verified class for fund movements, clear screening for spot) is applied by
// the verifier and the dealing policy, not hidden in the proof.
fn main(
    wallet: pub Field,
    root: pub Field,
    chain_id: pub Field,
    gate: pub Field,
    class: pub Field,
    epoch: pub Field,
    expiry: pub Field,
    salt: Field,
    path: [Field; 3],
    indices: [bool; 3],
) {
    // Bind the public context so a proof cannot be replayed for another chain or
    // gate; the local verifier also compares these fields with its configuration.
    assert(chain_id != 0);
    assert(gate != 0);
    assert(epoch != 0);
    assert((expiry as u64) > 0);

    let leaf = std::hash::pedersen_hash([wallet, class, epoch, expiry, salt]);
    let mut current = leaf;
    for i in 0..3 {
        let sibling = path[i];
        let (left, right) = if indices[i] {
            (sibling, current)
        } else {
            (current, sibling)
        };
        current = std::hash::pedersen_hash([left, right]);
    }
    assert(current == root);
}

# Glossary

| Term | Meaning |
| --- | --- |
| **ADR** | Architecture Decision Record. A short document recording a decision, alternatives and consequences. |
| **Business state** | The lifecycle of an investor intent: quoted, submitted, filled, expired, declined; or reserved, awaiting NAV, allocated, redeemed, cancelled, held. Independent of chain state. |
| **Business digest** | SHA-256 of canonical JSON describing a result, excluding model prose, execution timestamps and run IDs. The stable identifier used to compare runtimes. |
| **Chain state** | Submitted, unsafe, safe, finalized. Advances independently from business state. |
| **Cutoff** | The weekly eFUND subscription deadline (UTC). Release 1.0 supports changing one weekday's cutoff to whole-minute times from 00:01 to 16:59 UTC. |
| **dEUR** | Six-decimal demo euro cash token used as the common cash leg. A test accounting device, not e-money. |
| **Dealing day** | A calendar day on which a fund batch is struck. Orders at or after the cutoff move to the next dealing day. |
| **eFUND** | Six-decimal unit of the fictional euro short-duration bond fund. |
| **Evidence pack** | Versioned bundle of inputs, journals, receipts, policy decisions, results and checksums that reproduces a released outcome. |
| **Fixture** | A frozen synthetic input with exact expected outputs. G01 is the portfolio fixture; P01 is the Friday cutoff experiment. |
| **Fixture clock** | Deterministic time source used by replay instead of wall-clock time. |
| **Gate** | A release acceptance test (A01-A09) whose artifact must be attached to the release commit. |
| **Local AI mode** | Mode in which free text goes through a real local model adapter instead of the recorded proposal preset. |
| **NAV** | Net asset value: the authorized price of one eFUND unit for a valuation date. |
| **Policy hold** | A reservation kept while a policy condition (eligibility change, missing NAV, sponsorship limit) blocks settlement. |
| **Policy Lab** | The product-owner workspace that turns an English rule question into a typed proposal, requires confirmation, and replays two branches. |
| **Policy epoch** | Version marker of the active policy or eligibility root; a root update invalidates earlier approvals. |
| **Recorded proposal** | A frozen model draft labelled as recorded output, used by the public browser preset. |
| **Reserved cash** | Cash committed to a pending fund request and therefore not spendable. |
| **Stable business digest** | See business digest. |
| **tWETH** | Eighteen-decimal test wrapped ETH used in the spot lane. |
| **UserOperation** | The ERC-4337 operation envelope submitted through the EntryPoint by a smart account. |

# v2 close evidence index — ABORT RECORD (2026-08-31)

The second window was ended by owner decision eleven days before its derived close (`Abort
A-2026-08-31`, deviations ledger; T_abort `2026-08-31T10:02:21.000Z`). This index names the
abort-run's evidence chain — the artifacts themselves are retained OUTSIDE the repository, per the
run sheet's H2b: the working set in the operator's close-run directory, and a durable second copy
owed to the same off-machine location as the Q4 backup (PENDING as of this writing; the snapshot
directory itself is retained offline only and is not part of the non-secret set).

*(2026-09-03: do NOT discharge that durable copy against the location the Q4 backup was placed in.
It was measured onto the system disk rather than onto a separate medium — the abort record's Q4
correction carries the measurement — so copying the evidence chain there would reproduce the same
defect. The two chain artifacts already placed in that directory sit on the system disk for the same
reason. Redo Q4's copy first, then use the medium it establishes.)*

| artifact | bytes | sha256 |
|---|---|---|
| `manifest.json` | 3269 | `19cfcadf215f0a3733c67195cc0d73fd248bdb3e49476ce2a061f7d299a74793` |
| `classifier.json` | 9108 | `035d027bcfedea46435851bbf4f2f3f6d16d84743926ed693f32f87e0c1546ec` |
| `classifier.universe.json` | 40821 | `7eb8ffa76e1799d2d0ac134591372b5e499c62b859878f4b720cfee38c3cc0f4` |
| `pins.json` | 1379 | `13e3d65e908d57c51c71c113677e53fe68c5f18d34045522022da0d74852fc53` |
| `gate-set.json` | 3011 | `41047b68ea98f5a77b1567d5236d4cde62597fe0e2465edd93c802a64b7cf367` |
| `ordering.jsonl` | 3874 | `0bb3fda4faad1ec14d5cbebb92c2df1c9c46e152802638c79a4e417ffe07cddf` |
| `run1.json` | 16904 | `b208c7b834959b1f0bcad8a541dacc76440b88af953ced236ee500cc26b2c29d` |
| `run2.json` | 16904 | `12970372539c793990a2fd29f0e95af77817dc109d0c2a78334cc44978c82b4e` |
| `run3.json` | 16904 | `19ef2fadcdaaf6db1de2fad793f61fb2d1fa08940eb34cdb8bd7989156a3bb5d` |
| `adjudication.json` | 4766 | `49653931ec44a338b664703f3bcbcd52b15edcdba8ddf6688b16d4956e6681e4` |
| `score.json` | 4950 | `3b4d37d00409a84046dadaf32305608564dc176c5715cf7348ddcb7f1a308136` |
| `score2.json` | 4950 | `a8f35b54803c4e63caafd645e60aa0a5cee66d9bfe4aaa5afcc524334b02f630` |
| `release-record.json` | 2575 | `8f763945b138cc5636585628ee41e1f2ebf3a7cfb8483539e6fed5ab87da4e42` |
| `snapshot-hashes.txt` | 711 | `4a5908c360045bf5d0dc2350d0afbb4b85cb0c3f08d5ec708971cd2c0862f13c` |
| 0.1 transcript | — | none captured — 0.1 was skipped in the abort-run; the session log and the close-run log substitute |

Chain bindings, for the walk §8 of the report performs: the release record binds the score payload
and the ordering head; the score binds the gate set, the three (identical) run payloads and the
adjudication; the pins bind every input to the freeze receipt's `payloadSha256`. The snapshot's
composed sha256 equals `sha256sum snapshot-hashes.txt` by construction.

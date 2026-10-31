# Retrieval evaluation — FAIL

Pre-registered in `scripts/retrieval-eval/README.md`. 100 commit subjects from `fd36ac5` as queries; the answer is the files each commit changed.

| arm | acc@1 | acc@5 | MRR@10 |
|---|---:|---:|---:|
| keyword | 62.0% | 83.0% | 0.715 |
| hybrid | 64.0% | 86.0% | 0.732 |
| hybrid+ppr | 42.0% | 82.0% | 0.588 |

v2 (PageRank): FAIL. Bar: hybrid+ppr acc@5 at least 3 pp above hybrid. Difference: -4.0 pp.

Bar: hybrid acc@5 at least 5 pp above keyword. Difference: 3.0 pp.

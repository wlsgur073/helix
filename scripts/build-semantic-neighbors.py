#!/usr/bin/env python3
"""Build data/semantic-neighbors.json from a static POTION embedding (build-time only).
Run in an env with model2vec installed; NOT a runtime dependency. Deterministic:
fixed vocab order, floor, K, and stable tie-break -> the committed asset is reproducible."""
import json, re, sys, urllib.request
from pathlib import Path
import numpy as np
from model2vec import StaticModel

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "semantic-neighbors.json"
FREQ_URL = "https://norvig.com/ngrams/count_1w.txt"   # public-domain (Google Web Trillion Word Corpus)
TOP_N = 25000            # vocabulary cap (size lever)
FLOOR = 0.50             # build floor (0.45-0.50 band is mostly noise; calibration theta is >= 0.50)
K = 8                    # max neighbors kept per word
POOL = 64                # candidate pool before morphological filtering (must exceed K + inflections)
CHUNK = 512              # rows per matmul chunk (memory bound)
STEM_PREFIX = 4          # drop a neighbor sharing a >= this-long common prefix (an inflection)


def common_prefix_len(a, b):
    n = min(len(a), len(b)); i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i

STOP = set("""the a an and or of to in on at for with by from as is are was were be been being it
its this that these those i we you my our your what which who when where how did do does done about
into over than then so if but not no can will would could should may might must have has had not""".split())

def load_vocab():
    raw = urllib.request.urlopen(FREQ_URL, timeout=60).read().decode("utf8")
    words = []
    for line in raw.splitlines():
        w = line.split("\t")[0].strip().lower()
        if re.fullmatch(r"[a-z]{2,}", w) and w not in STOP:
            words.append(w)
        if len(words) >= TOP_N:
            break
    return words

def main():
    vocab = load_vocab()
    print(f"vocab={len(vocab)} loading potion-base-8M ...", file=sys.stderr)
    m = StaticModel.from_pretrained("minishlab/potion-base-8M")
    V = np.asarray(m.encode(vocab), dtype=np.float32)
    V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    neighbors = {}
    for start in range(0, len(vocab), CHUNK):
        block = V[start:start + CHUNK]               # (b, d)
        sims = block @ V.T                           # (b, N)
        for r in range(block.shape[0]):
            i = start + r
            row = sims[r]
            row[i] = -1.0                            # exclude self
            cand = np.argpartition(-row, POOL)[:POOL]
            cand = cand[np.argsort(-row[cand])]
            out = []
            kept = []  # kept neighbor words, for stem-dedup
            for j in cand:
                c = float(row[j])
                if c < FLOOR:
                    break
                w = vocab[j]
                # Skip a morphological variant of the SOURCE or of an already-kept synonym: the lexical
                # prefix-expansion covers inflections, so spend K slots on DIVERSE true synonyms
                # (delete, eliminate, rid) rather than one inflection family (delete, deletes, ...).
                if common_prefix_len(vocab[i], w) >= STEM_PREFIX:
                    continue
                if any(common_prefix_len(w, k) >= STEM_PREFIX for k in kept):
                    continue
                out.append([w, int(round(1000 * c))])
                kept.append(w)
                if len(out) >= K:
                    break
            if out:
                neighbors[vocab[i]] = out
        print(f"  {min(start + CHUNK, len(vocab))}/{len(vocab)}", file=sys.stderr)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(
        {"version": 1, "source": "potion-base-8M", "floor": FLOOR, "k": K,
         "neighbors": dict(sorted(neighbors.items()))}, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(neighbors)} entries)", file=sys.stderr)

if __name__ == "__main__":
    main()

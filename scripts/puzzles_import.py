"""Build data/puzzles.sqlite (core/puzzles.py) from Lichess's puzzle database: the puzzles tagged with an
opening (1.22M of 6.16M in the 2026-10 dump), each with its pattern signature, plus each pattern's count across
all of them (the baseline for "typical of this opening").

    curl -L -o data/puzzles/lichess_db_puzzle.csv.zst https://database.lichess.org/lichess_db_puzzle.csv.zst
    .venv/bin/python -m scripts.puzzles_import [path to .csv or .csv.zst]

A .zst is streamed through `zstd -dc` (brew install zstd), so the 1.1 GB csv never needs to be on disk. Writes a
new file and swaps it in, so a running server keeps reading the old one until then (restart it to drop its
caches). ~1.5 min.
"""

import csv
import io
import os
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

from core import puzzles

DEFAULTS = [Path("data/puzzles/lichess_db_puzzle.csv.zst"), Path("data/puzzles/all.csv")]

SCHEMA = """
CREATE TABLE puzzles (
    id TEXT PRIMARY KEY,
    fen TEXT NOT NULL,          -- before the trigger move
    moves TEXT NOT NULL,        -- UCI, space-separated: the trigger, then the solution with the replies
    rating INTEGER NOT NULL,
    rd INTEGER,
    popularity INTEGER,
    plays INTEGER,
    themes TEXT,
    family TEXT NOT NULL,       -- Lichess opening tags: "Sicilian_Defense"
    variation TEXT NOT NULL,    --   "Sicilian_Defense_Najdorf_Variation"
    game_url TEXT,
    solver TEXT NOT NULL,       -- 'w' / 'b'
    trigger TEXT NOT NULL,      -- SAN, no +/#
    answer TEXT NOT NULL,       -- SAN
    pattern TEXT NOT NULL       -- "w:Qxh7|mate"
);
CREATE TABLE tags (tag TEXT PRIMARY KEY, kind TEXT NOT NULL, family TEXT, n INTEGER NOT NULL);
CREATE TABLE pattern_base (pattern TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""
INDEXES = """
CREATE INDEX puzzles_family ON puzzles (family, rating);
CREATE INDEX puzzles_variation ON puzzles (variation, rating);
"""


def rows(path: Path):
    if path.suffix == ".zst":
        proc = subprocess.Popen(["zstd", "-dc", str(path)], stdout=subprocess.PIPE)
        yield from csv.DictReader(io.TextIOWrapper(proc.stdout, encoding="utf-8", newline=""))
        if proc.wait():
            raise SystemExit(f"zstd failed on {path}")
    else:
        with path.open(newline="") as f:
            yield from csv.DictReader(f)


def main() -> None:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else next((p for p in DEFAULTS if p.exists()), None)
    if not path or not path.exists():
        raise SystemExit("No puzzle file. Download it first:\n  curl -L -o data/puzzles/lichess_db_puzzle.csv.zst "
                         "https://database.lichess.org/lichess_db_puzzle.csv.zst")
    tmp = puzzles.DB_PATH.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript(SCHEMA)
    t0 = time.time()
    seen = kept = bad = 0
    fams: Counter = Counter()
    variations: dict[str, list] = {}
    base: Counter = Counter()
    batch = []
    for r in rows(path):
        seen += 1
        tags = r["OpeningTags"].split()
        if len(tags) != 2:
            continue      # untagged (from move 20 on): not an opening puzzle
        moves = r["Moves"].split()
        themes = r["Themes"].split()
        try:
            a = puzzles.analyse(r["FEN"], moves, themes)
        except (ValueError, AttributeError, IndexError):
            bad += 1
            continue
        family, variation = tags
        fams[family] += 1
        variations.setdefault(variation, [family, 0])[1] += 1
        base[a["pattern"]] += 1
        batch.append((r["PuzzleId"], r["FEN"], r["Moves"], int(r["Rating"]), int(r["RatingDeviation"]),
                      int(r["Popularity"]), int(r["NbPlays"]), r["Themes"], family, variation, r["GameUrl"],
                      a["solver"], a["trigger"], a["answer"], a["pattern"]))
        kept += 1
        if len(batch) >= 20000:
            con.executemany(f"INSERT INTO puzzles VALUES ({','.join('?' * 15)})", batch)
            batch.clear()
            print(f"\r{seen:,} read, {kept:,} kept ({time.time() - t0:.0f} s)", end="", flush=True)
    con.executemany(f"INSERT INTO puzzles VALUES ({','.join('?' * 15)})", batch)
    con.executemany("INSERT INTO tags VALUES (?, 'family', NULL, ?)", fams.items())
    # a variation tag can equal its family's ("Caro-Kann_Defense" for the bare defence): the family row wins
    con.executemany("INSERT OR IGNORE INTO tags VALUES (?, 'variation', ?, ?)", [(v, f, n) for v, (f, n) in variations.items()])
    con.executemany("INSERT INTO pattern_base VALUES (?, ?)", base.items())
    con.executemany("INSERT INTO meta VALUES (?, ?)", [("source", path.name), ("built", time.strftime("%Y-%m-%d")),
                                                        ("read", str(seen)), ("kept", str(kept))])
    print(f"\nindexing…", flush=True)
    con.executescript(INDEXES)
    con.commit()
    con.execute("VACUUM")
    con.close()
    os.replace(tmp, puzzles.DB_PATH)
    print(f"{puzzles.DB_PATH}: {kept:,} puzzles of {seen:,} ({bad} unreadable), {len(fams)} families, "
          f"{len(variations)} variations, {len(base):,} patterns, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()

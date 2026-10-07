"""chess.com rapid ratings <-> Lichess ratings. The app speaks chess.com rapid (the user's scale: 10+5, nearly all
rapid); Maia was trained on Lichess games, so `core/maia.py` converts at the model's door and nothing else
sees a Lichess number.

The table is Chessiro's rapid converter (https://chessiro.com/chess-rating-converter, fetched 2026-10-07):
a survey of ~20,000 players active on both sites, rating deviation under 150. Self-reported, so expect
±100. Checked against one real pair: the user's chess.com 790 / Lichess 1246 (the table says ~1271).
Between points it interpolates; outside them it extends the end segment's slope, which is a guess: below
chess.com 815 there is little overlap between the sites (new Lichess accounts start at 1500).
"""

# (chess.com rapid, Lichess rapid)
RAPID = [(815, 1290), (995, 1425), (1170, 1555), (1340, 1680), (1420, 1740), (1500, 1795), (1580, 1850),
         (1655, 1905), (1730, 1960), (1800, 2015), (1870, 2065), (1935, 2115), (1995, 2165), (2110, 2260),
         (2215, 2355), (2300, 2445), (2375, 2530), (2430, 2615)]


def _interp(x: float, pts: list[tuple[float, float]]) -> float:
    if x <= pts[0][0]:
        (x0, y0), (x1, y1) = pts[0], pts[1]
    elif x >= pts[-1][0]:
        (x0, y0), (x1, y1) = pts[-2], pts[-1]
    else:
        i = next(i for i in range(1, len(pts)) if x <= pts[i][0])
        (x0, y0), (x1, y1) = pts[i - 1], pts[i]
    return y0 + (x - x0) * (y1 - y0) / (x1 - x0)


def to_lichess(chesscom: int) -> int:
    return round(_interp(chesscom, RAPID))


def to_chesscom(lichess: int) -> int:
    # the floor: the extended line goes below zero under Lichess ~750, and chess.com's floor is 100
    return max(100, round(_interp(lichess, [(b, a) for a, b in RAPID])))

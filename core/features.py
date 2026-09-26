"""Hard facts about a position or a move, extracted with python-chess.

The LLM is only allowed to narrate what these functions (and the engine) report,
so everything here should be verifiable, not a judgement call.
"""

import chess

VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
COLOR_NAME = {chess.WHITE: "white", chess.BLACK: "black"}


def piece_label(board: chess.Board, sq: chess.Square) -> str:
    p = board.piece_at(sq)
    return f"{chess.piece_name(p.piece_type)} on {chess.square_name(sq)}"


def material(board: chess.Board) -> dict:
    counts = {}
    for color in chess.COLORS:
        counts[COLOR_NAME[color]] = {
            chess.piece_name(pt): len(board.pieces(pt, color)) for pt in VALUES if pt != chess.KING
        }
    bal = sum(VALUES[p.piece_type] * (1 if p.color else -1) for p in board.piece_map().values())
    return {"counts": counts, "balance_white_pawns": bal}


def pawn_structure(board: chess.Board, color: chess.Color) -> dict:
    pawns = board.pieces(chess.PAWN, color)
    enemy = board.pieces(chess.PAWN, not color)
    files = [chess.square_file(s) for s in pawns]
    isolated, doubled, passed = [], [], []
    for sq in pawns:
        f, r = chess.square_file(sq), chess.square_rank(sq)
        if not any(abs(ff - f) == 1 for ff in files):
            isolated.append(chess.square_name(sq))
        if files.count(f) > 1:
            doubled.append(chess.square_name(sq))
        ahead = [
            e for e in enemy
            if abs(chess.square_file(e) - f) <= 1
            and (chess.square_rank(e) > r if color == chess.WHITE else chess.square_rank(e) < r)
        ]
        if not ahead:
            passed.append(chess.square_name(sq))
    return {"isolated": isolated, "doubled": sorted(set(doubled)), "passed": passed}


def files_status(board: chess.Board) -> dict:
    open_, half = [], {"white": [], "black": []}
    for f in range(8):
        mask = chess.BB_FILES[f]
        w = bool(board.pieces_mask(chess.PAWN, chess.WHITE) & mask)
        b = bool(board.pieces_mask(chess.PAWN, chess.BLACK) & mask)
        name = chess.FILE_NAMES[f]
        if not w and not b:
            open_.append(name)
        elif not w:
            half["white"].append(name)
        elif not b:
            half["black"].append(name)
    return {"open_files": open_, "half_open_for": half}


def king_safety(board: chess.Board, color: chess.Color) -> dict:
    ksq = board.king(color)
    if ksq is None:
        return {}
    kf, kr = chess.square_file(ksq), chess.square_rank(ksq)
    step = 1 if color == chess.WHITE else -1
    shield = 0
    for df in (-1, 0, 1):
        for dr in (1, 2):
            f, r = kf + df, kr + step * dr
            if 0 <= f < 8 and 0 <= r < 8:
                p = board.piece_at(chess.square(f, r))
                if p and p.piece_type == chess.PAWN and p.color == color:
                    shield += 1
                    break
    zone = chess.SquareSet(chess.BB_KING_ATTACKS[ksq]) | chess.SquareSet.from_square(ksq)
    attacked = sorted({chess.square_name(s) for s in zone if board.is_attacked_by(not color, s)})
    castled = (color == chess.WHITE and ksq in (chess.G1, chess.C1, chess.B1)) or \
              (color == chess.BLACK and ksq in (chess.G8, chess.C8, chess.B8))
    return {
        "king_square": chess.square_name(ksq),
        "castled_position": castled,
        "can_still_castle": board.has_castling_rights(color),
        "pawn_shield": f"{shield}/3",
        "king_zone_squares_attacked": attacked,
    }


def loose_pieces(board: chess.Board, color: chess.Color) -> list[str]:
    """Pieces of `color` that are attacked and either undefended or attacked by something cheaper."""
    out = []
    for sq, p in board.piece_map().items():
        if p.color != color or p.piece_type == chess.KING:
            continue
        attackers = board.attackers(not color, sq)
        if not attackers:
            continue
        defenders = board.attackers(color, sq)
        cheapest = min(VALUES[board.piece_at(a).piece_type] for a in attackers)
        if not defenders:
            out.append(f"{piece_label(board, sq)} (attacked, undefended)")
        elif cheapest < VALUES[p.piece_type]:
            out.append(f"{piece_label(board, sq)} (attacked by a cheaper piece)")
    return out


def outposts(board: chess.Board, color: chess.Color) -> list[str]:
    """Knights/bishops in enemy half, defended by a pawn, not challengeable by enemy pawns."""
    out = []
    enemy_pawns = board.pieces(chess.PAWN, not color)
    for pt in (chess.KNIGHT, chess.BISHOP):
        for sq in board.pieces(pt, color):
            r, f = chess.square_rank(sq), chess.square_file(sq)
            if (color == chess.WHITE and r < 4) or (color == chess.BLACK and r > 3):
                continue
            pawn_defended = any(board.piece_at(a).piece_type == chess.PAWN for a in board.attackers(color, sq))
            challengeable = any(
                abs(chess.square_file(e) - f) == 1
                and (chess.square_rank(e) > r if color == chess.WHITE else chess.square_rank(e) < r)
                for e in enemy_pawns
            )
            if pawn_defended and not challengeable:
                out.append(piece_label(board, sq))
    return out


def undeveloped(board: chess.Board, color: chess.Color) -> list[str]:
    home = chess.BB_RANK_1 if color == chess.WHITE else chess.BB_RANK_8
    return [
        piece_label(board, sq)
        for pt in (chess.KNIGHT, chess.BISHOP)
        for sq in board.pieces(pt, color)
        if chess.BB_SQUARES[sq] & home
    ]


def describe(board: chess.Board) -> dict:
    d = {
        "fen": board.fen(),
        "side_to_move": COLOR_NAME[board.turn],
        "in_check": board.is_check(),
        "material": material(board),
        "files": files_status(board),
    }
    for color in chess.COLORS:
        name = COLOR_NAME[color]
        d[name] = {
            "pawns": pawn_structure(board, color),
            "king": king_safety(board, color),
            "loose_pieces": loose_pieces(board, color),
            "outposts": outposts(board, color),
        }
        if board.fullmove_number <= 15:
            d[name]["undeveloped_minors"] = undeveloped(board, color)
    return d


def _attacked_enemies(board: chess.Board, color: chess.Color) -> set[chess.Square]:
    return {
        sq for sq, p in board.piece_map().items()
        if p.color != color and board.is_attacked_by(color, sq)
    }


def _pinned(board: chess.Board, color: chess.Color) -> set[chess.Square]:
    return {sq for sq, p in board.piece_map().items() if p.color == color and board.is_pinned(color, sq)}


def move_effects(board: chess.Board, move: chess.Move) -> dict:
    """What a move concretely changes. `board` is the position *before* the move."""
    mover = board.turn
    after = board.copy(stack=False)
    after.push(move)
    moved = after.piece_at(move.to_square)

    new_targets = _attacked_enemies(after, mover) - _attacked_enemies(board, mover)
    direct = {s for s in after.attacks(move.to_square) if after.piece_at(s) and after.piece_at(s).color != mover}
    discovered = new_targets - direct

    newly_pinned = _pinned(after, not mover) - _pinned(board, not mover)
    newly_hanging_own = set(loose_pieces(after, mover)) - set(loose_pieces(board, mover))

    pb, pa = pawn_structure(board, mover), pawn_structure(after, mover)
    eb, ea = pawn_structure(board, not mover), pawn_structure(after, not mover)
    structure = {}
    for label, before_, after_ in (("own", pb, pa), ("opponent", eb, ea)):
        for k in before_:
            added = sorted(set(after_[k]) - set(before_[k]))
            if added:
                structure[f"{label}_new_{k}_pawns"] = added

    return {
        "move": board.san(move),
        "piece": chess.piece_name(moved.piece_type) if moved else None,
        "from": chess.square_name(move.from_square),
        "to": chess.square_name(move.to_square),
        "capture": piece_label(board, move.to_square) if board.is_capture(move) and board.piece_at(move.to_square) else
                   ("pawn en passant" if board.is_en_passant(move) else None),
        "check": after.is_check(),
        "castling": board.is_castling(move),
        "moved_piece_now_attacks": sorted(piece_label(after, s) for s in direct),
        "discovered_attacks_on": sorted(piece_label(after, s) for s in discovered),
        "pins_created": sorted(piece_label(after, s) for s in newly_pinned),
        "own_pieces_left_loose": sorted(newly_hanging_own),
        "structure_changes": structure,
        "moved_piece_on_outpost": any(chess.square_name(move.to_square) in o for o in outposts(after, mover)),
    }

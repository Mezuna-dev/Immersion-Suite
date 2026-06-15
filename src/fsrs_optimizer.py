"""
FSRS-6 parameter optimiser (numpy).

Trains the 21 FSRS weights on a deck's review history by minimising the binary
cross-entropy between predicted retrievability and actual recall on cross-day
reviews. Uses a vectorised forward pass (all cards advanced timestep-by-timestep)
and Adam in normalised parameter space with central finite-difference gradients,
clamped to the FSRS bounds.

This is a lighter, dependency-minimal alternative to the reference torch optimiser
(`fsrs.Optimizer`); it is adequate for an offline, backgrounded, occasional run on a
personal collection. The forget/recall/short-term math matches src/fsrs.py exactly.
"""
from collections import defaultdict
from datetime import date
import numpy as np

import database
import fsrs

MIN_REVIEWS = 400          # below this, optimisation isn't meaningful
DEFAULT_ITERATIONS = 80


def build_sequences(deck_ids):
    """Per-card ordered [(day_ordinal, grade), ...] from the review log (Rating>=1)."""
    con = database.create_db_connection()
    cur = con.cursor()
    placeholders = ','.join('?' * len(deck_ids))
    cur.execute(f"""
        SELECT r.Card_ID, r.Review_Date, r.Rating
        FROM Review r JOIN Card c ON r.Card_ID = c.ID
        WHERE c.Deck_ID IN ({placeholders}) AND r.Rating >= 1
        ORDER BY r.Card_ID, r.Review_Date, r.ID
    """, list(deck_ids))
    rows = cur.fetchall()
    con.close()

    seqs = defaultdict(list)
    for card_id, rdate, rating in rows:
        try:
            ordinal = date.fromisoformat(rdate).toordinal()
        except (ValueError, TypeError):
            continue
        seqs[card_id].append((ordinal, fsrs.to_grade(rating)))
    # Need at least one cross-day transition to carry any training signal.
    return [s for s in seqs.values() if len(s) >= 2]


def _pack(sequences):
    """Pad sequences into (grades, elapsed) arrays of shape (C, T).
    grades: 0 = padding, else 1..4. elapsed: days since previous review (-1 = first)."""
    C = len(sequences)
    T = max(len(s) for s in sequences)
    grades = np.zeros((C, T), dtype=np.int64)
    elapsed = np.full((C, T), -1.0)
    for i, seq in enumerate(sequences):
        prev = None
        for t, (ordinal, g) in enumerate(seq):
            grades[i, t] = g
            elapsed[i, t] = -1.0 if prev is None else max(0.0, ordinal - prev)
            prev = ordinal
    return grades, elapsed


def _loss(w, grades, elapsed):
    """Mean BCE of predicted recall vs actual on cross-day reviews (lower is better)."""
    p = np.asarray(w, dtype=np.float64)
    decay = -p[20]
    factor = 0.9 ** (1.0 / decay) - 1.0
    C, T = grades.shape
    S = np.full(C, np.nan)
    D = np.full(C, np.nan)
    target = p[4] - np.exp(p[5] * 3.0) + 1.0   # unclamped initial difficulty of Easy
    total = 0.0
    n = 0
    eps = 1e-10
    with np.errstate(over='ignore', invalid='ignore', divide='ignore'):
        for t in range(T):
            gi = grades[:, t]
            valid = gi > 0
            if not valid.any():
                continue
            g = gi.astype(np.float64)
            e = elapsed[:, t]
            seen = ~np.isnan(S)
            first = valid & ~seen
            rep = valid & seen
            sameday = rep & (e < 1)
            crossday = rep & (e >= 1)

            Ssafe = np.where(seen, S, 1.0)
            Dsafe = np.where(seen, D, 1.0)

            # --- loss on cross-day reviews, using pre-update stability ---
            if crossday.any():
                R = np.clip((1.0 + factor * e / Ssafe) ** decay, eps, 1.0 - eps)
                label = (gi >= 2).astype(np.float64)
                bce = -(label * np.log(R) + (1.0 - label) * np.log(1.0 - R))
                total += float(np.sum(bce[crossday]))
                n += int(crossday.sum())

            # --- candidate updates, all from pre-update S/D ---
            initS = np.maximum(np.take(p, np.clip(gi - 1, 0, 20)), 0.001)
            initD = np.clip(p[4] - np.exp(p[5] * (g - 1.0)) + 1.0, 1.0, 10.0)

            delta = -(p[6] * (g - 3.0))
            damped = Dsafe + (10.0 - Dsafe) * delta / 9.0
            repD = np.clip(p[7] * target + (1.0 - p[7]) * damped, 1.0, 10.0)

            inc = np.exp(p[17] * (g - 3.0 + p[18])) * np.power(Ssafe, -p[19])
            inc = np.where(g >= 3, np.maximum(inc, 1.0), inc)
            stS = np.maximum(Ssafe * inc, 0.001)

            R2 = np.where(Ssafe > 0, (1.0 + factor * e / Ssafe) ** decay, 0.0)
            hard = np.where(g == 2, p[15], 1.0)
            easy = np.where(g == 4, p[16], 1.0)
            recall = Ssafe * (1.0 + np.exp(p[8]) * (11.0 - Dsafe) * np.power(Ssafe, -p[9])
                              * (np.exp((1.0 - R2) * p[10]) - 1.0) * hard * easy)
            longf = (p[11] * np.power(Dsafe, -p[12]) * (np.power(Ssafe + 1.0, p[13]) - 1.0)
                     * np.exp((1.0 - R2) * p[14]))
            shortf = Ssafe / np.exp(p[17] * p[18])
            forget = np.minimum(longf, shortf)
            crossS = np.maximum(np.where(g == 1, forget, recall), 0.001)

            # --- commit by state mask ---
            newS, newD = S.copy(), D.copy()
            newS = np.where(first, initS, newS)
            newD = np.where(first, initD, newD)
            newS = np.where(sameday, stS, newS)
            newD = np.where(sameday, repD, newD)
            newS = np.where(crossday, crossS, newS)
            newD = np.where(crossday, repD, newD)
            S, D = newS, newD

    if n == 0:
        return float('inf')
    val = total / n
    return val if np.isfinite(val) else float('inf')


def optimize(deck_ids, on_progress=None, iterations=DEFAULT_ITERATIONS):
    """Train weights for the given decks. Returns (params_list, review_count), or
    (None, review_count) when there isn't enough history to optimise."""
    sequences = build_sequences(deck_ids)
    review_count = sum(len(s) for s in sequences)
    if review_count < MIN_REVIEWS:
        return None, review_count

    grades, elapsed = _pack(sequences)
    lo = np.asarray(fsrs.LOWER_BOUNDS, dtype=np.float64)
    hi = np.asarray(fsrs.UPPER_BOUNDS, dtype=np.float64)
    span = hi - lo
    w0 = np.asarray(fsrs.DEFAULT_PARAMS, dtype=np.float64)

    # Optimise in normalised [0,1] space so one learning rate fits all 21 scales.
    x = (w0 - lo) / span
    def loss_x(xx):
        return _loss(lo + np.clip(xx, 0.0, 1.0) * span, grades, elapsed)

    m = np.zeros(21)
    v = np.zeros(21)
    lr, b1, b2, eps, h = 0.05, 0.9, 0.999, 1e-8, 1e-3
    best_x = x.copy()
    best_l = loss_x(x)

    for it in range(iterations):
        grad = np.zeros(21)
        for j in range(21):
            xj = x.copy(); xj[j] += h; lp = loss_x(xj)
            xj[j] -= 2 * h; lm = loss_x(xj)
            grad[j] = (lp - lm) / (2 * h)
        m = b1 * m + (1 - b1) * grad
        v = b2 * v + (1 - b2) * grad * grad
        mh = m / (1 - b1 ** (it + 1))
        vh = v / (1 - b2 ** (it + 1))
        x = np.clip(x - lr * mh / (np.sqrt(vh) + eps), 0.0, 1.0)
        cur = loss_x(x)
        if cur < best_l:
            best_l, best_x = cur, x.copy()
        if on_progress:
            on_progress(it + 1, iterations, float(best_l))

    best_w = lo + best_x * span
    return [round(float(val), 6) for val in best_w], review_count

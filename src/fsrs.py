"""
FSRS-6 memory-state math, mirroring the reference py-fsrs implementation.

This module computes the FSRS-6 memory state (Stability, Difficulty) and the next
review interval. It deliberately does NOT own the learning/relearning *step* state
machine: the app keeps its existing queue model and fixed steps (see
src/widgets/app_widget.py + web/pages/app.js). FSRS only governs the per-press
memory-state update and the graduated/review interval.

Formulas are a 1:1 port of fsrs.scheduler (py-fsrs); verified against
`pip install fsrs` (see the oracle test in the plan's Verification section).
Fuzzing is intentionally omitted so the JS button-label preview can match the
scheduled interval exactly. Keep in sync with `fsrsPreview()` in web/pages/app.js.
"""
from datetime import date
import math

# FSRS-6 default weights (21). w[20] is the learnable decay.
DEFAULT_PARAMS = (
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
    0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425,
    0.0912, 0.0658, 0.1542,
)

# Per-weight optimiser bounds (from the reference implementation).
LOWER_BOUNDS = (
    0.001, 0.001, 0.001, 0.001, 1.0, 0.001, 0.001, 0.001, 0.0, 0.0, 0.001,
    0.001, 0.001, 0.001, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.1,
)
UPPER_BOUNDS = (
    100.0, 100.0, 100.0, 100.0, 10.0, 4.0, 4.0, 0.75, 4.5, 0.8, 3.5, 5.0,
    0.25, 0.9, 4.0, 1.0, 6.0, 2.0, 2.0, 0.8, 0.8,
)

STABILITY_MIN = 0.001
MIN_DIFFICULTY = 1.0
MAX_DIFFICULTY = 10.0
MAX_INTERVAL = 36500

# UI rating (1/3/4/5 = Again/Hard/Good/Easy) -> FSRS grade (1..4).
_RATING_TO_GRADE = {1: 1, 3: 2, 4: 3, 5: 4}


def to_grade(rating):
    """Map a UI rating (1,3,4,5) to an FSRS grade (1..4); defaults to Good."""
    return _RATING_TO_GRADE.get(rating, 3)


def _clamp(x, lo, hi):
    return min(max(x, lo), hi)


def _decay_factor(params):
    decay = -params[20]
    factor = 0.9 ** (1.0 / decay) - 1.0
    return decay, factor


def retrievability(elapsed_days, stability, params):
    """Predicted recall probability after `elapsed_days` at the given stability."""
    if not stability or stability <= 0:
        return 0.0
    decay, factor = _decay_factor(params)
    t = max(0, elapsed_days)
    return (1.0 + factor * t / stability) ** decay


def next_interval(stability, desired_retention, params, maximum_interval=MAX_INTERVAL):
    """Whole-day interval that lands the card at `desired_retention`."""
    decay, factor = _decay_factor(params)
    ivl = (stability / factor) * (desired_retention ** (1.0 / decay) - 1.0)
    return int(_clamp(round(ivl), 1, maximum_interval))


def initial_stability(grade, params):
    return max(params[grade - 1], STABILITY_MIN)


def initial_difficulty(grade, params, clamp=True):
    d = params[4] - math.e ** (params[5] * (grade - 1)) + 1.0
    return _clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY) if clamp else d


def next_difficulty(difficulty, grade, params):
    # Mean-reversion target is the *unclamped* initial difficulty of Easy (grade 4).
    target = initial_difficulty(4, params, clamp=False)
    delta = -(params[6] * (grade - 3))
    damped = difficulty + (10.0 - difficulty) * delta / 9.0
    d = params[7] * target + (1.0 - params[7]) * damped
    return _clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY)


def short_term_stability(stability, grade, params):
    inc = (math.e ** (params[17] * (grade - 3 + params[18]))) * (stability ** -params[19])
    if grade >= 3:  # Good/Easy never shrink stability on a same-day review
        inc = max(inc, 1.0)
    return max(stability * inc, STABILITY_MIN)


def _recall_stability(difficulty, stability, r, grade, params):
    hard_penalty = params[15] if grade == 2 else 1.0
    easy_bonus = params[16] if grade == 4 else 1.0
    return stability * (
        1.0
        + (math.e ** params[8])
        * (11.0 - difficulty)
        * (stability ** -params[9])
        * ((math.e ** ((1.0 - r) * params[10])) - 1.0)
        * hard_penalty
        * easy_bonus
    )


def _forget_stability(difficulty, stability, r, params):
    long_term = (
        params[11]
        * (difficulty ** -params[12])
        * (((stability + 1.0) ** params[13]) - 1.0)
        * (math.e ** ((1.0 - r) * params[14]))
    )
    short_term = stability / (math.e ** (params[17] * params[18]))
    return min(long_term, short_term)


def next_stability(difficulty, stability, r, grade, params):
    if grade == 1:
        s = _forget_stability(difficulty, stability, r, params)
    else:
        s = _recall_stability(difficulty, stability, r, grade, params)
    return max(s, STABILITY_MIN)


def apply(stability, difficulty, grade, elapsed_days, params):
    """Return the updated (stability, difficulty) for one press.

    - First-ever review (no prior state): initial S0/D0 from the grade.
    - Same-day review (elapsed_days < 1): short-term stability update.
    - Cross-day review: recall/forget stability update via retrievability.
    """
    if stability is None or difficulty is None:
        return initial_stability(grade, params), initial_difficulty(grade, params)
    if elapsed_days is not None and elapsed_days < 1:
        return (short_term_stability(stability, grade, params),
                next_difficulty(difficulty, grade, params))
    r = retrievability(elapsed_days, stability, params) if elapsed_days is not None else 0.0
    return (next_stability(difficulty, stability, r, grade, params),
            next_difficulty(difficulty, grade, params))


def replay(reviews, params):
    """Fold `apply` over an ordered review history to reconstruct (S, D).

    `reviews` is an iterable of (review_date, rating): review_date is a
    'YYYY-MM-DD' string or a date, rating is a UI rating (1/3/4/5). Legacy
    rating-0 intro markers should be filtered out by the caller. Returns
    (None, None) when there is no usable history.
    """
    stability = None
    difficulty = None
    prev = None
    for review_date, rating in reviews:
        d = review_date if isinstance(review_date, date) else date.fromisoformat(review_date)
        elapsed = None if prev is None else max(0, (d - prev).days)
        stability, difficulty = apply(stability, difficulty, to_grade(rating), elapsed, params)
        prev = d
    return stability, difficulty

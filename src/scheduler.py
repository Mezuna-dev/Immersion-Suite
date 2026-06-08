from datetime import date, timedelta
import math

# Per-rating interval modifiers (Anki-style). Hard shrinks the growth, Easy boosts it,
# so the Hard/Good/Easy buttons schedule (and display) distinct intervals.
HARD_MULTIPLIER = 1.2
EASY_BONUS = 1.3
EASY_GRADUATING_INTERVAL = 4  # days, when a fresh card is graduated with Easy
EASE_FLOOR = 1.3
LAPSE_EASE_PENALTY = 0.20

def calculate_next_review(reps, ease_factor, interval, rating, reference_date=None, adjust_ease=True):
    """Compute the next SRS state for a passing/failing review.

    adjust_ease=False keeps the ease factor unchanged on a passing review. This is
    used when graduating out of relearning: ease was already dropped at lapse time
    (Anki freezes ease during relearning), so it must not be nudged a second time.
    """

    todays_date = reference_date if reference_date is not None else date.today()

    if rating < 3:
        # Failure: reset progress to a 1-day interval and drop ease (Anki-style lapse).
        new_reps = 0
        new_interval = 1
        new_ease_factor = max(EASE_FLOOR, ease_factor - LAPSE_EASE_PENALTY)
    else:
        if reps == 0:
            # Graduating a fresh card. Easy jumps further out than Good/Hard.
            new_interval = EASY_GRADUATING_INTERVAL if rating == 5 else 1
        elif reps == 1:
            # Second successful review: 6 days, with an Easy bonus.
            new_interval = math.ceil(6 * EASY_BONUS) if rating == 5 else 6
        else:
            if rating == 3:      # Hard
                new_interval = math.ceil(interval * HARD_MULTIPLIER)
            elif rating == 4:    # Good
                new_interval = math.ceil(interval * ease_factor)
            else:                # Easy
                new_interval = math.ceil(interval * ease_factor * EASY_BONUS)
            # Every interval must grow by at least a day so reviews keep moving out.
            new_interval = max(interval + 1, new_interval)

        new_reps = reps + 1

        if adjust_ease:
            new_ease_factor = ease_factor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))
        else:
            new_ease_factor = ease_factor

        if new_ease_factor < EASE_FLOOR:
            new_ease_factor = EASE_FLOOR

    due_date = (todays_date + timedelta(days=new_interval)).strftime('%Y-%m-%d')

    return new_reps, new_ease_factor, new_interval, due_date
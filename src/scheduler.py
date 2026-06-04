from datetime import date, timedelta
import math

def calculate_next_review(reps, ease_factor, interval, rating, reference_date=None):

    todays_date = reference_date if reference_date is not None else date.today()

    if rating < 3:
        new_reps = 0
        new_interval = 1
        new_ease_factor = ease_factor
    elif rating >=3:
        if reps == 0:
            new_interval = 1
        elif reps == 1:
            new_interval = 6
        elif reps > 1:
            new_interval = max(1, math.ceil(interval * ease_factor))
        
        new_reps = reps + 1

        new_ease_factor = ease_factor + (0.1 - (5 - rating) * (0.08 + (5 - rating) * 0.02))

        if new_ease_factor < 1.3:
            new_ease_factor = 1.3
    
    due_date = (todays_date + timedelta(days=new_interval)).strftime('%Y-%m-%d')

    return new_reps, new_ease_factor, new_interval, due_date
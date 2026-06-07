
class Deck:
    def __init__(self, id, name, date_created, new_cards_limit, description=None, learning_steps='1 10', relearning_steps='10', study_order='new_first', answer_display='replace', parent_id=None, position=0) -> None:
        self.id = id
        self.name = name
        self.date_created = date_created
        self.new_cards_limit = new_cards_limit
        self.description = description
        self.learning_steps = learning_steps or '1 10'
        self.relearning_steps = relearning_steps or '10'
        self.study_order = study_order or 'new_first'
        self.answer_display = answer_display or 'replace'
        self.parent_id = parent_id
        self.position = position
    def __repr__(self) -> str:
        return f"\nId: {self.id}\nName: {self.name}\nDate Created: {self.date_created}\nNew Cards Limit: {self.new_cards_limit}\nDescription: {self.description}\nLearning Steps: {self.learning_steps}\nRelearning Steps: {self.relearning_steps}\nStudy Order: {self.study_order}\nAnswer Display: {self.answer_display}\nParent ID: {self.parent_id}\n"
    
class CardType:
    def __init__(self, id, name, fields, date_created, is_default=False, front_style='', back_style='', css_style='') -> None:
        self.id = id
        self.name = name
        self.fields = fields  # list of str, already parsed from JSON
        self.date_created = date_created
        self.is_default = bool(is_default)
        self.front_style = front_style or ''
        self.back_style = back_style or ''
        self.css_style = css_style or ''

    def __repr__(self) -> str:
        return f"\nId: {self.id}\nName: {self.name}\nFields: {self.fields}\nDate Created: {self.date_created}\nIs Default: {self.is_default}\n"

class Card:
    def __init__(self, id, deck_id, card_front, card_back, reps,
            ease_factor, interval, due_date, is_new, date_created, last_reviewed, card_type_id=None, fields_json=None, learning_step=None) -> None:
        self.id = id
        self.deck_id = deck_id
        self.card_front = card_front
        self.card_back = card_back
        self.reps = reps
        self.ease_factor = ease_factor
        self.interval = interval
        self.due_date = due_date
        self.is_new = is_new
        self.date_created = date_created
        self.last_reviewed = last_reviewed
        self.card_type_id = card_type_id
        self.fields_json = fields_json
        self.learning_step = learning_step

    def __repr__(self) -> str:
        return f"\nId: {self.id}\nDeck Id: {self.deck_id}\nFront: {self.card_front}\n \
        Back: {self.card_back}\nReps: {self.reps}\nEase Factor: {self.ease_factor}\n \
        Interval: {self.interval}\nDue Date: {self.due_date}\nIs New: {self.is_new}\n \
        Date Created: {self.date_created}\nLast Reviewed: {self.last_reviewed}\n"

class ImmersionCategory:
    def __init__(self, id, name, color, date_created) -> None:
        self.id = id
        self.name = name
        self.color = color
        self.date_created = date_created

    def __repr__(self) -> str:
        return f"\nId: {self.id}\nName: {self.name}\nColor: {self.color}\nDate Created: {self.date_created}\n"

class ImmersionLog:
    def __init__(self, id, category_id, duration_seconds, log_date, date_created) -> None:
        self.id = id
        self.category_id = category_id
        self.duration_seconds = duration_seconds
        self.log_date = log_date
        self.date_created = date_created

    def __repr__(self) -> str:
        return f"\nId: {self.id}\nCategory ID: {self.category_id}\nDuration: {self.duration_seconds}s\nLog Date: {self.log_date}\n"

from pathlib import Path
from datetime import date, datetime, timedelta
import sqlite3
import json
import models

# ===========================================================
# Section: Create Database File and Directory
# ===========================================================

import sys as _sys
import os as _os
if getattr(_sys, 'frozen', False):
    if _sys.platform == 'win32':
        # Windows: keep user data next to the executable
        BASE_DIR = Path(_sys.executable).resolve().parent
    else:
        # Linux/macOS: executable may be inside a read-only AppImage mount;
        # follow XDG Base Directory spec for user data
        _xdg = _os.environ.get('XDG_DATA_HOME', '')
        BASE_DIR = Path(_xdg) / 'ImmersionSuite' if _xdg else Path.home() / '.local' / 'share' / 'ImmersionSuite'
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
Path(f"{BASE_DIR}/data").mkdir(parents=True, exist_ok=True)
DB_PATH = BASE_DIR / 'data' / 'app.db'
SETTINGS_PATH = BASE_DIR / 'data' / 'settings.json'

DEFAULT_SETTINGS = {
    'accent_color': '#9067C6',
    'font_size': 'medium',
    'default_new_cards_limit': 15,
    'default_learning_steps': '1 10',
    'default_relearning_steps': '10',
    'default_study_order': 'new_first',
    'review_autoplay_audio': True,
    'review_shortcut_enabled': True,
    'review_shortcut_key': 'Space',
    'review_two_button_mode': False,
    'day_start_hour': 4,
    'update_check_enabled': True,
    'skipped_update_version': '',
}

def get_app_settings() -> dict:
    if SETTINGS_PATH.exists():
        try:
            with open(SETTINGS_PATH, 'r') as f:
                data = json.load(f)
            return {**DEFAULT_SETTINGS, **data}
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)

def save_app_settings(settings: dict):
    with open(SETTINGS_PATH, 'w') as f:
        json.dump(settings, f, indent=2)

def get_srs_today() -> date:
    """Return the current SRS day based on the day_start_hour setting.

    If the current time is before day_start_hour, the SRS day is still
    yesterday.  For example with day_start_hour=4, reviews done at 2 AM
    count toward the previous day and cards due "today" are those due by
    yesterday's date.
    """
    settings = get_app_settings()
    hour = settings.get('day_start_hour', 4)
    now = datetime.now()
    if now.hour < hour:
        return (now - timedelta(days=1)).date()
    return now.date()

def create_db_connection():
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA foreign_keys = ON;")
    return con

# ===========================================================
# Section: Database Initialization
# ===========================================================

# Check for database
def db_exists(table_name: str):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name=?
    """, (table_name,))
    result = cur.fetchone()
    con.close()
    return result

# Initialize Database tables if not present
def initialize_database():
    initialized_tables = db_exists("Deck")

    if initialized_tables is None:
        con = create_db_connection()
        cur = con.cursor()

        # Deck Table
        cur.execute("""
            CREATE TABLE Deck (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                Date_Created TEXT NOT NULL,
                New_Cards_Limit INTEGER NOT NULL DEFAULT 15,
                Description TEXT,
                Learning_Steps TEXT DEFAULT '1 10',
                Relearning_Steps TEXT DEFAULT '10',
                Study_Order TEXT DEFAULT 'new_first',
                Answer_Display TEXT DEFAULT 'replace',
                Parent_ID INTEGER,
                Position INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (Parent_ID) REFERENCES Deck(ID)
                )
        """)

        # CardType Table
        cur.execute("""
            CREATE TABLE CardType (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL UNIQUE,
                Fields TEXT NOT NULL,
                Date_Created TEXT NOT NULL,
                Is_Default INTEGER NOT NULL DEFAULT 0,
                Front_Style TEXT DEFAULT '',
                Back_Style TEXT DEFAULT '',
                CSS_Style TEXT DEFAULT ''
                )
        """)

        # Card Table
        cur.execute("""
            CREATE TABLE Card (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Deck_ID INT NOT NULL,
                Card_Front TEXT NOT NULL,
                Card_Back TEXT NOT NULL,
                Reps INT NOT NULL DEFAULT 0,
                Ease_Factor FLOAT NOT NULL DEFAULT 2.5,
                Interval INT NOT NULL DEFAULT 0,
                Due_Date TEXT,
                Is_New BOOL NOT NULL DEFAULT 1,
                Date_Created TEXT NOT NULL,
                Last_Reviewed TEXT,
                Card_Type_ID INTEGER,
                Fields TEXT,
                Learning_Step INTEGER,
                FOREIGN KEY (Deck_ID) REFERENCES Deck(ID),
                FOREIGN KEY (Card_Type_ID) REFERENCES CardType(ID)
                )
        """)

        # Review Table
        cur.execute("""
            CREATE TABLE Review ( 
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT, 
                Card_ID INT NOT NULL,
                Review_Date TEXT NOT NULL,
                Rating INT NOT NULL,
                Interval_After INT NOT NULL,
                Ease_Factor_After FLOAT NOT NULL,
                FOREIGN KEY (Card_ID) REFERENCES Card(ID)
                )
        """)

        # ImmersionCategory Table
        cur.execute("""
            CREATE TABLE ImmersionCategory (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                Color TEXT NOT NULL DEFAULT '#9067C6',
                Date_Created TEXT NOT NULL
                )
        """)

        # ImmersionLog Table
        cur.execute("""
            CREATE TABLE ImmersionLog (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Category_ID INTEGER NOT NULL,
                Duration_Seconds INTEGER NOT NULL,
                Log_Date TEXT NOT NULL,
                Date_Created TEXT NOT NULL,
                FOREIGN KEY (Category_ID) REFERENCES ImmersionCategory(ID)
                )
        """)

        # MediaCategory Table
        cur.execute("""
            CREATE TABLE MediaCategory (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Name TEXT NOT NULL,
                Color TEXT NOT NULL DEFAULT '#9067C6',
                Date_Created TEXT NOT NULL
                )
        """)

        # MediaEntry Table (legacy)
        cur.execute("""
            CREATE TABLE MediaEntry (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Title TEXT NOT NULL,
                Category_ID INTEGER,
                Duration_Seconds INTEGER,
                Entry_Date TEXT NOT NULL,
                Date_Created TEXT NOT NULL,
                FOREIGN KEY (Category_ID) REFERENCES MediaCategory(ID)
                )
        """)

        # MediaItem Table
        cur.execute("""
            CREATE TABLE MediaItem (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Title TEXT NOT NULL,
                Category_ID INTEGER,
                Status TEXT NOT NULL DEFAULT 'plan_to_watch',
                Progress TEXT,
                Progress_Max TEXT,
                Notes TEXT,
                Date_Started TEXT,
                Date_Finished TEXT,
                Date_Created TEXT NOT NULL,
                FOREIGN KEY (Category_ID) REFERENCES MediaCategory(ID)
                )
        """)

        # MediaSession Table
        cur.execute("""
            CREATE TABLE MediaSession (
                ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
                Item_ID INTEGER NOT NULL,
                Duration_Seconds INTEGER,
                Progress_Note TEXT,
                Session_Date TEXT NOT NULL,
                Date_Created TEXT NOT NULL,
                FOREIGN KEY (Item_ID) REFERENCES MediaItem(ID)
                )
        """)

        con.commit()
        con.close()
        seed_default_card_type()
        seed_mining_card_types()
        seed_default_immersion_categories()
        seed_default_media_categories()


def migrate_database():
    con = create_db_connection()
    cur = con.cursor()
    for stmt in [
        "ALTER TABLE Deck ADD COLUMN Learning_Steps TEXT DEFAULT '1 10'",
        "ALTER TABLE Card ADD COLUMN Learning_Step INTEGER",
        "ALTER TABLE Deck ADD COLUMN Relearning_Steps TEXT DEFAULT '10'",
        "ALTER TABLE Deck ADD COLUMN Study_Order TEXT DEFAULT 'new_first'",
        "ALTER TABLE Deck ADD COLUMN Answer_Display TEXT DEFAULT 'replace'",
        "ALTER TABLE Deck ADD COLUMN Parent_ID INTEGER REFERENCES Deck(ID)",
        "ALTER TABLE Deck ADD COLUMN Position INTEGER NOT NULL DEFAULT 0",
    ]:
        try:
            cur.execute(stmt)
            con.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists

    # Back-fill positions for existing decks that still have the default 0.
    # Group siblings by Parent_ID and assign positions alphabetically.
    cur.execute("SELECT COUNT(*) FROM Deck WHERE Position != 0")
    if cur.fetchone()[0] == 0:
        cur.execute("SELECT ID, Name, Parent_ID FROM Deck ORDER BY Name COLLATE NOCASE")
        groups = {}
        for row in cur.fetchall():
            groups.setdefault(row[2], []).append(row[0])
        for pid, ids in groups.items():
            for pos, did in enumerate(ids):
                cur.execute("UPDATE Deck SET Position = ? WHERE ID = ?", (pos, did))
        con.commit()

    # Create ImmersionCategory table if missing (for existing DBs)
    for tbl_stmt in [
        """CREATE TABLE IF NOT EXISTS ImmersionCategory (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Name TEXT NOT NULL,
            Color TEXT NOT NULL DEFAULT '#9067C6',
            Date_Created TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS ImmersionLog (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Category_ID INTEGER NOT NULL,
            Duration_Seconds INTEGER NOT NULL,
            Log_Date TEXT NOT NULL,
            Date_Created TEXT NOT NULL,
            FOREIGN KEY (Category_ID) REFERENCES ImmersionCategory(ID)
        )""",
        """CREATE TABLE IF NOT EXISTS MediaCategory (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Name TEXT NOT NULL,
            Color TEXT NOT NULL DEFAULT '#9067C6',
            Date_Created TEXT NOT NULL
        )""",
        """CREATE TABLE IF NOT EXISTS MediaEntry (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Title TEXT NOT NULL,
            Category_ID INTEGER,
            Duration_Seconds INTEGER,
            Entry_Date TEXT NOT NULL,
            Date_Created TEXT NOT NULL,
            FOREIGN KEY (Category_ID) REFERENCES MediaCategory(ID)
        )""",
        """CREATE TABLE IF NOT EXISTS MediaItem (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Title TEXT NOT NULL,
            Category_ID INTEGER,
            Status TEXT NOT NULL DEFAULT 'plan_to_watch',
            Progress TEXT,
            Progress_Max TEXT,
            Notes TEXT,
            Date_Started TEXT,
            Date_Finished TEXT,
            Date_Created TEXT NOT NULL,
            FOREIGN KEY (Category_ID) REFERENCES MediaCategory(ID)
        )""",
        """CREATE TABLE IF NOT EXISTS MediaSession (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Item_ID INTEGER NOT NULL,
            Duration_Seconds INTEGER,
            Progress_Note TEXT,
            Session_Date TEXT NOT NULL,
            Date_Created TEXT NOT NULL,
            FOREIGN KEY (Item_ID) REFERENCES MediaItem(ID)
        )""",
        # Words with a manual status, independent of the SRS deck. Status is
        # 'known' (count toward comprehension) or 'ignored' (excluded from it).
        # Used by the browser extension to colour text and estimate comprehension.
        """CREATE TABLE IF NOT EXISTS KnownWord (
            ID INTEGER NOT NULL UNIQUE PRIMARY KEY AUTOINCREMENT,
            Term TEXT NOT NULL UNIQUE,
            Status TEXT NOT NULL DEFAULT 'known',
            Date_Created TEXT NOT NULL
        )""",
    ]:
        try:
            cur.execute(tbl_stmt)
            con.commit()
        except sqlite3.OperationalError:
            pass

    # Add the Status column to KnownWord tables created before it existed.
    try:
        cur.execute("ALTER TABLE KnownWord ADD COLUMN Status TEXT NOT NULL DEFAULT 'known'")
        con.commit()
    except sqlite3.OperationalError:
        pass  # column already present

    # Migrate legacy MediaEntry rows into MediaItem + MediaSession
    cur.execute("SELECT COUNT(*) FROM MediaItem")
    if cur.fetchone()[0] == 0:
        cur.execute("SELECT COUNT(*) FROM MediaEntry")
        if cur.fetchone()[0] > 0:
            cur.execute("SELECT ID, Title, Category_ID, Duration_Seconds, Entry_Date, Date_Created FROM MediaEntry")
            for entry in cur.fetchall():
                eid, title, cat_id, duration, entry_date, date_created = entry
                cur.execute("""
                    INSERT INTO MediaItem (Title, Category_ID, Status, Date_Started, Date_Created)
                    VALUES (?, ?, 'completed', ?, ?)
                """, (title, cat_id, entry_date, date_created))
                item_id = cur.lastrowid
                if duration and duration > 0:
                    cur.execute("""
                        INSERT INTO MediaSession (Item_ID, Duration_Seconds, Session_Date, Date_Created)
                        VALUES (?, ?, ?, ?)
                    """, (item_id, duration, entry_date, date_created))
            con.commit()

    con.close()
    seed_default_immersion_categories()
    seed_default_media_categories()
    seed_mining_card_types()


# ===========================================================
# Section: Database CRUD Functions
# ===========================================================


# --- Deck Functions --------------------------------

def get_descendant_deck_ids(deck_id):
    """Return a list of all descendant deck IDs for the given deck (recursive)."""
    con = create_db_connection()
    cur = con.cursor()
    result = []
    queue = [deck_id]
    while queue:
        current = queue.pop(0)
        cur.execute("SELECT ID FROM Deck WHERE Parent_ID = ?", (current,))
        for (child_id,) in cur.fetchall():
            result.append(child_id)
            queue.append(child_id)
    con.close()
    return result

def get_deck_and_descendant_ids(deck_id):
    """Return the deck_id itself plus all its descendant IDs."""
    return [deck_id] + get_descendant_deck_ids(deck_id)

def get_ordered_subdeck_tree(deck_id):
    """Return a depth-first ordered list of Deck objects for deck_id and all
    its descendants (sorted by name at each level, matching Anki's subdeck
    ordering behaviour)."""
    con = create_db_connection()
    cur = con.cursor()

    # Fetch all decks into a lookup
    cur.execute("SELECT ID, Position, Parent_ID FROM Deck")
    all_rows = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    con.close()

    # Build children map
    children_map = {}
    for did, (pos, pid) in all_rows.items():
        children_map.setdefault(pid, []).append((did, pos))
    # Sort children by position at each level
    for pid in children_map:
        children_map[pid].sort(key=lambda x: x[1])

    # DFS from deck_id
    result = []
    stack = [deck_id]
    while stack:
        current = stack.pop()
        result.append(current)
        # Push children in reverse so first-alpha is processed first
        kids = children_map.get(current, [])
        for kid_id, _ in reversed(kids):
            stack.append(kid_id)
    return result

def create_deck(name: str, description: str = "", new_cards_limit: int = 15,
                learning_steps: str = '1 10', relearning_steps: str = '10',
                study_order: str = 'new_first', parent_id: int = None):
    creation_date = date.today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()

    # Place new deck at end of its sibling group
    if parent_id is not None:
        cur.execute("SELECT COALESCE(MAX(Position), -1) + 1 FROM Deck WHERE Parent_ID = ?", (parent_id,))
    else:
        cur.execute("SELECT COALESCE(MAX(Position), -1) + 1 FROM Deck WHERE Parent_ID IS NULL")
    next_pos = cur.fetchone()[0]

    cur.execute("""
        INSERT INTO Deck (Name, Date_Created, Description, New_Cards_Limit,
                          Learning_Steps, Relearning_Steps, Study_Order, Parent_ID, Position)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (name, creation_date, description, new_cards_limit,
          learning_steps, relearning_steps, study_order, parent_id, next_pos))

    con.commit()
    new_deck_id = cur.lastrowid
    con.close()

    return new_deck_id


def get_all_decks():
    con = create_db_connection()
    cur = con.cursor()

    decks = []

    cur.execute("""SELECT ID, Name, Date_Created, New_Cards_Limit, Description, Learning_Steps, Relearning_Steps, Study_Order, Answer_Display, Parent_ID, Position FROM Deck""")
    rows = cur.fetchall()

    for row in rows:
        deck = models.Deck(row[0], row[1], row[2], row[3], description=row[4], learning_steps=row[5] or '1 10', relearning_steps=row[6] or '10', study_order=row[7] or 'new_first', answer_display=row[8] or 'replace', parent_id=row[9], position=row[10] or 0)
        decks.append(deck)

    con.close()
    return decks

def get_deck_by_id(id):
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        SELECT ID, Name, Date_Created, New_Cards_Limit, Learning_Steps, Relearning_Steps, Study_Order, Answer_Display, Parent_ID, Position FROM Deck
        WHERE ID=?
    """, (id,))

    row = cur.fetchone()

    if row is None:
        con.close()
        return None
    else:
        deck = models.Deck(row[0], row[1], row[2], row[3], learning_steps=row[4] or '1 10', relearning_steps=row[5] or '10', study_order=row[6] or 'new_first', answer_display=row[7] or 'replace', parent_id=row[8], position=row[9] or 0)

        con.close()
        return deck

def update_deck_settings(deck_id: int, name: str, description: str, new_cards_limit: int, learning_steps: str = '1 10', relearning_steps: str = '10', study_order: str = 'new_first', answer_display: str = 'replace', parent_id: int = None):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        UPDATE Deck SET Name = ?, Description = ?, New_Cards_Limit = ?, Learning_Steps = ?, Relearning_Steps = ?, Study_Order = ?, Answer_Display = ?, Parent_ID = ? WHERE ID = ?
    """, (name, description, new_cards_limit, learning_steps, relearning_steps, study_order, answer_display, parent_id, deck_id))
    con.commit()
    con.close()

def reorder_deck(deck_id: int, new_parent_id, new_position: int):
    """Move a deck to a new parent and/or position among its siblings.

    new_parent_id: int or None (None = top level).
    new_position: the 0-based index the deck should occupy among its new siblings.
    """
    con = create_db_connection()
    cur = con.cursor()

    # Remove from old sibling group: close the gap
    cur.execute("SELECT Parent_ID, Position FROM Deck WHERE ID = ?", (deck_id,))
    row = cur.fetchone()
    if row is None:
        con.close()
        return
    old_parent, old_pos = row

    # Close gap in old sibling group (exclude the deck being moved)
    if old_parent is not None:
        cur.execute("UPDATE Deck SET Position = Position - 1 WHERE Parent_ID = ? AND Position > ? AND ID != ?", (old_parent, old_pos, deck_id))
    else:
        cur.execute("UPDATE Deck SET Position = Position - 1 WHERE Parent_ID IS NULL AND Position > ? AND ID != ?", (old_pos, deck_id))

    # Open gap in new sibling group (exclude the deck being moved)
    if new_parent_id is not None:
        cur.execute("UPDATE Deck SET Position = Position + 1 WHERE Parent_ID = ? AND Position >= ? AND ID != ?", (new_parent_id, new_position, deck_id))
    else:
        cur.execute("UPDATE Deck SET Position = Position + 1 WHERE Parent_ID IS NULL AND Position >= ? AND ID != ?", (new_position, deck_id))

    # Place deck in new position
    cur.execute("UPDATE Deck SET Parent_ID = ?, Position = ? WHERE ID = ?", (new_parent_id, new_position, deck_id))

    con.commit()
    con.close()


def delete_deck(deck_id):
    all_ids = get_deck_and_descendant_ids(deck_id)
    placeholders = ','.join('?' * len(all_ids))
    con = create_db_connection()
    cur = con.cursor()

    cur.execute(f"DELETE FROM Review WHERE Card_ID IN (SELECT ID FROM Card WHERE Deck_ID IN ({placeholders}))", all_ids)
    cur.execute(f"DELETE FROM Card WHERE Deck_ID IN ({placeholders})", all_ids)
    cur.execute(f"DELETE FROM Deck WHERE ID IN ({placeholders})", all_ids)

    con.commit()
    con.close()

def delete_deck_by_name(name):
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        DELETE FROM Deck
        WHERE Name=?
    """, (name,))

    con.commit()
    con.close()

# --- CardType Functions --------------------------------

DEFAULT_IMMERSION_CATEGORIES = [
    ('Anime',    '#4e9af1'),
    ('Manga',    '#e06c75'),
    ('Book',     '#56b6c2'),
    ('Movie',    '#d19a66'),
    ('TV Show',  '#c678dd'),
]

def seed_default_immersion_categories():
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM ImmersionCategory")
    if cur.fetchone()[0] == 0:
        today = datetime.now().strftime('%Y-%m-%d')
        cur.executemany(
            "INSERT INTO ImmersionCategory (Name, Color, Date_Created) VALUES (?, ?, ?)",
            [(name, color, today) for name, color in DEFAULT_IMMERSION_CATEGORIES]
        )
        con.commit()
    con.close()

def seed_default_media_categories():
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM MediaCategory")
    if cur.fetchone()[0] == 0:
        today = datetime.now().strftime('%Y-%m-%d')
        cur.executemany(
            "INSERT INTO MediaCategory (Name, Color, Date_Created) VALUES (?, ?, ?)",
            [(name, color, today) for name, color in DEFAULT_IMMERSION_CATEGORIES]
        )
        con.commit()
    con.close()


def seed_default_card_type():
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT ID FROM CardType WHERE Is_Default = 1")
    if cur.fetchone() is None:
        cur.execute("""
            INSERT INTO CardType (Name, Fields, Date_Created, Is_Default)
            VALUES (?, ?, ?, 1)
        """, ('Basic', '["Front", "Back"]', date.today().strftime('%Y-%m-%d')))
        con.commit()
    con.close()

# Card types pre-made for the browser extension's two mining surfaces: the
# hover-dictionary popup ("Pop-Dictionary") and YouTube subtitle mining
# ("Sentence Mining"). Their field names match the extension's auto-mapper, so
# out of the box a mined card lands with every slot filled and one-click mining
# works without manual field mapping. Editable/deletable like any user type
# (Is_Default stays 0); the seed runs once, guarded by a settings.json flag, so
# a deleted type is not resurrected on the next launch.
MINING_CARD_TYPES = [
    {
        'name': 'Pop-Dictionary',
        'fields': ['Expression', 'Reading', 'Definition', 'Sentence'],
        'front_style': '<div class="pd-word">{{Expression}}</div>',
        'back_style': (
            '<div class="pd-word">{{Expression}}</div>\n'
            '<div class="pd-reading">{{Reading}}</div>\n'
            '<hr>\n'
            '<div class="pd-definition">{{Definition}}</div>\n'
            '<div class="pd-sentence">{{Sentence}}</div>'
        ),
        'css_style': (
            '.pd-word { font-size: 2.2em; font-weight: 700; }\n'
            '.pd-reading { font-size: 1.2em; color: #888; margin-top: 4px; }\n'
            '.pd-definition { font-size: 1.1em; margin-top: 10px; }\n'
            '.pd-sentence { font-size: 1em; color: #666; margin-top: 12px; }'
        ),
    },
    {
        'name': 'Sentence Mining',
        'fields': ['Sentence', 'Image', 'Audio'],
        'front_style': '<div class="sm-sentence">{{Sentence}}</div>',
        'back_style': (
            '<div class="sm-sentence">{{Sentence}}</div>\n'
            '<hr>\n'
            '<div class="sm-image">{{Image}}</div>\n'
            '<div class="sm-audio">{{Audio}}</div>'
        ),
        'css_style': (
            '.sm-sentence { font-size: 1.5em; line-height: 1.7; }\n'
            '.sm-image img { max-width: 100%; border-radius: 8px; margin-top: 10px; }\n'
            '.sm-audio { margin-top: 8px; }'
        ),
    },
]


def seed_mining_card_types():
    """One-time seed of the extension's mining card types (see MINING_CARD_TYPES)."""
    settings = get_app_settings()
    if settings.get('mining_card_types_seeded'):
        return
    con = create_db_connection()
    cur = con.cursor()
    creation_date = date.today().strftime('%Y-%m-%d')
    for ct in MINING_CARD_TYPES:
        cur.execute("SELECT ID FROM CardType WHERE Name = ?", (ct['name'],))
        if cur.fetchone() is None:
            cur.execute("""
                INSERT INTO CardType (Name, Fields, Date_Created, Front_Style, Back_Style, CSS_Style)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (ct['name'], json.dumps(ct['fields']), creation_date,
                  ct['front_style'], ct['back_style'], ct['css_style']))
    con.commit()
    con.close()
    settings['mining_card_types_seeded'] = True
    save_app_settings(settings)


def get_or_create_card_type(name: str, fields: list, front_style: str = '', back_style: str = '', css_style: str = '') -> int:
    """Return the ID of an existing CardType with this name, or create a new one."""
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT ID FROM CardType WHERE Name = ?", (name,))
    row = cur.fetchone()
    con.close()
    if row:
        return row[0]
    return create_card_type(name, fields, front_style, back_style, css_style)

def create_card_type(name: str, fields: list, front_style: str = '', back_style: str = '', css_style: str = '') -> int:
    creation_date = date.today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO CardType (Name, Fields, Date_Created, Front_Style, Back_Style, CSS_Style)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (name, json.dumps(fields), creation_date, front_style, back_style, css_style))
    con.commit()
    new_id = cur.lastrowid
    con.close()
    return new_id

def get_all_card_types() -> list:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        SELECT ID, Name, Fields, Date_Created, Is_Default, Front_Style, Back_Style, CSS_Style FROM CardType
        ORDER BY Is_Default DESC, Name ASC
    """)
    rows = cur.fetchall()
    con.close()
    return [models.CardType(r[0], r[1], json.loads(r[2]), r[3], r[4], r[5] or '', r[6] or '', r[7] or '') for r in rows]

def get_card_type_by_id(card_type_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        SELECT ID, Name, Fields, Date_Created, Is_Default, Front_Style, Back_Style, CSS_Style FROM CardType WHERE ID=?
    """, (card_type_id,))
    row = cur.fetchone()
    con.close()
    return models.CardType(row[0], row[1], json.loads(row[2]), row[3], row[4], row[5] or '', row[6] or '', row[7] or '') if row else None

def update_card_type(card_type_id: int, name: str, fields: list, front_style: str = '', back_style: str = '', css_style: str = ''):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        UPDATE CardType SET Name = ?, Fields = ?, Front_Style = ?, Back_Style = ?, CSS_Style = ? WHERE ID = ? AND Is_Default = 0
    """, (name, json.dumps(fields), front_style, back_style, css_style, card_type_id))
    con.commit()
    con.close()

def delete_card_type(card_type_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        UPDATE Card SET Card_Type_ID = NULL WHERE Card_Type_ID = ?
    """, (card_type_id,))
    cur.execute("""
        DELETE FROM CardType WHERE ID = ? AND Is_Default = 0
    """, (card_type_id,))
    con.commit()
    con.close()

# --- Known Word Functions --------------------------
# A manually-curated vocabulary status table, independent of the SRS deck.
# Status is 'known' (counts toward comprehension), 'learning' (seen but not yet
# known — coloured distinctly, counted as unknown) or 'ignored' (excluded). The
# effective known set used for colouring/comprehension also unions in the words
# the user has SRS cards for (see get_card_words) - assembled in the WS layer.

def get_known_words() -> list:
    """Return all manually marked-known terms as a list of strings."""
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("SELECT Term FROM KnownWord WHERE Status = 'known'")
        rows = cur.fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def get_ignored_words() -> list:
    """Return all terms the user marked 'ignored' (excluded from comprehension)."""
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("SELECT Term FROM KnownWord WHERE Status = 'ignored'")
        rows = cur.fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def get_learning_words() -> list:
    """Return all terms the user marked 'learning'."""
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("SELECT Term FROM KnownWord WHERE Status = 'learning'")
        rows = cur.fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def set_word_status(term: str, status: str) -> None:
    """Set a term's status to 'known', 'learning' or 'ignored' (upsert)."""
    term = (term or '').strip()
    if not term or status not in ('known', 'learning', 'ignored'):
        return
    creation_date = date.today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute(
            "INSERT INTO KnownWord (Term, Status, Date_Created) VALUES (?, ?, ?) "
            "ON CONFLICT(Term) DO UPDATE SET Status = excluded.Status",
            (term, status, creation_date),
        )
        con.commit()
    finally:
        con.close()


def add_known_word(term: str) -> None:
    """Mark a term known (back-compat wrapper around set_word_status)."""
    set_word_status(term, 'known')


def remove_known_word(term: str) -> None:
    """Clear any status for a term (back to implicit 'unknown')."""
    term = (term or '').strip()
    if not term:
        return
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("DELETE FROM KnownWord WHERE Term = ?", (term,))
        con.commit()
    finally:
        con.close()


def count_known_words() -> int:
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM KnownWord WHERE Status = 'known'")
        return cur.fetchone()[0]
    finally:
        con.close()


def comprehension_signature() -> tuple:
    """Cheap fingerprint of the inputs to the effective known set: card count
    plus a per-status row count. Lets a cached set notice cards/statuses changed
    in the app UI (same process as the WS server) without an explicit
    invalidation. Counting per status (not just total rows) means a status FLIP
    (known → learning) also busts the cache."""
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM Card")
        cards = cur.fetchone()[0]
        cur.execute("SELECT Status, COUNT(*) FROM KnownWord GROUP BY Status")
        statuses = tuple(sorted(cur.fetchall()))
    finally:
        con.close()
    return (cards, statuses)


# Pull the head word out of mining/Anki card markup so cards can seed the known
# set. Strips ruby readings (<rt>…</rt> and […]) then all HTML, then whitespace.
def _clean_card_expression(s: str) -> str:
    import re
    s = s or ''
    s = re.sub(r'<rt>.*?</rt>', '', s, flags=re.IGNORECASE | re.DOTALL)
    s = re.sub(r'<[^>]+>', '', s)
    s = re.sub(r'\[[^\]]*\]', '', s)        # Anki-style 漢字[かな] furigana
    s = re.sub(r'[\s　]+', '', s)
    return s.strip()


# Card-type field names that typically hold the target word/expression.
_WORD_FIELD_RE = None


def _extract_card_word(front: str, fields_json: str) -> str:
    import json, re
    global _WORD_FIELD_RE
    if _WORD_FIELD_RE is None:
        _WORD_FIELD_RE = re.compile(
            r'express|word|term|vocab|target|kanji|spelling|head|単語|表現|見出',
            re.IGNORECASE,
        )
    val = ''
    if fields_json:
        try:
            d = json.loads(fields_json)
        except Exception:
            d = None
        if isinstance(d, dict) and d:
            for k, v in d.items():
                if _WORD_FIELD_RE.search(str(k)) and str(v).strip():
                    val = str(v)
                    break
            if not val:  # fall back to the first non-empty field
                for v in d.values():
                    if str(v).strip():
                        val = str(v)
                        break
    if not val:
        val = front or ''
    return _clean_card_expression(val)


def get_card_words() -> list:
    """Return the head word/expression of every SRS card (cleaned of markup).

    These seed the comprehension known set: a word the user has a card for is
    treated as known. Multi-token (sentence) cards yield a long string that the
    caller's tokenizer pass simply won't match against single tokens.
    """
    con = create_db_connection()
    cur = con.cursor()
    try:
        cur.execute("SELECT Card_Front, Fields FROM Card")
        rows = cur.fetchall()
    finally:
        con.close()
    words = []
    for front, fields in rows:
        w = _extract_card_word(front, fields)
        if w:
            words.append(w)
    return words


# --- Card Functions --------------------------------

def create_card(deck_id: int, front: str, back: str,
                card_type_id: int = None, fields_json: str = None,
                reps: int = 0, ease_factor: float = 2.5, interval: int = 0,
                due_date: str = None, is_new: bool = True,
                last_reviewed: str = None) -> int:
    creation_date = date.today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        INSERT INTO Card (Deck_ID, Card_Front, Card_Back, Card_Type_ID, Fields, Date_Created,
                          Reps, Ease_Factor, Interval, Due_Date, Is_New, Last_Reviewed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (deck_id, front, back, card_type_id, fields_json, creation_date,
          reps, ease_factor, interval, due_date, int(is_new), last_reviewed))

    con.commit()
    new_card_id = cur.lastrowid
    con.close()

    return new_card_id

def get_cards_by_deck(deck_id):
    con = create_db_connection()
    cur = con.cursor()

    cards = []

    cur.execute("""
        SELECT ID, Deck_ID, Card_Front, Card_Back, Reps,
        Ease_Factor, Interval, Due_Date, Is_New, Date_Created,
        Last_Reviewed, Card_Type_ID FROM Card
        WHERE Deck_ID=?
        """, (deck_id,))

    rows = cur.fetchall()

    for row in rows:
        card = models.Card(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11])
        cards.append(card)

    con.close()
    return cards

def get_card_by_id(id):
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        SELECT ID, Deck_ID, Card_Front, Card_Back, Reps,
        Ease_Factor, Interval, Due_Date, Is_New, Date_Created,
        Last_Reviewed, Card_Type_ID FROM Card
        WHERE ID=?
        """, (id,))

    row = cur.fetchone()
    con.close()

    if row is None:
        return None
    else:
        card = models.Card(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11])
        return card
    
def get_due_cards(deck_id=None, deck_ids=None):
    todays_date = get_srs_today().strftime('%Y-%m-%d')

    con = create_db_connection()
    cur = con.cursor()

    cards = []

    query_string = "SELECT ID, Deck_ID, Card_Front, Card_Back, Reps, Ease_Factor, " \
    "Interval, Due_Date, Is_New, Date_Created, Last_Reviewed, Card_Type_ID, Fields, Learning_Step FROM Card " \
    "WHERE Due_Date <= ? AND Due_Date IS NOT NULL AND Learning_Step IS NULL"

    query_params = [todays_date]

    if deck_ids is not None:
        placeholders = ','.join('?' * len(deck_ids))
        query_string += f" AND Deck_ID IN ({placeholders})"
        query_params.extend(deck_ids)
    elif deck_id is not None:
        query_string += " AND Deck_ID=?"
        query_params.append(deck_id)

    cur.execute(query_string, query_params)

    rows = cur.fetchall()

    for row in rows:
        card = models.Card(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13])
        cards.append(card)

    con.close()
    return cards

def get_learning_cards(deck_ids=None):
    """Return cards currently in a learning or relearning step (Learning_Step IS NOT NULL)."""
    con = create_db_connection()
    cur = con.cursor()
    cards = []
    query_string = "SELECT ID, Deck_ID, Card_Front, Card_Back, Reps, Ease_Factor, " \
    "Interval, Due_Date, Is_New, Date_Created, Last_Reviewed, Card_Type_ID, Fields, Learning_Step FROM Card " \
    "WHERE Learning_Step IS NOT NULL"
    query_params = []
    if deck_ids is not None:
        placeholders = ','.join('?' * len(deck_ids))
        query_string += f" AND Deck_ID IN ({placeholders})"
        query_params.extend(deck_ids)
    cur.execute(query_string, query_params)
    for row in cur.fetchall():
        cards.append(models.Card(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13]))
    con.close()
    return cards

def get_new_cards(deck_id=None, limit=None, deck_ids=None):
    con = create_db_connection()
    cur = con.cursor()

    cards = []

    query_string = "SELECT ID, Deck_ID, Card_Front, Card_Back, Reps, Ease_Factor, " \
    "Interval, Due_Date, Is_New, Date_Created, Last_Reviewed, Card_Type_ID, Fields, Learning_Step FROM Card " \
    "WHERE Is_New = 1 AND Due_Date IS NULL"

    query_params = []

    if deck_ids is not None:
        placeholders = ','.join('?' * len(deck_ids))
        query_string += f" AND Deck_ID IN ({placeholders})"
        query_params.extend(deck_ids)
    elif deck_id is not None:
        query_string += " AND Deck_ID=?"
        query_params.append(deck_id)
    if limit is not None:
        query_string += " LIMIT ?"
        query_params.append(limit)

    cur.execute(query_string, query_params)

    rows = cur.fetchall()

    for row in rows:
        card = models.Card(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13])
        cards.append(card)

    con.close()
    return cards

def delete_card(card_id):
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("DELETE FROM Review WHERE Card_ID=?", (card_id,))
    cur.execute("""
        DELETE FROM Card
        WHERE ID=?
    """, (card_id,))

    con.commit()
    con.close()


def browse_cards(deck_id=None, search_query=None, sort_by=None) -> list:
    con = create_db_connection()
    cur = con.cursor()

    query = """
        SELECT c.ID, c.Deck_ID, c.Card_Front, c.Card_Back, c.Reps,
               c.Ease_Factor, c.Interval, c.Due_Date, c.Is_New, c.Date_Created,
               c.Last_Reviewed, c.Card_Type_ID, c.Fields, c.Learning_Step,
               d.Name AS Deck_Name,
               COALESCE(ct.Name, '') AS Type_Name
        FROM Card c
        LEFT JOIN Deck d ON c.Deck_ID = d.ID
        LEFT JOIN CardType ct ON c.Card_Type_ID = ct.ID
        WHERE 1=1
    """
    params = []

    if deck_id is not None:
        all_ids = get_deck_and_descendant_ids(deck_id)
        placeholders = ','.join('?' * len(all_ids))
        query += f" AND c.Deck_ID IN ({placeholders})"
        params.extend(all_ids)

    if search_query:
        query += " AND (c.Card_Front LIKE ? OR c.Card_Back LIKE ? OR c.Fields LIKE ?)"
        like = f"%{search_query}%"
        params.extend([like, like, like])

    sort_map = {
        'date_created_desc': 'c.ID DESC',
        'date_created_asc': 'c.ID ASC',
        'due_date_asc': 'c.Due_Date ASC',
        'interval_asc': 'c.Interval ASC',
        'interval_desc': 'c.Interval DESC',
        'front_asc': 'c.Card_Front ASC',
    }
    order = sort_map.get(sort_by, 'c.ID DESC')
    query += f" ORDER BY {order}"

    cur.execute(query, params)
    rows = cur.fetchall()
    con.close()

    results = []
    for r in rows:
        results.append({
            'id': r[0],
            'deck_id': r[1],
            'front': r[2],
            'back': r[3],
            'reps': r[4],
            'ease_factor': round(r[5], 2),
            'interval': r[6],
            'due_date': r[7],
            'is_new': bool(r[8]),
            'date_created': r[9],
            'last_reviewed': r[10],
            'card_type_id': r[11],
            'fields': r[12],
            'learning_step': r[13],
            'deck_name': r[14] or '',
            'type_name': r[15] or '',
        })
    return results


def update_card_fields(card_id: int, deck_id: int, card_type_id: int, fields_json: str, front: str, back: str):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        UPDATE Card SET Deck_ID = ?, Card_Type_ID = ?, Fields = ?, Card_Front = ?, Card_Back = ?
        WHERE ID = ?
    """, (deck_id, card_type_id, fields_json, front, back, card_id))
    con.commit()
    con.close()

def update_card_learning_step(card_id: int, learning_step: int):
    today = get_srs_today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT Is_New, Learning_Step FROM Card WHERE ID = ?", (card_id,))
    row = cur.fetchone()
    first_introduction = row and row[0] == 1 and row[1] is None
    cur.execute("""
        UPDATE Card SET Learning_Step = ?, Due_Date = ? WHERE ID = ?
    """, (learning_step, today, card_id))
    if first_introduction:
        cur.execute("""
            INSERT INTO Review (Card_ID, Review_Date, Rating, Interval_After, Ease_Factor_After)
            VALUES (?, ?, 0, 0, 2.5)
        """, (card_id, today))
    con.commit()
    con.close()

def apply_lapse(card_id, new_reps, new_ease_factor, new_interval):
    """Reduce a card's SRS strength when it lapses (failed a review) and enters
    relearning. Unlike update_card_after_review this leaves Learning_Step and
    Due_Date untouched - those are set by update_card_learning_step so the card
    stays in the relearning queue. Resetting the interval here means relearning
    graduation rebuilds the interval instead of growing the pre-lapse one."""
    todays_date = get_srs_today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        UPDATE Card
        SET Reps = ?, Ease_Factor = ?, Interval = ?, Last_Reviewed = ?
        WHERE ID = ?
    """, (new_reps, new_ease_factor, new_interval, todays_date, card_id))
    con.commit()
    con.close()

def update_card_after_review(card_id, new_reps, new_ease_factor, new_interval, new_due_date, is_new):
    todays_date = get_srs_today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        UPDATE Card
        SET Reps = ?, Ease_Factor = ?, Interval = ?, Due_Date = ?,
        Is_New = ?, Last_Reviewed = ?, Learning_Step = NULL
        WHERE ID=?
        """, (new_reps, new_ease_factor, new_interval, new_due_date, is_new, todays_date, card_id))
    
    con.commit()
    con.close()

def get_young_card_count(deck_id=None):
    con = create_db_connection()
    cur = con.cursor()
    if deck_id is not None:
        cur.execute("""
            SELECT COUNT(*) FROM Card
            WHERE Is_New = 0 AND Learning_Step IS NULL AND Interval > 0 AND Interval < 21
            AND Deck_ID = ?
        """, (deck_id,))
    else:
        cur.execute("""
            SELECT COUNT(*) FROM Card
            WHERE Is_New = 0 AND Learning_Step IS NULL AND Interval > 0 AND Interval < 21
        """)
    count = cur.fetchone()[0]
    con.close()
    return count

def get_mature_card_count(deck_id=None):
    con = create_db_connection()
    cur = con.cursor()
    if deck_id is not None:
        cur.execute("""
            SELECT COUNT(*) FROM Card
            WHERE Is_New = 0 AND Learning_Step IS NULL AND Interval >= 21
            AND Deck_ID = ?
        """, (deck_id,))
    else:
        cur.execute("""
            SELECT COUNT(*) FROM Card
            WHERE Is_New = 0 AND Learning_Step IS NULL AND Interval >= 21
        """)
    count = cur.fetchone()[0]
    con.close()
    return count


def get_all_deck_stats():
    """Fetch per-deck card counts in a single query instead of N+1 queries per deck."""
    todays_date = get_srs_today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        SELECT
            Deck_ID,
            COUNT(*) AS total,
            SUM(CASE WHEN Is_New = 0 AND Learning_Step IS NULL AND Interval > 0 AND Interval < 21 THEN 1 ELSE 0 END) AS young,
            SUM(CASE WHEN Is_New = 0 AND Learning_Step IS NULL AND Interval >= 21 THEN 1 ELSE 0 END) AS mature,
            SUM(CASE WHEN Due_Date <= ? AND Due_Date IS NOT NULL THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN Is_New = 1 AND Due_Date IS NULL THEN 1 ELSE 0 END) AS new_available
        FROM Card
        GROUP BY Deck_ID
    """, (todays_date,))
    rows = cur.fetchall()
    con.close()
    stats = {}
    for r in rows:
        stats[r[0]] = {
            'total': r[1],
            'young': r[2],
            'mature': r[3],
            'due': r[4],
            'new_available': r[5],
        }
    return stats

# --- Review Functions --------------------------------

def get_new_cards_introduced_today(deck_id=None, deck_ids=None):
    todays_date = get_srs_today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()

    # A card was "introduced today" if its earliest review entry is today
    if deck_ids is not None:
        placeholders = ','.join('?' * len(deck_ids))
        cur.execute(f"""
            SELECT COUNT(DISTINCT r.Card_ID) FROM Review r
            JOIN Card c ON r.Card_ID = c.ID
            WHERE c.Deck_ID IN ({placeholders})
            AND r.Review_Date = ?
            AND NOT EXISTS (
                SELECT 1 FROM Review r2
                WHERE r2.Card_ID = r.Card_ID
                AND r2.Review_Date < ?
            )
        """, deck_ids + [todays_date, todays_date])
    elif deck_id is not None:
        cur.execute("""
            SELECT COUNT(DISTINCT r.Card_ID) FROM Review r
            JOIN Card c ON r.Card_ID = c.ID
            WHERE c.Deck_ID = ?
            AND r.Review_Date = ?
            AND NOT EXISTS (
                SELECT 1 FROM Review r2
                WHERE r2.Card_ID = r.Card_ID
                AND r2.Review_Date < ?
            )
        """, (deck_id, todays_date, todays_date))
    else:
        cur.execute("""
            SELECT COUNT(DISTINCT r.Card_ID) FROM Review r
            WHERE r.Review_Date = ?
            AND NOT EXISTS (
                SELECT 1 FROM Review r2
                WHERE r2.Card_ID = r.Card_ID
                AND r2.Review_Date < ?
            )
        """, (todays_date, todays_date))

    count = cur.fetchone()[0]
    con.close()
    return count

def create_review(card_id, rating, interval_after, ease_factor_after):
    review_date = get_srs_today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        INSERT INTO Review (Card_ID, Review_Date, Rating, Interval_After, Ease_Factor_After)
        VALUES (?, ?, ?, ?, ?)
    """, (card_id, review_date, rating, interval_after, ease_factor_after))

    con.commit()
    con.close()


def import_review(card_id, review_date: str, rating, interval_after, ease_factor_after):
    """Insert a historical review record with an explicit date (used during deck import)."""
    con = create_db_connection()
    cur = con.cursor()

    cur.execute("""
        INSERT INTO Review (Card_ID, Review_Date, Rating, Interval_After, Ease_Factor_After)
        VALUES (?, ?, ?, ?, ?)
    """, (card_id, review_date, rating, interval_after, ease_factor_after))

    con.commit()
    con.close()


def get_data_info() -> dict:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM Deck")
    deck_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM Card")
    card_count = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM Review")
    review_count = cur.fetchone()[0]
    con.close()
    db_size = DB_PATH.stat().st_size if DB_PATH.exists() else 0
    return {
        'db_path': str(DB_PATH),
        'db_size_bytes': db_size,
        'deck_count': deck_count,
        'card_count': card_count,
        'review_count': review_count,
    }


def export_all_data() -> dict:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT ID, Name, Date_Created, New_Cards_Limit, Description, Learning_Steps, Relearning_Steps, Study_Order, Answer_Display, Parent_ID FROM Deck")
    decks = [{'id': r[0], 'name': r[1], 'date_created': r[2], 'new_cards_limit': r[3], 'description': r[4],
               'learning_steps': r[5], 'relearning_steps': r[6], 'study_order': r[7], 'answer_display': r[8], 'parent_id': r[9]}
             for r in cur.fetchall()]
    cur.execute("SELECT ID, Deck_ID, Card_Front, Card_Back, Reps, Ease_Factor, Interval, Due_Date, Is_New, Date_Created, Last_Reviewed, Card_Type_ID, Fields, Learning_Step FROM Card")
    cards = [{'id': r[0], 'deck_id': r[1], 'front': r[2], 'back': r[3], 'reps': r[4], 'ease_factor': r[5],
               'interval': r[6], 'due_date': r[7], 'is_new': r[8], 'date_created': r[9], 'last_reviewed': r[10],
               'card_type_id': r[11], 'fields': r[12], 'learning_step': r[13]}
             for r in cur.fetchall()]
    cur.execute("SELECT ID, Name, Fields, Date_Created, Is_Default, Front_Style, Back_Style, CSS_Style FROM CardType")
    card_types = [{'id': r[0], 'name': r[1], 'fields': r[2], 'date_created': r[3], 'is_default': r[4],
                   'front_style': r[5], 'back_style': r[6], 'css_style': r[7]}
                  for r in cur.fetchall()]
    cur.execute("SELECT ID, Card_ID, Review_Date, Rating, Interval_After, Ease_Factor_After FROM Review")
    reviews = [{'id': r[0], 'card_id': r[1], 'review_date': r[2], 'rating': r[3],
                'interval_after': r[4], 'ease_factor_after': r[5]}
               for r in cur.fetchall()]
    con.close()
    return {'decks': decks, 'cards': cards, 'card_types': card_types, 'reviews': reviews}


def get_daily_review_counts(deck_id=None) -> dict:
    today = get_srs_today()
    start = today - timedelta(days=364)
    tomorrow = today + timedelta(days=1)
    forecast_end = today + timedelta(days=60)

    con = create_db_connection()
    cur = con.cursor()

    if deck_id is not None:
        all_ids = get_deck_and_descendant_ids(deck_id)
        placeholders = ','.join('?' * len(all_ids))
        cur.execute(f"""
            SELECT r.Review_Date, COUNT(*)
            FROM Review r
            JOIN Card c ON r.Card_ID = c.ID
            WHERE c.Deck_ID IN ({placeholders}) AND r.Review_Date >= ? AND r.Review_Date <= ?
            GROUP BY r.Review_Date
        """, all_ids + [start.isoformat(), today.isoformat()])
    else:
        cur.execute("""
            SELECT Review_Date, COUNT(*)
            FROM Review
            WHERE Review_Date >= ? AND Review_Date <= ?
            GROUP BY Review_Date
        """, (start.isoformat(), today.isoformat()))

    counts = {row[0]: row[1] for row in cur.fetchall()}

    if deck_id is not None:
        all_ids = get_deck_and_descendant_ids(deck_id)
        placeholders = ','.join('?' * len(all_ids))
        cur.execute(f"""
            SELECT Due_Date, COUNT(*)
            FROM Card
            WHERE Deck_ID IN ({placeholders}) AND Is_New = 0 AND Learning_Step IS NULL
                AND Due_Date > ? AND Due_Date <= ?
            GROUP BY Due_Date
        """, all_ids + [today.isoformat(), forecast_end.isoformat()])
    else:
        cur.execute("""
            SELECT Due_Date, COUNT(*)
            FROM Card
            WHERE Is_New = 0 AND Learning_Step IS NULL
                AND Due_Date > ? AND Due_Date <= ?
            GROUP BY Due_Date
        """, (today.isoformat(), forecast_end.isoformat()))

    forecast = {row[0]: row[1] for row in cur.fetchall()}
    due_tomorrow = forecast.get(tomorrow.isoformat(), 0)

    con.close()

    # Current streak: consecutive days ending today (or yesterday if no reviews today)
    current_streak = 0
    d = today if counts.get(today.isoformat(), 0) > 0 else today - timedelta(days=1)
    while counts.get(d.isoformat(), 0) > 0:
        current_streak += 1
        d -= timedelta(days=1)

    # Longest streak over the full year window
    longest_streak, run = 0, 0
    for i in range(365):
        if counts.get((start + timedelta(days=i)).isoformat(), 0) > 0:
            run += 1
            longest_streak = max(longest_streak, run)
        else:
            run = 0

    return {
        'today': today.isoformat(),
        'counts': counts,
        'current_streak': current_streak,
        'longest_streak': longest_streak,
        'year_total': sum(counts.values()),
        'forecast': forecast,
        'due_tomorrow': due_tomorrow,
    }


def get_retention_stats(deck_id=None, start_date=None, end_date=None) -> dict:
    con = create_db_connection()
    cur = con.cursor()

    if deck_id is not None:
        all_ids = get_deck_and_descendant_ids(deck_id)
        placeholders = ','.join('?' * len(all_ids))
        deck_filter = f'AND c.Deck_ID IN ({placeholders})'
        params = all_ids
    else:
        deck_filter = ''
        params = []
    params += [start_date, end_date]

    cur.execute(f"""
        WITH all_reviews AS (
            SELECT
                r.ID,
                r.Card_ID,
                r.Review_Date,
                r.Rating,
                ROW_NUMBER() OVER (PARTITION BY r.Card_ID, r.Review_Date ORDER BY r.ID) AS day_rn,
                LAG(r.Interval_After, 1, 0) OVER (PARTITION BY r.Card_ID ORDER BY r.ID) AS interval_before
            FROM Review r
            JOIN Card c ON r.Card_ID = c.ID
            WHERE 1=1 {deck_filter}
        ),
        filtered AS (
            SELECT * FROM all_reviews WHERE day_rn = 1 AND Review_Date >= ? AND Review_Date <= ?
        )
        SELECT
            SUM(CASE WHEN interval_before > 0 AND interval_before < 21 THEN 1 ELSE 0 END),
            SUM(CASE WHEN interval_before > 0 AND interval_before < 21 AND Rating >= 3 THEN 1 ELSE 0 END),
            SUM(CASE WHEN interval_before >= 21 THEN 1 ELSE 0 END),
            SUM(CASE WHEN interval_before >= 21 AND Rating >= 3 THEN 1 ELSE 0 END),
            SUM(CASE WHEN interval_before > 0 THEN 1 ELSE 0 END),
            SUM(CASE WHEN interval_before > 0 AND Rating >= 3 THEN 1 ELSE 0 END)
        FROM filtered
    """, params)

    row = cur.fetchone()
    con.close()

    if not row or not row[4]:
        empty = {'total': 0, 'successful': 0, 'rate': None}
        return {'young': empty, 'mature': empty, 'total': empty}

    young_t, young_s = row[0] or 0, row[1] or 0
    mature_t, mature_s = row[2] or 0, row[3] or 0
    all_t, all_s = row[4] or 0, row[5] or 0

    def stat(t, s):
        return {'total': t, 'successful': s, 'rate': round(s / t * 100, 1) if t > 0 else None}

    return {'young': stat(young_t, young_s), 'mature': stat(mature_t, mature_s), 'total': stat(all_t, all_s)}


def clear_review_history():
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("DELETE FROM Review")
    con.commit()
    con.close()


# ===========================================================
# Section: Immersion Functions
# ===========================================================

def create_immersion_category(name: str, color: str = '#9067C6') -> int:
    creation_date = date.today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO ImmersionCategory (Name, Color, Date_Created)
        VALUES (?, ?, ?)
    """, (name, color, creation_date))
    con.commit()
    new_id = cur.lastrowid
    con.close()
    return new_id

def get_all_immersion_categories() -> list:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT ID, Name, Color, Date_Created FROM ImmersionCategory ORDER BY Name ASC")
    rows = cur.fetchall()
    con.close()
    return [models.ImmersionCategory(r[0], r[1], r[2], r[3]) for r in rows]

def update_immersion_category(cat_id: int, name: str, color: str):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("UPDATE ImmersionCategory SET Name = ?, Color = ? WHERE ID = ?", (name, color, cat_id))
    con.commit()
    con.close()

def delete_immersion_category(cat_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("DELETE FROM ImmersionLog WHERE Category_ID = ?", (cat_id,))
    cur.execute("DELETE FROM ImmersionCategory WHERE ID = ?", (cat_id,))
    con.commit()
    con.close()

def create_immersion_log(category_id: int, duration_seconds: int, log_date: str = None) -> int:
    if log_date is None:
        log_date = get_srs_today().strftime('%Y-%m-%d')
    creation_date = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO ImmersionLog (Category_ID, Duration_Seconds, Log_Date, Date_Created)
        VALUES (?, ?, ?, ?)
    """, (category_id, duration_seconds, log_date, creation_date))
    con.commit()
    new_id = cur.lastrowid
    con.close()
    return new_id

def delete_immersion_log(log_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("DELETE FROM ImmersionLog WHERE ID = ?", (log_id,))
    con.commit()
    con.close()

def get_immersion_stats(period: str = 'all_time') -> dict:
    """Return per-category immersion totals for the given period."""
    today = get_srs_today()
    con = create_db_connection()
    cur = con.cursor()

    date_filter = ''
    params = []
    if period == 'today':
        date_filter = 'AND l.Log_Date = ?'
        params = [today.strftime('%Y-%m-%d')]
    elif period == 'last_week':
        start = (today - timedelta(days=6)).strftime('%Y-%m-%d')
        date_filter = 'AND l.Log_Date >= ? AND l.Log_Date <= ?'
        params = [start, today.strftime('%Y-%m-%d')]
    elif period == 'last_month':
        start = (today - timedelta(days=29)).strftime('%Y-%m-%d')
        date_filter = 'AND l.Log_Date >= ? AND l.Log_Date <= ?'
        params = [start, today.strftime('%Y-%m-%d')]
    elif period == 'last_year':
        start = (today - timedelta(days=364)).strftime('%Y-%m-%d')
        date_filter = 'AND l.Log_Date >= ? AND l.Log_Date <= ?'
        params = [start, today.strftime('%Y-%m-%d')]
    elif period == 'this_week':
        # Monday of the current week
        start = (today - timedelta(days=today.weekday())).strftime('%Y-%m-%d')
        date_filter = 'AND l.Log_Date >= ? AND l.Log_Date <= ?'
        params = [start, today.strftime('%Y-%m-%d')]
    elif period == 'this_month':
        start = today.replace(day=1).strftime('%Y-%m-%d')
        date_filter = 'AND l.Log_Date >= ? AND l.Log_Date <= ?'
        params = [start, today.strftime('%Y-%m-%d')]
    elif period == 'this_year':
        start = today.replace(month=1, day=1).strftime('%Y-%m-%d')
        date_filter = 'AND l.Log_Date >= ? AND l.Log_Date <= ?'
        params = [start, today.strftime('%Y-%m-%d')]

    cur.execute(f"""
        SELECT c.ID, c.Name, c.Color, COALESCE(SUM(l.Duration_Seconds), 0)
        FROM ImmersionCategory c
        LEFT JOIN ImmersionLog l ON c.ID = l.Category_ID {date_filter}
        GROUP BY c.ID
        ORDER BY COALESCE(SUM(l.Duration_Seconds), 0) DESC
    """, params)
    rows = cur.fetchall()

    # Also get total across all
    cur.execute(f"""
        SELECT COALESCE(SUM(l.Duration_Seconds), 0)
        FROM ImmersionLog l
        WHERE 1=1 {date_filter}
    """, params)
    total = cur.fetchone()[0]

    con.close()

    categories = []
    for r in rows:
        categories.append({
            'id': r[0],
            'name': r[1],
            'color': r[2],
            'total_seconds': r[3],
        })

    return {'categories': categories, 'total_seconds': total}

def get_immersion_logs(category_id: int = None, limit: int = 50) -> list:
    con = create_db_connection()
    cur = con.cursor()
    query = """
        SELECT l.ID, l.Category_ID, c.Name, c.Color, l.Duration_Seconds, l.Log_Date, l.Date_Created
        FROM ImmersionLog l
        JOIN ImmersionCategory c ON l.Category_ID = c.ID
    """
    params = []
    if category_id is not None:
        query += " WHERE l.Category_ID = ?"
        params.append(category_id)
    query += " ORDER BY l.Date_Created DESC LIMIT ?"
    params.append(limit)
    cur.execute(query, params)
    rows = cur.fetchall()
    con.close()
    return [{
        'id': r[0], 'category_id': r[1], 'category_name': r[2],
        'category_color': r[3], 'duration_seconds': r[4],
        'log_date': r[5], 'date_created': r[6],
    } for r in rows]


# Section: Media Tracker Functions

def create_media_category(name: str, color: str = '#9067C6') -> int:
    con = create_db_connection()
    cur = con.cursor()
    today = datetime.now().strftime('%Y-%m-%d')
    cur.execute(
        "INSERT INTO MediaCategory (Name, Color, Date_Created) VALUES (?, ?, ?)",
        (name, color, today)
    )
    new_id = cur.lastrowid
    con.commit()
    con.close()
    return new_id


def get_all_media_categories() -> list:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("SELECT ID, Name, Color, Date_Created FROM MediaCategory ORDER BY Name ASC")
    rows = cur.fetchall()
    con.close()
    return [{'id': r[0], 'name': r[1], 'color': r[2], 'date_created': r[3]} for r in rows]


def update_media_category(cat_id: int, name: str, color: str):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("UPDATE MediaCategory SET Name = ?, Color = ? WHERE ID = ?", (name, color, cat_id))
    con.commit()
    con.close()


def delete_media_category(cat_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("UPDATE MediaEntry SET Category_ID = NULL WHERE Category_ID = ?", (cat_id,))
    cur.execute("UPDATE MediaItem SET Category_ID = NULL WHERE Category_ID = ?", (cat_id,))
    cur.execute("DELETE FROM MediaCategory WHERE ID = ?", (cat_id,))
    con.commit()
    con.close()


def create_media_item(title: str, category_id: int = None, status: str = 'plan_to_watch',
                       progress: str = None, progress_max: str = None,
                       notes: str = None, date_started: str = None, date_finished: str = None) -> int:
    creation_date = datetime.now().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO MediaItem (Title, Category_ID, Status, Progress, Progress_Max, Notes, Date_Started, Date_Finished, Date_Created)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (title, category_id, status, progress or None, progress_max or None,
          notes or None, date_started or None, date_finished or None, creation_date))
    con.commit()
    new_id = cur.lastrowid
    con.close()
    return new_id


def get_media_items() -> list:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        SELECT m.ID, m.Title, m.Category_ID, c.Name, c.Color, m.Status,
               m.Progress, m.Progress_Max, m.Notes, m.Date_Started, m.Date_Finished,
               COALESCE(SUM(s.Duration_Seconds), 0), m.Date_Created
        FROM MediaItem m
        LEFT JOIN MediaCategory c ON m.Category_ID = c.ID
        LEFT JOIN MediaSession s ON m.ID = s.Item_ID
        GROUP BY m.ID
        ORDER BY
            CASE m.Status WHEN 'watching' THEN 1 WHEN 'plan_to_watch' THEN 2
                           WHEN 'completed' THEN 3 WHEN 'dropped' THEN 4 ELSE 5 END,
            m.Title COLLATE NOCASE ASC
    """)
    rows = cur.fetchall()
    con.close()
    return [{
        'id': r[0], 'title': r[1], 'category_id': r[2],
        'category_name': r[3], 'category_color': r[4],
        'status': r[5], 'progress': r[6], 'progress_max': r[7],
        'notes': r[8], 'date_started': r[9], 'date_finished': r[10],
        'total_seconds': r[11], 'date_created': r[12],
    } for r in rows]


def update_media_item(item_id: int, title: str, category_id: int, status: str,
                       progress: str, progress_max: str, notes: str,
                       date_started: str, date_finished: str):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        UPDATE MediaItem SET Title=?, Category_ID=?, Status=?, Progress=?, Progress_Max=?,
        Notes=?, Date_Started=?, Date_Finished=? WHERE ID=?
    """, (title, category_id or None, status, progress or None, progress_max or None,
          notes or None, date_started or None, date_finished or None, item_id))
    con.commit()
    con.close()


def delete_media_item(item_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("DELETE FROM MediaSession WHERE Item_ID = ?", (item_id,))
    cur.execute("DELETE FROM MediaItem WHERE ID = ?", (item_id,))
    con.commit()
    con.close()


def create_media_session(item_id: int, duration_seconds: int = None,
                          progress_note: str = None, session_date: str = None) -> int:
    creation_date = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    if not session_date:
        session_date = date.today().strftime('%Y-%m-%d')
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        INSERT INTO MediaSession (Item_ID, Duration_Seconds, Progress_Note, Session_Date, Date_Created)
        VALUES (?, ?, ?, ?, ?)
    """, (item_id, duration_seconds or None, progress_note or None, session_date, creation_date))
    con.commit()
    new_id = cur.lastrowid
    con.close()
    return new_id


def get_media_sessions(item_id: int) -> list:
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("""
        SELECT ID, Item_ID, Duration_Seconds, Progress_Note, Session_Date, Date_Created
        FROM MediaSession WHERE Item_ID = ?
        ORDER BY Session_Date DESC, Date_Created DESC
    """, (item_id,))
    rows = cur.fetchall()
    con.close()
    return [{
        'id': r[0], 'item_id': r[1], 'duration_seconds': r[2],
        'progress_note': r[3], 'session_date': r[4], 'date_created': r[5],
    } for r in rows]


def delete_media_session(session_id: int):
    con = create_db_connection()
    cur = con.cursor()
    cur.execute("DELETE FROM MediaSession WHERE ID = ?", (session_id,))
    con.commit()
    con.close()

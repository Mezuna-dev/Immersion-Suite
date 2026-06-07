from PyQt6.QtWidgets import QWidget, QVBoxLayout, QFileDialog
import shutil
from PyQt6.QtCore import QObject, pyqtSlot, QUrl, Qt
from PyQt6.QtGui import QColor
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtNetwork import QNetworkAccessManager, QNetworkRequest, QNetworkReply
from pathlib import Path
import json
import urllib.parse
import database
import scheduler


class AppBridge(QObject):
    def __init__(self, web_view):
        super().__init__()
        self.web_view = web_view
        self.network_manager = QNetworkAccessManager()

    @pyqtSlot()
    def refreshStats(self):
        decks = database.get_all_decks()
        all_stats = database.get_all_deck_stats()
        total_due = sum(s['due'] for s in all_stats.values())
        # Only count root-level decks (parent_id is None) to avoid
        # double-counting children that are already included via their parent's
        # sequential subdeck walk.
        total_new = 0
        for deck in decks:
            if deck.parent_id is not None:
                continue
            all_ids = database.get_deck_and_descendant_ids(deck.id)
            limit = deck.new_cards_limit
            introduced = database.get_new_cards_introduced_today(deck_ids=all_ids)
            remaining = max(0, limit - introduced)
            if remaining == 0:
                continue
            ordered_ids = database.get_ordered_subdeck_tree(deck.id)
            for sub_id in ordered_ids:
                if remaining <= 0:
                    break
                sub_stats = all_stats.get(sub_id, {'new_available': 0})
                take = min(sub_stats['new_available'], remaining)
                total_new += take
                remaining -= take
        self.web_view.page().runJavaScript(f'updateStats({total_due}, {total_new});')

    @pyqtSlot()
    def getDecks(self):
        decks = database.get_all_decks()
        all_stats = database.get_all_deck_stats()
        deck_map = {d.id: d for d in decks}

        # Build aggregated stats: each parent deck includes stats from all descendants
        def _aggregate_stats(deck_id):
            desc_ids = database.get_deck_and_descendant_ids(deck_id)
            agg = {'total': 0, 'young': 0, 'mature': 0, 'due': 0, 'new_available': 0}
            for did in desc_ids:
                s = all_stats.get(did, {'total': 0, 'young': 0, 'mature': 0, 'due': 0, 'new_available': 0})
                for k in agg:
                    agg[k] += s[k]
            return agg

        def _compute_new_count(deck_id):
            """Compute the new-card count matching sequential subdeck behaviour:
            walk subdecks in tree order, apply the parent's limit as the total
            budget, and fill from each subdeck before moving to the next."""
            dk = deck_map.get(deck_id)
            limit = dk.new_cards_limit if dk else 15
            all_ids = database.get_deck_and_descendant_ids(deck_id)
            introduced = database.get_new_cards_introduced_today(deck_ids=all_ids)
            remaining = max(0, limit - introduced)
            if remaining == 0:
                return 0
            ordered_ids = database.get_ordered_subdeck_tree(deck_id)
            total_new = 0
            for sub_id in ordered_ids:
                if remaining <= 0:
                    break
                sub_stats = all_stats.get(sub_id, {'new_available': 0})
                take = min(sub_stats['new_available'], remaining)
                total_new += take
                remaining -= take
            return total_new

        deck_list = []
        for deck in decks:
            stats = _aggregate_stats(deck.id)
            new_count = _compute_new_count(deck.id)
            deck_list.append({
                'id': deck.id,
                'name': deck.name,
                'due': stats['due'],
                'new': new_count,
                'total': stats['total'],
                'young': stats['young'],
                'mature': stats['mature'],
                'description': deck.description,
                'new_cards_limit': deck.new_cards_limit,
                'learning_steps': deck.learning_steps or '1 10',
                'relearning_steps': deck.relearning_steps or '10',
                'study_order': deck.study_order or 'new_first',
                'answer_display': deck.answer_display or 'replace',
                'parent_id': deck.parent_id,
                'position': deck.position,
            })
        payload = json.dumps(deck_list)
        self.web_view.page().runJavaScript(f'updateDecks({payload});')
    
    @pyqtSlot()
    def importDeck(self):
        main_window = self.web_view.window()
        if main_window:
            main_window.import_deck()
    
    @pyqtSlot(str, str, int)
    def createDeck(self, deck_name, deck_description, parent_id=0):
        if deck_name:
            s = database.get_app_settings()
            database.create_deck(
                deck_name, deck_description,
                new_cards_limit=s.get('default_new_cards_limit', 15),
                learning_steps=s.get('default_learning_steps', '1 10'),
                relearning_steps=s.get('default_relearning_steps', '10'),
                study_order=s.get('default_study_order', 'new_first'),
                parent_id=parent_id if parent_id else None,
            )
            self.refreshStats()
    
    @pyqtSlot()
    def getCardTypes(self):
        card_types = database.get_all_card_types()
        payload = json.dumps([{
            'id': ct.id,
            'name': ct.name,
            'fields': ct.fields,
            'is_default': ct.is_default,
            'front_style': ct.front_style,
            'back_style': ct.back_style,
            'css_style': ct.css_style
        } for ct in card_types])
        self.web_view.page().runJavaScript(f'updateCardTypes({payload});')

    @pyqtSlot(str, str, str, str, str)
    def createCardType(self, name, fields_json, front_style, back_style, css_style):
        fields = json.loads(fields_json)
        fields = [f.strip() for f in fields if isinstance(f, str) and f.strip()]
        if name.strip() and fields:
            database.create_card_type(name.strip(), fields, front_style, back_style, css_style)
        self.getCardTypes()

    @pyqtSlot(int, str, str, str, str, str)
    def updateCardType(self, card_type_id, name, fields_json, front_style, back_style, css_style):
        fields = json.loads(fields_json)
        fields = [f.strip() for f in fields if isinstance(f, str) and f.strip()]
        if name.strip() and fields:
            database.update_card_type(card_type_id, name.strip(), fields, front_style, back_style, css_style)
        self.getCardTypes()

    @pyqtSlot(int)
    def deleteCardType(self, card_type_id):
        database.delete_card_type(card_type_id)
        self.getCardTypes()

    @pyqtSlot(int, int, str)
    def createCard(self, deck_id, card_type_id, fields_json):
        fields_dict = json.loads(fields_json)
        card_type = database.get_card_type_by_id(card_type_id)
        if not card_type or not fields_dict:
            return
        field_values = [str(fields_dict.get(f, '')) for f in card_type.fields]
        front = field_values[0] if field_values else ''
        back = ' / '.join(field_values[1:]) if len(field_values) > 1 else ''
        if not front:
            return
        database.create_card(deck_id, front, back, card_type_id, fields_json)
        self.refreshStats()

    @pyqtSlot(str)
    def getDailyReviewCounts(self, deck_id_str):
        deck_id = int(deck_id_str) if deck_id_str and deck_id_str != '0' else None
        data = database.get_daily_review_counts(deck_id=deck_id)
        self.web_view.page().runJavaScript(f'updateHeatmap({json.dumps(data)});')

    @pyqtSlot(str, str)
    def getRetentionStats(self, deck_id_str, period):
        from datetime import timedelta
        today = database.get_srs_today()
        if period == 'today':
            start = end = today.strftime('%Y-%m-%d')
        elif period == 'yesterday':
            d = today - timedelta(days=1)
            start = end = d.strftime('%Y-%m-%d')
        elif period == 'last_week':
            start = (today - timedelta(days=6)).strftime('%Y-%m-%d')
            end = today.strftime('%Y-%m-%d')
        elif period == 'last_month':
            start = (today - timedelta(days=29)).strftime('%Y-%m-%d')
            end = today.strftime('%Y-%m-%d')
        elif period == 'last_year':
            start = (today - timedelta(days=364)).strftime('%Y-%m-%d')
            end = today.strftime('%Y-%m-%d')
        else:
            start = end = today.strftime('%Y-%m-%d')
        deck_id = int(deck_id_str) if deck_id_str and deck_id_str != '0' else None
        stats = database.get_retention_stats(deck_id=deck_id, start_date=start, end_date=end)
        self.web_view.page().runJavaScript(f'updateRetentionStats({json.dumps(stats)});')

    @pyqtSlot()
    def getDataInfo(self):
        info = database.get_data_info()
        self.web_view.page().runJavaScript(f'updateDataInfo({json.dumps(info)});')

    @pyqtSlot()
    def exportData(self):
        data = database.export_all_data()
        file_path, _ = QFileDialog.getSaveFileName(
            self.web_view.window(), "Export Data", "immersion_backup.json", "JSON Files (*.json)"
        )
        if file_path:
            import pathlib
            pathlib.Path(file_path).write_text(
                json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8'
            )
            self.web_view.page().runJavaScript('showAlert("Data exported successfully.");')

    @pyqtSlot()
    def openDataFolder(self):
        import sys, subprocess, os
        data_path = database.BASE_DIR / 'data'
        data_path.mkdir(parents=True, exist_ok=True)
        if sys.platform == 'linux':
            env = os.environ.copy()
            # PyInstaller overrides LD_LIBRARY_PATH with its bundled libs,
            # which breaks spawned system processes like xdg-open / file managers.
            # Restore the original value so the child process uses system libs.
            orig = env.get('LD_LIBRARY_PATH_ORIG')
            if orig is not None:
                env['LD_LIBRARY_PATH'] = orig
            else:
                env.pop('LD_LIBRARY_PATH', None)
            subprocess.Popen(['xdg-open', str(data_path)], env=env)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', str(data_path)])
        else:
            from PyQt6.QtGui import QDesktopServices
            from PyQt6.QtCore import QUrl
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(data_path)))

    @pyqtSlot()
    def clearReviewHistory(self):
        database.clear_review_history()
        self.getDataInfo()

    @pyqtSlot()
    def getAppSettings(self):
        settings = database.get_app_settings()
        payload = json.dumps(settings)
        self.web_view.page().runJavaScript(f'applyAppSettings({payload});')

    @pyqtSlot(str)
    def saveAppSettings(self, settings_json):
        settings = json.loads(settings_json)
        database.save_app_settings(settings)

    @pyqtSlot(int, str, str, int, str, str, str, str, int)
    def saveDeckSettings(self, deck_id, name, description, new_cards_limit, learning_steps_str, relearning_steps_str, study_order, answer_display, parent_id=0):
        database.update_deck_settings(deck_id, name, description, new_cards_limit, learning_steps_str, relearning_steps_str, study_order, answer_display, parent_id=parent_id if parent_id else None)
        self.getDecks()

    @pyqtSlot(int, int)
    def setDeckParent(self, deck_id, parent_id):
        """Move a deck under a new parent (parent_id=0 means top level), placed at end."""
        new_parent = parent_id if parent_id else None
        con = database.create_db_connection()
        cur = con.cursor()
        if new_parent is not None:
            cur.execute("SELECT COALESCE(MAX(Position), -1) + 1 FROM Deck WHERE Parent_ID = ?", (new_parent,))
        else:
            cur.execute("SELECT COALESCE(MAX(Position), -1) + 1 FROM Deck WHERE Parent_ID IS NULL")
        end_pos = cur.fetchone()[0]
        con.close()
        database.reorder_deck(deck_id, new_parent, end_pos)
        self.getDecks()

    @pyqtSlot(int, int, int)
    def reorderDeck(self, deck_id, parent_id, position):
        """Move a deck to a specific position among siblings (parent_id=0 means top level)."""
        database.reorder_deck(deck_id, parent_id if parent_id else None, position)
        self.getDecks()

    @pyqtSlot(int)
    def deleteDeck(self, deck_id):
        database.delete_deck(deck_id)
        self.getDecks()

    @pyqtSlot(int, int)
    def updateCardLearningStep(self, card_id, learning_step):
        database.update_card_learning_step(card_id, learning_step)

    @pyqtSlot(str, result=str)
    def selectMediaFile(self, file_type):
        from pathlib import Path
        media_dir = database.BASE_DIR / 'data' / 'media'
        media_dir.mkdir(parents=True, exist_ok=True)

        if file_type == 'audio':
            filter_str = "Audio Files (*.mp3 *.wav *.ogg *.m4a *.flac)"
        else:
            filter_str = "Image Files (*.png *.jpg *.jpeg *.gif *.webp *.bmp)"

        main_window = self.web_view.window()
        file_path, _ = QFileDialog.getOpenFileName(main_window, "Select File", "", filter_str)
        if not file_path:
            return ''

        stem = Path(file_path).stem
        suffix = Path(file_path).suffix.lower()
        filename = stem + suffix
        dest = media_dir / filename
        counter = 1
        while dest.exists():
            filename = f"{stem}_{counter}{suffix}"
            dest = media_dir / filename
            counter += 1
        shutil.copy2(file_path, dest)

        tag = 'sound' if file_type == 'audio' else 'image'
        return f'[{tag}:{filename}]'

    @pyqtSlot()
    def getMediaBaseUrl(self):
        media_dir = database.BASE_DIR / 'data' / 'media'
        media_dir.mkdir(parents=True, exist_ok=True)
        url = QUrl.fromLocalFile(str(media_dir)).toString() + '/'
        self.web_view.page().runJavaScript(f'mediaBaseUrl = {json.dumps(url)};')

    @pyqtSlot(int)
    def startReview(self, deck_id):
        deck = database.get_deck_by_id(deck_id)
        learning_steps_str = deck.learning_steps if deck else '1 10'
        learning_steps = [int(s) for s in learning_steps_str.split() if s.strip().isdigit()]
        relearning_steps_str = deck.relearning_steps if deck else '10'
        relearning_steps = [int(s) for s in relearning_steps_str.split() if s.strip().isdigit()]
        study_order = deck.study_order if deck else 'new_first'
        answer_display = deck.answer_display if deck else 'replace'

        # Gather cards subdeck-by-subdeck in tree order (matching Anki):
        # the parent deck's new-card limit is the total budget, and subdecks
        # are processed sequentially - subdeck 1 is exhausted entirely before
        # any new cards are drawn from subdeck 2, etc.
        new_limit = deck.new_cards_limit if deck else 15
        ordered_ids = database.get_ordered_subdeck_tree(deck_id)
        all_deck_ids = database.get_deck_and_descendant_ids(deck_id)
        introduced_today = database.get_new_cards_introduced_today(deck_ids=all_deck_ids)
        remaining_new = max(0, new_limit - introduced_today)
        due_cards = database.get_due_cards(deck_ids=all_deck_ids)
        learning_cards = database.get_learning_cards(deck_ids=all_deck_ids)
        new_cards = []
        for sub_id in ordered_ids:
            if remaining_new <= 0:
                break
            batch = database.get_new_cards(deck_id=sub_id, limit=remaining_new)
            new_cards.extend(batch)
            remaining_new -= len(batch)

        # Space siblings apart within each queue: cards from the same note
        # (identical fields_json) are separated so you never see a card and
        # its reverse back-to-back.
        def space_siblings(cards_list):
            seen = set()
            ordered = []
            deferred = []
            for c in cards_list:
                key = c.fields_json or ''
                if key in seen:
                    deferred.append(c)
                else:
                    seen.add(key)
                    ordered.append(c)
            ordered.extend(deferred)
            return ordered

        new_cards = space_siblings(new_cards)
        due_cards = space_siblings(due_cards)

        card_type_map = {ct.id: ct for ct in database.get_all_card_types()}

        def build_card_dicts(cards_list):
            result = []
            for card in cards_list:
                ct = card_type_map.get(card.card_type_id)
                try:
                    fields = json.loads(card.fields_json) if card.fields_json else {}
                except (TypeError, ValueError):
                    fields = {}
                result.append({
                    'id': card.id,
                    'front': card.card_front,
                    'back': card.card_back,
                    'fields': fields,
                    'front_style': ct.front_style if ct else '',
                    'back_style': ct.back_style if ct else '',
                    'css_style': ct.css_style if ct else '',
                    'is_new': bool(card.is_new),
                    'is_relearning': not bool(card.is_new) and card.learning_step is not None,
                    'learning_step': card.learning_step,
                    'reps': card.reps,
                    'interval': card.interval,
                    'ease_factor': card.ease_factor,
                })
            return result

        media_dir = database.BASE_DIR / 'data' / 'media'
        media_dir.mkdir(parents=True, exist_ok=True)
        media_base_url = QUrl.fromLocalFile(str(media_dir)).toString() + '/'
        payload = json.dumps({
            'learning_steps': learning_steps,
            'relearning_steps': relearning_steps,
            'new_cards': build_card_dicts(new_cards),
            'due_cards': build_card_dicts(due_cards),
            'learning_cards': build_card_dicts(learning_cards),
            'study_order': study_order,
            'media_base_url': media_base_url,
            'answer_display': answer_display,
        })
        self.web_view.page().runJavaScript(f'updateReviewQueue({payload});')

    @pyqtSlot(int, int)
    def logLapse(self, card_id, rating):
        """Record a lapse review for a due card that is entering relearning steps.
        interval_after=0 signals the card is back in learning; ease_factor is unchanged."""
        card = database.get_card_by_id(card_id)
        if card:
            database.create_review(card_id, rating, 0, card.ease_factor)

    @pyqtSlot(str, str, str)
    def browseCards(self, deck_id_str, search_query, sort_by):
        deck_id = int(deck_id_str) if deck_id_str and deck_id_str != '0' else None
        sq = search_query.strip() if search_query else None
        cards = database.browse_cards(deck_id=deck_id, search_query=sq, sort_by=sort_by or None)
        payload = json.dumps(cards)
        self.web_view.page().runJavaScript(f'updateBrowseCards({payload});')

    @pyqtSlot(int, int, int, str, str, str)
    def updateCard(self, card_id, deck_id, card_type_id, fields_json, front, back):
        database.update_card_fields(card_id, deck_id, card_type_id, fields_json, front, back)

    @pyqtSlot(int)
    def deleteCardFromBrowser(self, card_id):
        database.delete_card(card_id)

    @pyqtSlot(int)
    def getCardForEdit(self, card_id):
        con = database.create_db_connection()
        cur = con.cursor()
        cur.execute("""
            SELECT c.ID, c.Deck_ID, c.Card_Front, c.Card_Back, c.Card_Type_ID, c.Fields,
                   c.Reps, c.Ease_Factor, c.Interval, c.Due_Date, c.Is_New, c.Date_Created, c.Last_Reviewed
            FROM Card c WHERE c.ID = ?
        """, (card_id,))
        row = cur.fetchone()
        con.close()
        if not row:
            return
        card_data = {
            'id': row[0], 'deck_id': row[1], 'front': row[2], 'back': row[3],
            'card_type_id': row[4], 'fields': row[5],
            'reps': row[6], 'ease_factor': round(row[7], 2), 'interval': row[8],
            'due_date': row[9], 'is_new': bool(row[10]), 'date_created': row[11], 'last_reviewed': row[12],
        }
        # Bundle card types to avoid race condition
        card_types = database.get_all_card_types()
        ct_list = [{
            'id': ct.id, 'name': ct.name, 'fields': ct.fields,
            'is_default': ct.is_default, 'front_style': ct.front_style,
            'back_style': ct.back_style, 'css_style': ct.css_style
        } for ct in card_types]
        payload = json.dumps({'card': card_data, 'card_types': ct_list})
        self.web_view.page().runJavaScript(f'loadCardForEdit({payload});')

    @pyqtSlot(int, int)
    def submitRating(self, card_id, rating):
        card = database.get_card_by_id(card_id)
        if card:
            new_reps, new_ease_factor, new_interval, due_date = scheduler.calculate_next_review(
                card.reps, card.ease_factor, card.interval, rating,
                reference_date=database.get_srs_today()
            )
            database.update_card_after_review(card_id, new_reps, new_ease_factor, new_interval, due_date, 0)
            database.create_review(card_id, rating, new_interval, new_ease_factor)

    # --- Immersion ---

    @pyqtSlot(str, str)
    def createImmersionCategory(self, name, color):
        if name.strip():
            database.create_immersion_category(name.strip(), color or '#9067C6')
        self.getImmersionCategories()

    @pyqtSlot()
    def getImmersionCategories(self):
        cats = database.get_all_immersion_categories()
        payload = json.dumps([{
            'id': c.id, 'name': c.name, 'color': c.color, 'date_created': c.date_created
        } for c in cats])
        self.web_view.page().runJavaScript(f'updateImmersionCategories({payload});')

    @pyqtSlot(int, str, str)
    def updateImmersionCategory(self, cat_id, name, color):
        if name.strip():
            database.update_immersion_category(cat_id, name.strip(), color)
        self.getImmersionCategories()

    @pyqtSlot(int)
    def deleteImmersionCategory(self, cat_id):
        database.delete_immersion_category(cat_id)
        self.getImmersionCategories()

    @pyqtSlot(int, int)
    def saveImmersionLog(self, category_id, duration_seconds):
        if duration_seconds > 0:
            database.create_immersion_log(category_id, duration_seconds)
        self.web_view.page().runJavaScript('fetchImmersionStats();')
        self.getImmersionLogs()

    @pyqtSlot(int, int, str)
    def addManualImmersionLog(self, category_id, duration_seconds, log_date):
        if duration_seconds > 0:
            database.create_immersion_log(category_id, duration_seconds, log_date or None)
        self.web_view.page().runJavaScript('fetchImmersionStats();')
        self.getImmersionLogs()

    @pyqtSlot(int)
    def deleteImmersionLog(self, log_id):
        database.delete_immersion_log(log_id)
        self.web_view.page().runJavaScript('fetchImmersionStats();')
        self.getImmersionLogs()

    @pyqtSlot(str)
    def getImmersionStats(self, period):
        stats = database.get_immersion_stats(period or 'all_time')
        self.web_view.page().runJavaScript(f'updateImmersionStats({json.dumps(stats)});')

    @pyqtSlot()
    def getImmersionLogs(self):
        logs = database.get_immersion_logs()
        self.web_view.page().runJavaScript(f'updateImmersionLogs({json.dumps(logs)});')

    # --- Media Tracker ---

    @pyqtSlot(str, int, str, str, str, str, str)
    def createMediaItem(self, title, category_id, status, progress, progress_max, notes, date_started):
        if title.strip():
            database.create_media_item(
                title.strip(),
                category_id if category_id > 0 else None,
                status or 'plan_to_watch',
                progress.strip() or None,
                progress_max.strip() or None,
                notes.strip() or None,
                date_started or None,
            )
        self.getMediaItems()

    @pyqtSlot()
    def getMediaItems(self):
        items = database.get_media_items()
        self.web_view.page().runJavaScript(f'updateMediaItems({json.dumps(items)});')

    @pyqtSlot(int, str, int, str, str, str, str, str, str)
    def updateMediaItem(self, item_id, title, category_id, status, progress, progress_max, notes, date_started, date_finished):
        if title.strip():
            database.update_media_item(
                item_id, title.strip(), category_id if category_id > 0 else None,
                status, progress, progress_max, notes, date_started, date_finished,
            )
        self.getMediaItems()

    @pyqtSlot(int)
    def deleteMediaItem(self, item_id):
        database.delete_media_item(item_id)
        self.getMediaItems()

    @pyqtSlot(int, int, str, str, int)
    def createMediaSession(self, item_id, duration_seconds, progress_note, session_date, immersion_category_id):
        database.create_media_session(
            item_id,
            duration_seconds if duration_seconds > 0 else None,
            progress_note.strip() or None,
            session_date or None,
        )
        if immersion_category_id > 0 and duration_seconds > 0:
            database.create_immersion_log(immersion_category_id, duration_seconds, session_date or None)
        self.getMediaItems()
        sessions = database.get_media_sessions(item_id)
        self.web_view.page().runJavaScript(f'updateMediaSessions({item_id}, {json.dumps(sessions)});')

    @pyqtSlot(int)
    def getMediaSessions(self, item_id):
        sessions = database.get_media_sessions(item_id)
        self.web_view.page().runJavaScript(f'updateMediaSessions({item_id}, {json.dumps(sessions)});')

    @pyqtSlot(int, int)
    def deleteMediaSession(self, session_id, item_id):
        database.delete_media_session(session_id)
        self.getMediaItems()
        sessions = database.get_media_sessions(item_id)
        self.web_view.page().runJavaScript(f'updateMediaSessions({item_id}, {json.dumps(sessions)});')

    # --- Media Categories ---

    @pyqtSlot(str, str)
    def createMediaCategory(self, name, color):
        if name.strip():
            database.create_media_category(name.strip(), color or '#9067C6')
        self.getMediaCategories()

    @pyqtSlot()
    def getMediaCategories(self):
        cats = database.get_all_media_categories()
        self.web_view.page().runJavaScript(f'updateMediaCategories({json.dumps(cats)});')

    @pyqtSlot(int, str, str)
    def updateMediaCategory(self, cat_id, name, color):
        if name.strip():
            database.update_media_category(cat_id, name.strip(), color)
        self.getMediaCategories()

    @pyqtSlot(int)
    def deleteMediaCategory(self, cat_id):
        database.delete_media_category(cat_id)
        self.getMediaCategories()
        self.getMediaItems()

    # --- Anime / Manga Search (Jikan) ---

    @pyqtSlot(str)
    def searchAnime(self, query):
        if not query.strip():
            return
        encoded = urllib.parse.quote(query.strip())
        url = QUrl(f'https://api.jikan.moe/v4/anime?q={encoded}&limit=10&sfw=true')
        request = QNetworkRequest(url)
        reply = self.network_manager.get(request)
        reply.finished.connect(lambda: self._on_anime_search_finished(reply))

    def _on_anime_search_finished(self, reply):
        if reply.error() != QNetworkReply.NetworkError.NoError:
            err = reply.errorString()
            self.web_view.page().runJavaScript(
                f'updateAnimeSearchResults([], {json.dumps("Search failed: " + err)});'
            )
            reply.deleteLater()
            return
        data = bytes(reply.readAll()).decode('utf-8')
        reply.deleteLater()
        try:
            result = json.loads(data)
            items = []
            for entry in result.get('data', []):
                images = entry.get('images', {})
                jpg = images.get('jpg', {})
                items.append({
                    'id': entry.get('mal_id'),
                    'title': entry.get('title', ''),
                    'title_english': entry.get('title_english') or '',
                    'image': jpg.get('image_url', ''),
                    'episodes': entry.get('episodes'),
                    'type': entry.get('type', ''),
                    'score': entry.get('score'),
                    'duration': entry.get('duration', ''),
                })
            self.web_view.page().runJavaScript(
                f'updateAnimeSearchResults({json.dumps(items)}, null);'
            )
        except Exception as e:
            self.web_view.page().runJavaScript(
                f'updateAnimeSearchResults([], {json.dumps(str(e))});'
            )

    @pyqtSlot(str)
    def searchManga(self, query):
        if not query.strip():
            return
        encoded = urllib.parse.quote(query.strip())
        url = QUrl(f'https://api.jikan.moe/v4/manga?q={encoded}&limit=10&sfw=true')
        request = QNetworkRequest(url)
        reply = self.network_manager.get(request)
        reply.finished.connect(lambda: self._on_manga_search_finished(reply))

    def _on_manga_search_finished(self, reply):
        if reply.error() != QNetworkReply.NetworkError.NoError:
            err = reply.errorString()
            self.web_view.page().runJavaScript(
                f'updateMangaSearchResults([], {json.dumps("Search failed: " + err)});'
            )
            reply.deleteLater()
            return
        data = bytes(reply.readAll()).decode('utf-8')
        reply.deleteLater()
        try:
            result = json.loads(data)
            items = []
            for entry in result.get('data', []):
                images = entry.get('images', {})
                jpg = images.get('jpg', {})
                items.append({
                    'id': entry.get('mal_id'),
                    'title': entry.get('title', ''),
                    'title_english': entry.get('title_english') or '',
                    'image': jpg.get('image_url', ''),
                    'chapters': entry.get('chapters'),
                    'volumes': entry.get('volumes'),
                    'type': entry.get('type', ''),
                    'score': entry.get('score'),
                })
            self.web_view.page().runJavaScript(
                f'updateMangaSearchResults({json.dumps(items)}, null);'
            )
        except Exception as e:
            self.web_view.page().runJavaScript(
                f'updateMangaSearchResults([], {json.dumps(str(e))});'
            )

    @pyqtSlot(int, int)
    def fetchAnimeEpisodes(self, anime_id, page):
        url = QUrl(f'https://api.jikan.moe/v4/anime/{anime_id}/episodes?page={page}')
        request = QNetworkRequest(url)
        reply = self.network_manager.get(request)
        reply.finished.connect(lambda: self._on_episodes_finished(reply, anime_id, page))

    def _on_episodes_finished(self, reply, anime_id, page):
        if reply.error() != QNetworkReply.NetworkError.NoError:
            err = reply.errorString()
            self.web_view.page().runJavaScript(
                f'updateAnimeEpisodes({anime_id}, [], false, {page}, {json.dumps("Failed: " + err)});'
            )
            reply.deleteLater()
            return
        data = bytes(reply.readAll()).decode('utf-8')
        reply.deleteLater()
        try:
            result = json.loads(data)
            pagination = result.get('pagination', {})
            has_next = pagination.get('has_next_page', False)
            items = []
            for ep in result.get('data', []):
                items.append({
                    'num': ep.get('mal_id'),
                    'title': ep.get('title') or ep.get('title_romanji') or '',
                    'filler': ep.get('filler', False),
                    'recap': ep.get('recap', False),
                })
            self.web_view.page().runJavaScript(
                f'updateAnimeEpisodes({anime_id}, {json.dumps(items)}, {json.dumps(has_next)}, {page}, null);'
            )
        except Exception as e:
            self.web_view.page().runJavaScript(
                f'updateAnimeEpisodes({anime_id}, [], false, {page}, {json.dumps(str(e))});'
            )


class AppWidget(QWidget):
    def __init__(self):
        super().__init__()
        self.init_ui()

    def init_ui(self):
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)

        self.web_view = QWebEngineView()
        self.web_view.page().setBackgroundColor(QColor("#242038"))

        self.bridge = AppBridge(self.web_view)
        self.channel = QWebChannel()
        self.channel.registerObject("bridge", self.bridge)
        self.web_view.page().setWebChannel(self.channel)

        import sys
        if getattr(sys, 'frozen', False):
            base_path = Path(sys._MEIPASS)
        else:
            base_path = Path(__file__).parent.parent.parent
        page_path = base_path / "web" / "pages" / "app.html"
        self.web_view.setUrl(QUrl.fromLocalFile(str(page_path.absolute())))

        layout.addWidget(self.web_view)
        self.setLayout(layout)
        self.setStyleSheet("background-color: #242038;")

    def refresh_stats(self, after_import=False):
        if after_import:
            self.web_view.page().runJavaScript('expandAllDecks();')
        self.bridge.getDecks()
        self.bridge.refreshStats()
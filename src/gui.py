# Register custom URL schemes before any Qt Web Engine module is imported or
# initialised.  Qt requires this to happen before QCoreApplication is created;
# in Python the equivalent is module-level code that runs before main().
from PyQt6.QtWebEngineCore import QWebEngineUrlScheme as _QWebEngineUrlScheme
_scheme = _QWebEngineUrlScheme(b'immersion')
_flags = (
    _QWebEngineUrlScheme.Flag.SecureScheme |
    _QWebEngineUrlScheme.Flag.CorsEnabled |
    _QWebEngineUrlScheme.Flag.ContentSecurityPolicyIgnored
)
# FetchApiAllowed was added in Qt 6.4 - add it when available.
if hasattr(_QWebEngineUrlScheme.Flag, 'FetchApiAllowed'):
    _flags |= _QWebEngineUrlScheme.Flag.FetchApiAllowed
_scheme.setFlags(_flags)
_QWebEngineUrlScheme.registerScheme(_scheme)
del _QWebEngineUrlScheme, _scheme, _flags

from PyQt6.QtWidgets import QApplication, QMainWindow, \
    QFileDialog, QProgressDialog, QMessageBox
from PyQt6.QtGui import QIcon, QAction, QDesktopServices
from PyQt6.QtCore import QUrl
import sys
import os
import database
from widgets.app_widget import AppWidget
from utils.import_thread import ImportThread


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        database.initialize_database()
        database.migrate_database()

        self.setWindowTitle("Immersion Suite")
        base_path = getattr(sys, '_MEIPASS', os.path.join(os.path.dirname(__file__), ".."))
        icon_path = os.path.join(base_path, "installer", "icon.ico")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(base_path, "icon.ico")
        self.setWindowIcon(QIcon(icon_path))
        self.showMaximized()

        self.setup_menu()
        self.setup_widgets()

    GITHUB_URL = "https://github.com/Mezuna-dev/Immersion-Suite"
    ISSUES_URL = "https://github.com/Mezuna-dev/Immersion-Suite/issues"

    def setup_menu(self):
        self.menu_bar = self.menuBar()

        # ── File ──────────────────────────────────────────────
        file_menu = self.menu_bar.addMenu("&File")
        self._add_action(file_menu, "Import Deck…", self.import_deck, "Ctrl+I")
        self._add_action(file_menu, "Export Backup…", self._export_backup, "Ctrl+E")
        self._add_action(file_menu, "Open Data Folder", self._open_data_folder)
        file_menu.addSeparator()
        self._add_action(file_menu, "Exit", self.close, "Ctrl+Q")

        # ── Decks ─────────────────────────────────────────────
        decks_menu = self.menu_bar.addMenu("&Decks")
        self._add_action(decks_menu, "New Deck", lambda: self._show_view("create-deck"))
        self._add_action(decks_menu, "New Card", lambda: self._run_js("showCreateCard();"))
        self._add_action(decks_menu, "Browse Cards", lambda: self._show_view("card-browser"))
        self._add_action(decks_menu, "Card Types", lambda: self._show_view("card-types"))

        # ── View ──────────────────────────────────────────────
        view_menu = self.menu_bar.addMenu("&View")
        self._add_action(view_menu, "Dashboard", lambda: self._show_view("dashboard"), "Ctrl+1")
        self._add_action(view_menu, "SRS", lambda: self._show_view("srs"), "Ctrl+2")
        self._add_action(view_menu, "Immersion", lambda: self._show_view("immersion"), "Ctrl+3")
        self._add_action(view_menu, "Settings", lambda: self._show_view("settings"), "Ctrl+4")

        # ── Help ──────────────────────────────────────────────
        help_menu = self.menu_bar.addMenu("&Help")
        self._add_action(help_menu, "Check for Updates", self._check_for_updates)
        help_menu.addSeparator()
        self._add_action(help_menu, "About", lambda: self._show_view("about"))
        self._add_action(help_menu, "View on GitHub", lambda: self._open_url(self.GITHUB_URL))
        self._add_action(help_menu, "Report a Bug", lambda: self._open_url(self.ISSUES_URL))

    def _add_action(self, menu, text, handler, shortcut=None):
        action = QAction(text, self)
        action.triggered.connect(handler)
        if shortcut:
            action.setShortcut(shortcut)
        menu.addAction(action)
        return action

    # ── Menu helpers ──────────────────────────────────────────
    def _run_js(self, script):
        self.app_widget.web_view.page().runJavaScript(script)

    def _show_view(self, view_id):
        self._run_js(f"showView('{view_id}');")

    def _export_backup(self):
        self.app_widget.bridge.exportData()

    def _open_data_folder(self):
        self.app_widget.bridge.openDataFolder()

    def _open_url(self, url):
        QDesktopServices.openUrl(QUrl(url))

    def _check_for_updates(self):
        # manual=True: always reports a result, even when already up to date.
        self.app_widget.bridge.checkForUpdates(True)

    def setup_widgets(self):
        self.app_widget = AppWidget()
        self.setCentralWidget(self.app_widget)

    def import_deck(self):
        apkg_path = QFileDialog.getOpenFileName(
            self, "Import Anki Deck", "", "Anki Decks (*.apkg)"
        )[0]

        if not apkg_path:
            return

        self.progress = QProgressDialog("Importing deck...", "Cancel", 0, 0, self)
        self.progress.setWindowTitle("Import progress")
        self.progress.setModal(True)
        self.progress.show()

        self.import_thread = ImportThread(apkg_path)
        self.import_thread.finished.connect(self.import_finished)
        self.import_thread.error.connect(self.import_error)
        self.import_thread.start()

    def import_finished(self):
        self.progress.close()
       
        QMessageBox.information(self, "Import Complete", "Deck imported successfully!")

        decks = database.get_all_decks()
        if any(deck.name == "Default" for deck in decks):
            database.delete_deck_by_name("Default")
            
        self.app_widget.refresh_stats(after_import=True)

    def import_error(self, error_message):
        self.progress.close()
        QMessageBox.critical(
            self, "Import Error",
            f"An error occurred while importing the deck:\n{error_message}"
        )


def main():
    import ws_server
    ws_server.start()

    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    app.exec()


if __name__ == "__main__":
    main()
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
from PyQt6.QtGui import QIcon
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

    def setup_menu(self):
        self.menu_bar = self.menuBar()
        self.file_menu = self.menu_bar.addMenu("File")
        self.edit_menu = self.menu_bar.addMenu("Edit")
        self.view_menu = self.menu_bar.addMenu("View")
        self.help_menu = self.menu_bar.addMenu("Help")

        import_action = self.file_menu.addAction("Import Deck")
        exit_action = self.file_menu.addAction("Exit")

        import_action.triggered.connect(self.import_deck)
        exit_action.triggered.connect(self.close)

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
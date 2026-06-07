from PyQt6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout,
    QLineEdit, QPushButton, QMainWindow, QProgressBar, QStackedWidget, QLabel)
from PyQt6.QtCore import QUrl, Qt
from PyQt6.QtGui import QColor, QShortcut, QKeySequence, QPainter, QPen, QPolygonF, QIcon
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import (QWebEnginePage, QWebEngineProfile,
                                   QWebEngineScript)
from pathlib import Path
import urllib.parse
import json
import sys
import os


class TabCloseButton(QWidget):
    """Small custom-painted x button for browser tabs."""

    def __init__(self, callback, parent=None):
        super().__init__(parent)
        self.setFixedSize(18, 18)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._hovered = False
        self._callback = callback

    def enterEvent(self, event):
        self._hovered = True
        self.update()

    def leaveEvent(self, event):
        self._hovered = False
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._callback()

    def paintEvent(self, event):
        from PyQt6.QtCore import QRectF
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self._hovered:
            p.setBrush(QColor(255, 255, 255, 30))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(QRectF(0, 0, 18, 18), 9, 9)
        pen = QPen(QColor("#ccc" if self._hovered else "#777"))
        pen.setWidthF(1.3)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        p.setPen(pen)
        p.drawLine(5, 5, 13, 13)
        p.drawLine(13, 5, 5, 13)
        p.end()


class TabButton(QWidget):
    """A single tab in the custom tab strip."""

    def __init__(self, title, on_click, on_close, parent=None):
        super().__init__(parent)
        self.setFixedHeight(40)
        self.setMinimumWidth(60)
        self.setMaximumWidth(240)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setAttribute(Qt.WidgetAttribute.WA_Hover, True)
        self._active = False
        self._hovered = False
        self._on_click = on_click

        lay = QHBoxLayout(self)
        lay.setContentsMargins(12, 0, 8, 0)
        lay.setSpacing(8)
        lay.setAlignment(Qt.AlignmentFlag.AlignVCenter)

        self.icon_label = QLabel()
        self.icon_label.setFixedSize(16, 16)
        self.icon_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        lay.addWidget(self.icon_label)

        self.title_label = QLabel(title)
        self.title_label.setFixedWidth(140)
        self.title_label.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        lay.addWidget(self.title_label)

        self.close_btn = TabCloseButton(on_close)
        lay.addWidget(self.close_btn)

        self._update_colors()

    def set_active(self, active):
        self._active = active
        self._update_colors()
        self.update()

    def set_title(self, title):
        display = title[:20] + "\u2026" if len(title) > 20 else title
        self.title_label.setText(display or "New Tab")

    def set_icon(self, icon):
        if icon and not icon.isNull():
            self.icon_label.setPixmap(icon.pixmap(16, 16))
        else:
            self.icon_label.clear()

    def _update_colors(self):
        color = "#fff" if self._active else "#999"
        self.title_label.setStyleSheet(
            f"color: {color}; font-size: 13px; background: transparent;")

    def enterEvent(self, event):
        self._hovered = True
        self.update()

    def leaveEvent(self, event):
        self._hovered = False
        self.update()

    def paintEvent(self, event):
        from PyQt6.QtCore import QRectF
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rect = QRectF(0, 0, self.width(), self.height())
        if self._active:
            p.setBrush(QColor("#242038"))
            p.setPen(Qt.PenStyle.NoPen)
            path = p.drawRoundedRect(rect, 8, 8)
            # Fill the bottom corners to make them square (tab connects to content)
            p.drawRect(QRectF(0, self.height() - 8, self.width(), 8))
        elif self._hovered:
            p.setBrush(QColor("#252240"))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(rect.adjusted(0, 2, 0, -2), 6, 6)
        p.end()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._on_click()
        super().mousePressEvent(event)


class NavChevronButton(QWidget):
    """Painted < or > chevron button for browser nav."""

    def __init__(self, direction, callback, parent=None):
        super().__init__(parent)
        self.setFixedSize(32, 32)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._direction = direction  # "left" or "right"
        self._callback = callback
        self._hovered = False

    def enterEvent(self, event):
        self._hovered = True
        self.update()

    def leaveEvent(self, event):
        self._hovered = False
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._callback()

    def paintEvent(self, event):
        from PyQt6.QtCore import QRectF, QPointF
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self._hovered:
            p.setBrush(QColor("#2d2a3e"))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(QRectF(0, 0, 32, 32), 8, 8)
        pen = QPen(QColor("#ccc" if self._hovered else "#888"))
        pen.setWidthF(1.8)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        p.setPen(pen)
        if self._direction == "left":
            p.drawPolyline([QPointF(19, 10), QPointF(13, 16), QPointF(19, 22)])
        else:
            p.drawPolyline([QPointF(13, 10), QPointF(19, 16), QPointF(13, 22)])
        p.end()


class UrlBar(QLineEdit):
    """URL bar that selects all text on click."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._just_focused = False

    def focusInEvent(self, event):
        super().focusInEvent(event)
        self._just_focused = True

    def mouseReleaseEvent(self, event):
        super().mouseReleaseEvent(event)
        if self._just_focused:
            self._just_focused = False
            url = self.text().strip().rstrip('/')
            if url in ("https://www.google.com", "https://google.com",
                       "http://www.google.com", "http://google.com"):
                self.clear()
            else:
                self.selectAll()


class NavHamburgerButton(QWidget):
    """Painted hamburger menu button for browser nav."""

    def __init__(self, callback, parent=None):
        super().__init__(parent)
        self.setFixedSize(32, 32)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._callback = callback
        self._hovered = False

    def enterEvent(self, event):
        self._hovered = True
        self.update()

    def leaveEvent(self, event):
        self._hovered = False
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._callback(self.mapToGlobal(event.pos()))

    def paintEvent(self, event):
        from PyQt6.QtCore import QRectF
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self._hovered:
            p.setBrush(QColor("#2d2a3e"))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(QRectF(0, 0, 32, 32), 8, 8)
        pen = QPen(QColor("#ccc" if self._hovered else "#888"))
        pen.setWidthF(1.8)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        p.setPen(pen)
        # Three horizontal lines
        p.drawLine(10, 11, 22, 11)
        p.drawLine(10, 16, 22, 16)
        p.drawLine(10, 21, 22, 21)
        p.end()


class NavReloadButton(QWidget):
    """Painted reload button for browser nav."""

    def __init__(self, callback, parent=None):
        super().__init__(parent)
        self.setFixedSize(32, 32)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self._callback = callback
        self._hovered = False

    def enterEvent(self, event):
        self._hovered = True
        self.update()

    def leaveEvent(self, event):
        self._hovered = False
        self.update()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._callback()

    def paintEvent(self, event):
        import math
        from PyQt6.QtCore import QRectF, QPointF
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        if self._hovered:
            p.setBrush(QColor("#2d2a3e"))
            p.setPen(Qt.PenStyle.NoPen)
            p.drawRoundedRect(QRectF(0, 0, 32, 32), 8, 8)
        color = QColor("#ccc" if self._hovered else "#888")
        pen = QPen(color)
        pen.setWidthF(1.8)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        p.setPen(pen)
        # Draw circular arc (~310 degrees, gap at upper-right)
        cx, cy, r = 16.0, 16.0, 7.5
        start_deg = 60
        span_deg = 310
        p.drawArc(QRectF(cx - r, cy - r, 2 * r, 2 * r),
                  start_deg * 16, span_deg * 16)
        # Arrowhead at the start of the arc, pointing clockwise
        a = math.radians(start_deg)
        ex, ey = cx + r * math.cos(a), cy - r * math.sin(a)
        tx, ty = math.sin(a), math.cos(a)        # CW tangent
        px, py = math.cos(a), -math.sin(a)        # outward normal
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(color)
        p.drawPolygon(QPolygonF([
            QPointF(ex + 3.5 * tx, ey + 3.5 * ty),          # tip
            QPointF(ex - 0.5 * tx + 2.2 * px,
                    ey - 0.5 * ty + 2.2 * py),               # outer base
            QPointF(ex - 0.5 * tx - 2.2 * px,
                    ey - 0.5 * ty - 2.2 * py),               # inner base
        ]))
        p.end()


class _LoudPage(QWebEnginePage):
    """QWebEnginePage that mirrors JS console messages to Python stderr.

    Used during Yomitan integration so missing chrome.* APIs fail visibly
    instead of silently no-op'ing in the WebView console.
    """

    _LEVELS = {0: 'INFO', 1: 'WARN', 2: 'ERROR'}

    def javaScriptConsoleMessage(self, level, message, line, source):
        try:
            key = level.value
        except AttributeError:
            key = int(level)
        tag = self._LEVELS.get(key, str(level))
        print(f'[webview {tag}] {source}:{line}  {message}', file=sys.stderr)


class BrowserTab(QWebEngineView):
    """A single browser tab that handles new-window requests."""

    def __init__(self, profile, browser_window):
        super().__init__()
        self._browser_window = browser_window
        page = _LoudPage(profile, self)
        self.setPage(page)

    def createWindow(self, window_type):
        return self._browser_window.add_tab()

    def contextMenuEvent(self, event):
        menu = self.createStandardContextMenu()
        menu.setStyleSheet(
            "QMenu {"
            "  background-color: #2b2640;"
            "  border: 1px solid #3d3755;"
            "  border-radius: 8px;"
            "  padding: 4px 0px;"
            "  color: #ddd;"
            "  font-size: 13px;"
            "}"
            "QMenu::item {"
            "  padding: 6px 32px 6px 16px;"
            "  border-radius: 4px;"
            "  margin: 2px 4px;"
            "}"
            "QMenu::item:selected {"
            "  background-color: #3d3755;"
            "  color: #fff;"
            "}"
            "QMenu::item:disabled {"
            "  color: #666;"
            "}"
            "QMenu::separator {"
            "  height: 1px;"
            "  background: #3d3755;"
            "  margin: 4px 8px;"
            "}"
            "QMenu::icon {"
            "  padding-left: 8px;"
            "}"
        )

        selected = self.page().selectedText().strip()
        if selected:
            menu.addSeparator()
            lookup_action = menu.addAction("Look up in dictionary")
            lookup_action.triggered.connect(lambda: self._lookup_selected(selected))

        menu.exec(event.globalPos())

    def _lookup_selected(self, text: str) -> None:
        """Trigger the overlay popup for *text* via the injected overlay script."""
        self.page().runJavaScript(
            f'window.__immersionLookup && window.__immersionLookup({json.dumps(text)});',
            QWebEngineScript.ScriptWorldId.ApplicationWorld,
        )


def _load_web_js(filename: str) -> str | None:
    """Return the contents of web/dictionary/<filename>, or None on error."""
    try:
        if getattr(sys, 'frozen', False):
            base = Path(sys._MEIPASS)
        else:
            base = Path(__file__).resolve().parent.parent.parent
        return (base / 'web' / 'dictionary' / filename).read_text(encoding='utf-8')
    except Exception:
        return None


class BrowserWindow(QMainWindow):
    _profile         = None   # shared persistent QWebEngineProfile
    _dict_handler    = None   # DictionaryUrlSchemeHandler (keeps Python ref alive)

    @classmethod
    def _get_profile(cls):
        if cls._profile is None:
            profile_path = str(Path.home() / ".immersion-suite" / "browser")
            cls._profile = QWebEngineProfile("immersion", None)
            cls._profile.setPersistentStoragePath(profile_path)
            cls._profile.setCachePath(profile_path + "/cache")
            cls._profile.setPersistentCookiesPolicy(
                QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies
            )

            # ── Dictionary: URL scheme handler ────────────────────────────────
            from dictionary.handler import DictionaryUrlSchemeHandler
            cls._dict_handler = DictionaryUrlSchemeHandler(cls._profile)
            cls._profile.installUrlSchemeHandler(b'immersion', cls._dict_handler)

        return cls._profile

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Immersion Browser")
        base_path = getattr(sys, '_MEIPASS', os.path.join(os.path.dirname(__file__), "..", ".."))
        icon_path = os.path.join(base_path, "installer", "icon.ico")
        if not os.path.exists(icon_path):
            icon_path = os.path.join(base_path, "icon.ico")
        self.setWindowIcon(QIcon(icon_path))
        self.setStyleSheet("background-color: #242038;")

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        # --- Tab bar row ---
        tab_row = QWidget()
        tab_row.setFixedHeight(42)
        tab_row.setStyleSheet("background-color: #1a1730;")
        tab_row_layout = QHBoxLayout(tab_row)
        tab_row_layout.setContentsMargins(10, 0, 10, 0)
        tab_row_layout.setSpacing(0)

        # Custom tab strip
        self.tab_strip = QWidget()
        self.tab_strip_layout = QHBoxLayout(self.tab_strip)
        self.tab_strip_layout.setContentsMargins(0, 0, 0, 0)
        self.tab_strip_layout.setSpacing(2)

        self.new_tab_btn = QPushButton("+")
        self.new_tab_btn.setFixedSize(34, 40)
        self.new_tab_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.new_tab_btn.setStyleSheet(
            "QPushButton { background: transparent; color: #666; border: none; "
            "font-size: 18px; border-radius: 6px; padding: 0; }"
            "QPushButton:hover { background: #2d2a3e; color: #ccc; }"
        )
        self.new_tab_btn.clicked.connect(lambda: self.add_tab(url="https://www.google.com"))

        tab_row_layout.addWidget(self.tab_strip)
        tab_row_layout.addStretch()

        layout.addWidget(tab_row)

        # --- Nav bar row ---
        nav_row = QWidget()
        nav_row.setFixedHeight(40)
        nav_row.setStyleSheet("background-color: #242038;")
        nav_layout = QHBoxLayout(nav_row)
        nav_layout.setContentsMargins(10, 4, 10, 4)
        nav_layout.setSpacing(6)

        self.back_btn = NavChevronButton("left", self._go_back)
        self.forward_btn = NavChevronButton("right", self._go_forward)
        self.reload_btn = NavReloadButton(self._reload)

        self.url_bar = UrlBar()
        self.url_bar.setPlaceholderText("Search or enter URL\u2026")
        self.url_bar.setFixedHeight(34)
        self.url_bar.setMaximumWidth(800)
        self.url_bar.setStyleSheet(
            "QLineEdit { background: #1a1730; color: #ddd; border: 1px solid transparent; "
            "border-radius: 17px; padding: 0px 16px; font-size: 15px; font-weight: 600; "
            "selection-background-color: #7c6af5; }"
            "QLineEdit:focus { border-color: #5a4fcf; }"
        )
        self.url_bar.returnPressed.connect(self._navigate)

        nav_layout.addWidget(self.back_btn)
        nav_layout.addWidget(self.forward_btn)
        nav_layout.addWidget(self.reload_btn)
        nav_layout.addStretch()
        nav_layout.addWidget(self.url_bar, 1)
        nav_layout.addStretch()
        self.hamburger_btn = NavHamburgerButton(self._show_hamburger_menu)
        nav_layout.addWidget(self.hamburger_btn)

        layout.addWidget(nav_row)

        # --- Progress bar ---
        self.progress_bar = QProgressBar()
        self.progress_bar.setFixedHeight(2)
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setStyleSheet(
            "QProgressBar { background: transparent; border: none; }"
            "QProgressBar::chunk { background: #7c6af5; border-radius: 1px; }"
        )
        self.progress_bar.hide()
        layout.addWidget(self.progress_bar)

        # --- Page stack ---
        self.page_stack = QStackedWidget()
        layout.addWidget(self.page_stack, 1)

        # --- Keyboard shortcuts ---
        QShortcut(QKeySequence("Ctrl+T"), self, lambda: self.add_tab(url="https://www.google.com"))
        QShortcut(QKeySequence("Ctrl+W"), self, self._close_current_tab)
        QShortcut(QKeySequence("Ctrl+L"), self, self._focus_url_bar)
        QShortcut(QKeySequence("Ctrl+R"), self, self._reload)
        QShortcut(QKeySequence("F5"), self, self._reload)
        QShortcut(QKeySequence("Ctrl+Tab"), self, self._next_tab)
        QShortcut(QKeySequence("Ctrl+Shift+Tab"), self, self._prev_tab)
        QShortcut(QKeySequence("Alt+Left"), self, self._go_back)
        QShortcut(QKeySequence("Alt+Right"), self, self._go_forward)

        self._tabs = []
        self._tab_buttons = []
        self._current_index = -1
        # Add the + button to tab strip (tabs insert before it)
        self.tab_strip_layout.addWidget(self.new_tab_btn)
        self.add_tab(url="https://www.google.com")
        self.showMaximized()

    # --- Tab management ---

    def add_tab(self, url=None):
        profile = self._get_profile()
        view = BrowserTab(profile, self)
        view.titleChanged.connect(lambda title, v=view: self._on_tab_title_changed(v, title))
        view.urlChanged.connect(lambda u, v=view: self._on_tab_url_changed(v, u))
        view.iconChanged.connect(lambda icon, v=view: self._on_tab_icon_changed(v, icon))
        view.loadStarted.connect(lambda: self.progress_bar.show())
        view.loadProgress.connect(self.progress_bar.setValue)
        view.loadFinished.connect(lambda: self.progress_bar.hide())

        index = len(self._tabs)
        tab_btn = TabButton(
            "New Tab",
            on_click=lambda idx=index: self._select_tab(idx),
            on_close=lambda idx=index: self._close_tab(idx),
        )

        self._tabs.append(view)
        self._tab_buttons.append(tab_btn)
        self.page_stack.addWidget(view)

        # Insert before the + button
        self.tab_strip_layout.insertWidget(self.tab_strip_layout.count() - 1, tab_btn)
        self._select_tab(index)

        if url:
            view.setUrl(QUrl(url))

        return view

    def _select_tab(self, index):
        if index < 0 or index >= len(self._tabs):
            return
        self._current_index = index
        for i, btn in enumerate(self._tab_buttons):
            btn.set_active(i == index)
        self.page_stack.setCurrentWidget(self._tabs[index])
        view = self._tabs[index]
        self.url_bar.setText(view.url().toString())
        self.url_bar.setCursorPosition(0)
        self.setWindowTitle("Immersion Browser")

    def _close_tab(self, index):
        if len(self._tabs) <= 1:
            self.close()
            return
        view = self._tabs.pop(index)
        btn = self._tab_buttons.pop(index)
        self.tab_strip_layout.removeWidget(btn)
        btn.deleteLater()
        self.page_stack.removeWidget(view)
        view.deleteLater()

        # Rebind click/close lambdas to correct indices
        for i, tb in enumerate(self._tab_buttons):
            tb._on_click = lambda idx=i: self._select_tab(idx)
            tb.close_btn._callback = lambda idx=i: self._close_tab(idx)

        new_index = min(index, len(self._tabs) - 1)
        self._select_tab(new_index)

    def _close_current_tab(self):
        self._close_tab(self._current_index)

    def _on_tab_title_changed(self, view, title):
        index = self._tabs.index(view) if view in self._tabs else -1
        if index >= 0:
            self._tab_buttons[index].set_title(title)
        if view == self._tabs[self._current_index]:
            self.setWindowTitle("Immersion Browser")

    def _on_tab_icon_changed(self, view, icon):
        index = self._tabs.index(view) if view in self._tabs else -1
        if index >= 0:
            self._tab_buttons[index].set_icon(icon)

    def _on_tab_url_changed(self, view, url):
        if view == self._tabs[self._current_index]:
            self.url_bar.setText(url.toString())
            self.url_bar.setCursorPosition(0)

    def _current_tab(self):
        if 0 <= self._current_index < len(self._tabs):
            return self._tabs[self._current_index]
        return None

    # --- Navigation ---

    def _show_hamburger_menu(self, pos):
        from PyQt6.QtWidgets import QMenu
        menu = QMenu(self)
        menu.setStyleSheet(
            "QMenu {"
            "  background-color: #2b2640;"
            "  border: 1px solid #3d3755;"
            "  border-radius: 8px;"
            "  padding: 4px 0px;"
            "  color: #ddd;"
            "  font-size: 13px;"
            "}"
            "QMenu::item {"
            "  padding: 6px 32px 6px 16px;"
            "  border-radius: 4px;"
            "  margin: 2px 4px;"
            "}"
            "QMenu::item:selected {"
            "  background-color: #3d3755;"
            "  color: #fff;"
            "}"
            "QMenu::separator {"
            "  height: 1px;"
            "  background: #3d3755;"
            "  margin: 4px 8px;"
            "}"
        )
        new_tab_action = menu.addAction("New Tab")
        new_tab_action.triggered.connect(
            lambda: self.add_tab(url="https://www.google.com"))
        menu.addSeparator()
        zoom_in = menu.addAction("Zoom In")
        zoom_out = menu.addAction("Zoom Out")
        zoom_reset = menu.addAction("Reset Zoom")
        zoom_in.triggered.connect(
            lambda: self._current_tab() and self._current_tab().setZoomFactor(
                self._current_tab().zoomFactor() + 0.1))
        zoom_out.triggered.connect(
            lambda: self._current_tab() and self._current_tab().setZoomFactor(
                self._current_tab().zoomFactor() - 0.1))
        zoom_reset.triggered.connect(
            lambda: self._current_tab() and self._current_tab().setZoomFactor(1.0))
        menu.addSeparator()
        history_action = menu.addAction("History")
        history_action.setEnabled(False)
        settings_action = menu.addAction("Settings")
        settings_action.setEnabled(False)
        menu.exec(pos)

    def _navigate(self):
        text = self.url_bar.text().strip()
        if not text:
            return
        tab = self._current_tab()
        if not tab:
            return
        if self._looks_like_url(text):
            if not text.startswith(("http://", "https://")):
                text = "https://" + text
            tab.setUrl(QUrl(text))
        else:
            query = urllib.parse.quote_plus(text)
            tab.setUrl(QUrl(f"https://www.google.com/search?q={query}"))

    @staticmethod
    def _looks_like_url(text):
        if " " in text:
            return False
        if "." in text or ":" in text or text.startswith("localhost"):
            return True
        return False

    def _go_back(self):
        tab = self._current_tab()
        if tab:
            tab.back()

    def _go_forward(self):
        tab = self._current_tab()
        if tab:
            tab.forward()

    def _reload(self):
        tab = self._current_tab()
        if tab:
            tab.reload()

    def _focus_url_bar(self):
        self.url_bar.setFocus()
        self.url_bar.selectAll()

    def _next_tab(self):
        count = len(self._tabs)
        if count > 1:
            self._select_tab((self._current_index + 1) % count)

    def _prev_tab(self):
        count = len(self._tabs)
        if count > 1:
            self._select_tab((self._current_index - 1) % count)

from PyQt6.QtCore import QThread, pyqtSignal
import fsrs_optimizer


class OptimizeThread(QThread):
    """Runs the FSRS parameter optimiser off the UI thread."""
    progress = pyqtSignal(int, int, float)   # iteration, total, best_loss
    done = pyqtSignal(list, int)             # params, review_count
    insufficient = pyqtSignal(int)           # review_count (< MIN_REVIEWS)
    error = pyqtSignal(str)

    def __init__(self, deck_ids):
        super().__init__()
        self.deck_ids = deck_ids

    def run(self):
        try:
            params, count = fsrs_optimizer.optimize(
                self.deck_ids,
                on_progress=lambda i, n, loss: self.progress.emit(i, n, loss),
            )
            if params is None:
                self.insufficient.emit(count)
            else:
                self.done.emit(params, count)
        except Exception as e:
            self.error.emit(str(e))

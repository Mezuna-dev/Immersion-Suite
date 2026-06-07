from abc import ABC, abstractmethod


class DictionaryModule(ABC):
    """Base class for all dictionary modules.

    Each module wraps one dictionary data source (e.g. JMdict, KANJIDIC,
    a Chinese dictionary, etc.).  Subclass this and implement the three
    abstract members to plug a new dictionary into the lookup pipeline.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name shown in the UI (e.g. 'JMdict Japanese-English')."""
        ...

    @property
    @abstractmethod
    def language(self) -> str:
        """ISO 639-1 language code for the source language (e.g. 'ja', 'zh')."""
        ...

    @property
    @abstractmethod
    def is_available(self) -> bool:
        """True if the underlying data file exists and is ready for queries."""
        ...

    @abstractmethod
    def lookup_text(self, text: str) -> dict:
        """Scan *text* from its start and return the best dictionary match.

        The implementation should try progressively shorter substrings
        (longest-match-first) so callers don't need to know the word
        boundaries in advance.

        Return value shape::

            {
                'matched': str | None,   # the exact substring that was found
                'entries': [             # list of matching entries
                    {
                        'kanji_forms':   list[str],
                        'reading_forms': list[str],
                        'senses': [
                            {'pos': list[str], 'glosses': list[str]},
                            ...
                        ],
                    },
                    ...
                ],
            }
        """
        ...

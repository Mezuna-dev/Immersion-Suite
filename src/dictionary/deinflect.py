"""Japanese deinflection engine.

Generates candidate dictionary forms from conjugated words by applying
suffix-replacement rules.  Candidates are validated by the caller
(typically via dictionary lookup).

Rules cover godan/ichidan verbs, する/くる irregulars, i-adjectives,
and common auxiliary chains (ている, てしまう, たい, etc.).
"""


def _build_rules() -> list[tuple[str, str, str]]:
    """Build (inflected_suffix, base_suffix, reason) rule table."""
    rules: list[tuple[str, str, str]] = []

    # ── Godan verbs ──────────────────────────────────────────────────────────
    # (dict_ending, te_stem+te, past, a_stem, i_stem, e_stem, o_stem)
    _godan = [
        ('う', 'って', 'った', 'わ', 'い', 'え', 'お'),
        ('つ', 'って', 'った', 'た', 'ち', 'て', 'と'),
        ('る', 'って', 'った', 'ら', 'り', 'れ', 'ろ'),
        ('く', 'いて', 'いた', 'か', 'き', 'け', 'こ'),
        ('ぐ', 'いで', 'いだ', 'が', 'ぎ', 'げ', 'ご'),
        ('す', 'して', 'した', 'さ', 'し', 'せ', 'そ'),
        ('ぬ', 'んで', 'んだ', 'な', 'に', 'ね', 'の'),
        ('ぶ', 'んで', 'んだ', 'ば', 'び', 'べ', 'ぼ'),
        ('む', 'んで', 'んだ', 'ま', 'み', 'め', 'も'),
    ]

    for d, te, ta, a, i, e, o in _godan:
        # Basic conjugations
        rules.append((te, d, 'te-form'))
        rules.append((ta, d, 'past'))
        rules.append((a + 'ない', d, 'negative'))
        rules.append((a + 'なかった', d, 'negative past'))
        rules.append((i + 'ます', d, 'polite'))
        rules.append((i + 'ました', d, 'polite past'))
        rules.append((i + 'ません', d, 'polite negative'))
        rules.append((e + 'る', d, 'potential'))
        rules.append((a + 'れる', d, 'passive'))
        rules.append((a + 'せる', d, 'causative'))
        rules.append((a + 'せられる', d, 'causative passive'))
        rules.append((o + 'う', d, 'volitional'))
        rules.append((e + 'ば', d, 'conditional'))
        rules.append((e, d, 'imperative'))
        rules.append((ta + 'ら', d, 'conditional'))
        # Progressive / auxiliary chains
        rules.append((te + 'いる', d, 'progressive'))
        rules.append((te + 'いた', d, 'progressive past'))
        rules.append((te + 'いない', d, 'progressive negative'))
        rules.append((te + 'る', d, 'progressive'))      # contracted
        rules.append((te + 'た', d, 'progressive past'))  # contracted
        rules.append((te + 'ある', d, 'resultative'))
        rules.append((te + 'しまう', d, 'completive'))
        rules.append((te + 'しまった', d, 'completive past'))
        rules.append((te + 'みる', d, 'try'))
        rules.append((te + 'くる', d, 'come to'))
        rules.append((te + 'いく', d, 'go on'))
        rules.append((te + 'くれる', d, 'do for me'))
        rules.append((te + 'もらう', d, 'have done'))
        rules.append((te + 'あげる', d, 'do for'))
        # Want-to
        rules.append((i + 'たい', d, 'want to'))
        rules.append((i + 'たかった', d, 'wanted to'))
        rules.append((i + 'たくない', d, 'don\'t want to'))

    # ── Ichidan verbs (drop る, add inflection) ──────────────────────────────
    _ichidan = [
        ('て', 'る', 'te-form'),
        ('た', 'る', 'past'),
        ('ない', 'る', 'negative'),
        ('なかった', 'る', 'negative past'),
        ('ます', 'る', 'polite'),
        ('ました', 'る', 'polite past'),
        ('ません', 'る', 'polite negative'),
        ('られる', 'る', 'potential'),
        ('させる', 'る', 'causative'),
        ('させられる', 'る', 'causative passive'),
        ('ろ', 'る', 'imperative'),
        ('よう', 'る', 'volitional'),
        ('れば', 'る', 'conditional'),
        ('たら', 'る', 'conditional'),
        ('ている', 'る', 'progressive'),
        ('ていた', 'る', 'progressive past'),
        ('ていない', 'る', 'progressive negative'),
        ('てる', 'る', 'progressive'),       # contracted
        ('てた', 'る', 'progressive past'),   # contracted
        ('てある', 'る', 'resultative'),
        ('てしまう', 'る', 'completive'),
        ('てしまった', 'る', 'completive past'),
        ('てみる', 'る', 'try'),
        ('てくる', 'る', 'come to'),
        ('ていく', 'る', 'go on'),
        ('てくれる', 'る', 'do for me'),
        ('てもらう', 'る', 'have done'),
        ('てあげる', 'る', 'do for'),
        ('たい', 'る', 'want to'),
        ('たかった', 'る', 'wanted to'),
        ('たくない', 'る', 'don\'t want to'),
    ]
    rules.extend(_ichidan)

    # ── する (suru) ──────────────────────────────────────────────────────────
    _suru = [
        ('した', 'する', 'past'),
        ('して', 'する', 'te-form'),
        ('しない', 'する', 'negative'),
        ('しなかった', 'する', 'negative past'),
        ('します', 'する', 'polite'),
        ('しました', 'する', 'polite past'),
        ('しません', 'する', 'polite negative'),
        ('できる', 'する', 'potential'),
        ('される', 'する', 'passive'),
        ('させる', 'する', 'causative'),
        ('しよう', 'する', 'volitional'),
        ('すれば', 'する', 'conditional'),
        ('したら', 'する', 'conditional'),
        ('しろ', 'する', 'imperative'),
        ('せよ', 'する', 'imperative'),
        ('している', 'する', 'progressive'),
        ('していた', 'する', 'progressive past'),
        ('してる', 'する', 'progressive'),
        ('してた', 'する', 'progressive past'),
        ('したい', 'する', 'want to'),
        ('してしまう', 'する', 'completive'),
        ('してしまった', 'する', 'completive past'),
    ]
    rules.extend(_suru)

    # ── 来る (kuru) - kana ───────────────────────────────────────────────────
    _kuru = [
        ('きた', 'くる', 'past'),
        ('きて', 'くる', 'te-form'),
        ('こない', 'くる', 'negative'),
        ('こなかった', 'くる', 'negative past'),
        ('きます', 'くる', 'polite'),
        ('きました', 'くる', 'polite past'),
        ('きません', 'くる', 'polite negative'),
        ('こられる', 'くる', 'potential'),
        ('こさせる', 'くる', 'causative'),
        ('こよう', 'くる', 'volitional'),
        ('くれば', 'くる', 'conditional'),
        ('きたら', 'くる', 'conditional'),
        ('こい', 'くる', 'imperative'),
        ('きている', 'くる', 'progressive'),
        ('きていた', 'くる', 'progressive past'),
        ('きたい', 'くる', 'want to'),
    ]
    rules.extend(_kuru)

    # ── 来る (kuru) - kanji ──────────────────────────────────────────────────
    _kuru_k = [
        ('来た', '来る', 'past'),
        ('来て', '来る', 'te-form'),
        ('来ない', '来る', 'negative'),
        ('来なかった', '来る', 'negative past'),
        ('来ます', '来る', 'polite'),
        ('来ました', '来る', 'polite past'),
        ('来ません', '来る', 'polite negative'),
        ('来られる', '来る', 'potential'),
        ('来させる', '来る', 'causative'),
        ('来よう', '来る', 'volitional'),
        ('来れば', '来る', 'conditional'),
        ('来たら', '来る', 'conditional'),
        ('来い', '来る', 'imperative'),
        ('来ている', '来る', 'progressive'),
        ('来ていた', '来る', 'progressive past'),
        ('来たい', '来る', 'want to'),
    ]
    rules.extend(_kuru_k)

    # ── い-adjective ─────────────────────────────────────────────────────────
    _adj_i = [
        ('くない', 'い', 'negative'),
        ('かった', 'い', 'past'),
        ('くなかった', 'い', 'negative past'),
        ('くて', 'い', 'te-form'),
        ('ければ', 'い', 'conditional'),
        ('く', 'い', 'adverbial'),
        ('さ', 'い', 'noun form'),
    ]
    rules.extend(_adj_i)

    # ── Irregulars ───────────────────────────────────────────────────────────
    rules.append(('行って', '行く', 'te-form'))
    rules.append(('行った', '行く', 'past'))
    rules.append(('行っている', '行く', 'progressive'))
    rules.append(('行っていた', '行く', 'progressive past'))
    rules.append(('行ってる', '行く', 'progressive'))

    # ── ます-stem as noun / compound ─────────────────────────────────────────
    # Many i-stem forms are used as nouns (e.g. 読み, 話し).
    # The ichidan rule 'ます' → 'る' already covers polite; this adds the bare
    # i-stem for godan (already covered by imperative rule e → d, which
    # coincidentally produces some stems, but not all match).

    # Sort longest-suffix-first so greedy matching works correctly.
    rules.sort(key=lambda r: len(r[0]), reverse=True)
    return rules


RULES: list[tuple[str, str, str]] = _build_rules()


def deinflect(word: str) -> list[dict]:
    """Return candidate base forms for a conjugated *word*.

    Each result is ``{'word': str, 'reason': str}``.
    Results are ordered longest-suffix-first (most specific rule wins).
    Duplicates are suppressed.
    """
    if len(word) < 2:
        return []

    candidates: list[dict] = []
    seen: set[str] = set()

    for suffix_in, suffix_out, reason in RULES:
        if not word.endswith(suffix_in):
            continue
        stem = word[:-len(suffix_in)]
        if not stem:
            continue
        base = stem + suffix_out
        if base in seen:
            continue
        seen.add(base)
        candidates.append({'word': base, 'reason': reason})

    return candidates

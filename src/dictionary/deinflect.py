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
        # Want-to
        rules.append((i + 'たい', d, 'want to'))
        rules.append((i + 'たかった', d, 'wanted to'))
        rules.append((i + 'たくない', d, 'don\'t want to'))
        # NB: auxiliary chains (ている, てくれる, てしまう, …) are NOT folded into
        # the verb classes. They are handled generically by the te-form
        # auxiliary rules below, which strip the auxiliary down to the bare
        # て/で-form; iteration then reduces that form via the rules above.
        # This is what lets する/くる auxiliaries work (してくれる → して → する)
        # instead of being mis-parsed as ichidan (してくれる → しる/汁).

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
        ('れる', 'る', 'passive'),          # ら-nuki potential / passive
        ('させる', 'る', 'causative'),
        ('させられる', 'る', 'causative passive'),
        ('ろ', 'る', 'imperative'),
        ('よ', 'る', 'imperative'),
        ('よう', 'る', 'volitional'),
        ('れば', 'る', 'conditional'),
        ('たら', 'る', 'conditional'),
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
        ('したい', 'する', 'want to'),
        ('したかった', 'する', 'wanted to'),
        ('したくない', 'する', 'don\'t want to'),
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

    # ── Te-form auxiliaries ──────────────────────────────────────────────────
    # An auxiliary attaches to the て/で-form of any verb (Vて + aux).  Each rule
    # strips the auxiliary and restores the bare て/で-form; iteration then
    # reduces that form to the dictionary verb via the rules above.  The
    # auxiliary's own conjugation (past, polite, negative, te-form, …) is also
    # handled by iteration, so only the dictionary form of each auxiliary is
    # listed here.  Both て and で variants are needed (して vs 読んで).
    _aux = [
        ('いる', 'progressive'),    # ～ている
        ('いく', 'go on'),          # ～ていく
        ('くる', 'come to'),        # ～てくる
        ('ある', 'resultative'),    # ～てある
        ('おく', 'in advance'),     # ～ておく
        ('しまう', 'completive'),   # ～てしまう
        ('みる', 'try'),            # ～てみる
        ('くれる', 'do for me'),    # ～てくれる
        ('くださる', 'do for me'),  # ～てくださる
        ('もらう', 'have done'),    # ～てもらう
        ('いただく', 'have done'),  # ～ていただく
        ('あげる', 'do for'),       # ～てあげる
        ('やる', 'do for'),         # ～てやる
    ]
    for aux, reason in _aux:
        rules.append(('て' + aux, 'て', reason))
        rules.append(('で' + aux, 'で', reason))

    # Common spoken contractions of て-auxiliaries.
    _aux_contract = [
        ('てる', 'て', 'progressive'),    # ～てる  = ～ている
        ('でる', 'で', 'progressive'),
        ('てた', 'て', 'progressive past'),
        ('でた', 'で', 'progressive past'),
        ('てない', 'て', 'progressive negative'),
        ('でない', 'で', 'progressive negative'),
        ('とく', 'て', 'in advance'),     # ～とく = ～ておく
        ('どく', 'で', 'in advance'),
        ('ちゃう', 'て', 'completive'),   # ～ちゃう = ～てしまう
        ('じゃう', 'で', 'completive'),
        ('ちゃった', 'て', 'completive past'),
        ('じゃった', 'で', 'completive past'),
    ]
    rules.extend(_aux_contract)

    # Sort longest-suffix-first so greedy matching works correctly.
    rules.sort(key=lambda r: len(r[0]), reverse=True)
    return rules


RULES: list[tuple[str, str, str]] = _build_rules()


_MAX_DEPTH = 6


def deinflect(word: str) -> list[dict]:
    """Return candidate base forms for a conjugated *word*.

    Each result is ``{'word': str, 'reason': str}``.

    Deinflection is iterative: rules are applied repeatedly so stacked
    conjugations resolve in one call.  For example ``取り残されている`` needs two
    steps (strip ``ている`` → ``取り残される``, then strip the passive →
    ``取り残す``); both candidates are returned, with ``reason`` holding the
    accumulated chain (e.g. ``"progressive < passive"``).

    Results are ordered by chain length (fewest transforms first), so the
    caller's "shortest chain wins" priority is preserved.  Duplicates are
    suppressed and the search is bounded by ``_MAX_DEPTH`` and a visited set.
    """
    if len(word) < 2:
        return []

    candidates: list[dict] = []
    seen: set[str] = {word}
    # Frontier of (form, reason_chain) still to expand. The original word seeds
    # it with an empty chain but is never emitted as its own candidate.
    frontier: list[tuple[str, str]] = [(word, '')]

    for _ in range(_MAX_DEPTH):
        next_frontier: list[tuple[str, str]] = []
        for form, chain in frontier:
            for suffix_in, suffix_out, reason in RULES:
                if not form.endswith(suffix_in):
                    continue
                stem = form[:-len(suffix_in)]
                base = stem + suffix_out
                # An empty stem means the form *is* the whole rule (e.g. the
                # irregular 行った→行く, した→する). Keep those, but drop the
                # 1-char garbage generic godan rules would yield (った→う).
                if not stem and len(base) < 2:
                    continue
                if base in seen:
                    continue
                seen.add(base)
                new_chain = f'{chain} < {reason}' if chain else reason
                candidates.append({'word': base, 'reason': new_chain})
                next_frontier.append((base, new_chain))
        if not next_frontier:
            break
        frontier = next_frontier

    return candidates

"""Build broadcast overlay documents. Every overlay is validated before it leaves this module."""

from kickstream.contracts import (
    KeyMoment,
    LowerThirdData,
    Narrative,
    Overlay,
    PressureMapData,
    PressureSnapshot,
    Recap,
    RecapCardData,
    StatCardData,
    StatRow,
    StatsSnapshot,
)
from kickstream.domain.labels import FACT_LABELS, KIND_LABELS
from kickstream.domain.types import Language

_DURATION_MS = {"lower_third": 6000, "stat_card": 8000, "pressure_map": 8000, "recap_card": 15000}
_STAT_ROWS = ("possession", "shots", "shots_on_target", "xg")


def _overlay(
    overlay_id: str,
    match_id: str,
    minute: int,
    kind: str,
    language: Language | None,
    sources: list[str],
    data,
) -> Overlay:
    overlay = Overlay(
        id=overlay_id,
        match_id=match_id,
        minute=minute,
        kind=kind,
        language=language,
        duration_ms=_DURATION_MS[kind],
        sources=sources,
        data=data,
    )
    return Overlay.model_validate(overlay.model_dump())


def _title_case(label: str) -> str:
    return label[:1].upper() + label[1:]


def lower_third(overlay_id: str, narrative: Narrative, moment: KeyMoment, team_name: str) -> Overlay:
    data = LowerThirdData(
        headline=KIND_LABELS[narrative.language][moment.kind],
        subline=narrative.text,
        team=team_name,
        minute=narrative.minute,
    )
    return _overlay(
        overlay_id,
        narrative.match_id,
        narrative.minute,
        "lower_third",
        narrative.language,
        [narrative.id, moment.id],
        data,
    )


def stat_card(overlay_id: str, snapshot: StatsSnapshot, language: Language) -> Overlay:
    labels = FACT_LABELS[language]
    rows = [
        StatRow(
            label=_title_case(labels[name]),
            home=getattr(snapshot.home, name),
            away=getattr(snapshot.away, name),
        )
        for name in _STAT_ROWS
    ]
    return _overlay(
        overlay_id,
        snapshot.match_id,
        snapshot.minute,
        "stat_card",
        language,
        [snapshot.id],
        StatCardData(stat_rows=rows),
    )


def pressure_map(overlay_id: str, snapshot: PressureSnapshot) -> Overlay:
    data = PressureMapData(cols=snapshot.cols, rows=snapshot.rows, home=snapshot.home, away=snapshot.away)
    return _overlay(overlay_id, snapshot.match_id, snapshot.minute, "pressure_map", None, [snapshot.id], data)


def recap_card(overlay_id: str, recap: Recap) -> Overlay:
    data = RecapCardData(
        title=recap.title, score=f"{recap.score_home}-{recap.score_away}", bullets=recap.bullets
    )
    return _overlay(overlay_id, recap.match_id, recap.minute, "recap_card", recap.language, [recap.id], data)

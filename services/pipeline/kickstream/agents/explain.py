"""Explainability Agent: decides what deserves a "why this matters", and has it written.

Deciding is this module's work. The writing is done by an explainer behind a port: a scripted one that
always works, and a model-backed one when a model is configured.
"""

import asyncio
import logging

from kickstream.agents.base import Declared
from kickstream.agents.tactics import PATTERN_PHRASES
from kickstream.contracts import Explanation, Highlight, Prediction, TacticalInsight
from kickstream.domain.recent import make_room
from kickstream.domain.types import MODES, SIDES, Side
from kickstream.ports.explainer import ExplainContext, Explainer, ExplainError, WrittenExplanation

log = logging.getLogger(__name__)

TACTICS_GAP_MIN = 5
PREDICTION_GAP_MIN = 4
PREDICTION_MOVE = 0.12  # how far the odds must move to be worth explaining


def _percent(value: float) -> str:
    return f"{value * 100:.0f}%"


class ExplainabilityAgent:
    declared = Declared(
        id="explainability",
        name="Explainability Agent",
        description='Writes clear "why this matters" explanations.',
        instructions=(
            "Explain a finding only when it is news: a side's patterns changed, the odds moved by twelve "
            "points or more, or a hidden event was found. Write it twice, once in plain words for a fan and "
            "once with the numbers for an analyst: a short headline, then one or two sentences on why it "
            "matters. Use only the facts given with the finding, and list them as evidence."
        ),
        triggers=("tactics", "prediction", "highlight"),
        tools=(
            ("is_news", "Compares a finding with the last one explained."),
            ("facts", "Collects the numbers behind a finding as labelled facts."),
            ("write", "Has the explainer write the fan and analyst wording, from a script or a model."),
        ),
        outputs=("explanation",),
        upstream=("tactical_analyst", "prediction", "highlights"),
    )
    accepts = (TacticalInsight, Prediction, Highlight)

    def __init__(self, names: dict[Side, str]) -> None:
        self.note = ""
        self._names = names
        self._patterns: dict[Side, tuple[str, ...]] = {side: () for side in SIDES}
        self._tactics_minute = -99
        self._odds: tuple[float, float, float] | None = None
        self._prediction_minute = -99

    def consider(self, payload: TacticalInsight | Prediction | Highlight) -> list[ExplainContext]:
        if isinstance(payload, TacticalInsight):
            return self._tactics(payload)
        if isinstance(payload, Prediction):
            return self._prediction(payload)
        return self._highlight(payload) if payload.kind == "hidden" else []

    def _context(self, subject_id, kind, topic, minute, side, facts, evidence=()) -> ExplainContext:
        return ExplainContext(
            subject_id=subject_id,
            kind=kind,
            topic=topic,
            minute=minute,
            home=self._names["home"],
            away=self._names["away"],
            side=side,
            facts=tuple(facts),
            evidence=(subject_id, *evidence),
        )

    def _tactics(self, insight: TacticalInsight) -> list[ExplainContext]:
        teams = {"home": insight.home, "away": insight.away}
        news = [
            (side, pattern)
            for side in SIDES
            for pattern in teams[side].patterns
            if pattern not in self._patterns[side]
        ]
        rested = insight.minute - self._tactics_minute >= TACTICS_GAP_MIN
        if not news or not rested:
            return []
        for side in SIDES:
            self._patterns[side] = tuple(teams[side].patterns)
        self._tactics_minute = insight.minute
        side, pattern = news[0]
        team = teams[side]
        facts = [
            ("pattern", PATTERN_PHRASES[pattern]),
            ("pressure", f"{team.pressure:.0f} out of 100"),
            ("tempo", f"{team.tempo:.1f} passes a minute"),
            ("field tilt", f"{team.field_tilt:.0f}%"),
            ("average move", f"{team.avg_sequence:.1f} touches"),
            ("left, centre and right", ", ".join(_percent(share) for share in team.lanes)),
            ("rhythm", insight.rhythm),
        ]
        return [self._context(insight.id, "tactics", f"pattern:{pattern}", insight.minute, side, facts)]

    def _prediction(self, prediction: Prediction) -> list[ExplainContext]:
        odds = (prediction.win_home, prediction.draw, prediction.win_away)
        if self._odds is None:
            self._odds = odds
            return []
        moves = [now - before for now, before in zip(odds, self._odds, strict=True)]
        rested = prediction.minute - self._prediction_minute >= PREDICTION_GAP_MIN
        if max(abs(move) for move in moves) < PREDICTION_MOVE or not rested:
            return []
        self._prediction_minute = prediction.minute
        gained: Side = "home" if moves[0] >= moves[2] else "away"
        before, self._odds = self._odds, odds
        index = 0 if gained == "home" else 2
        facts = [
            ("win chance before", _percent(before[index])),
            ("win chance now", _percent(odds[index])),
            ("draw chance now", _percent(odds[1])),
            ("opponent's win chance now", _percent(odds[2 - index])),
            (
                "chance to score in the next ten minutes",
                _percent(prediction.next_goal_home if gained == "home" else prediction.next_goal_away),
            ),
        ]
        return [
            self._context(prediction.id, "prediction", "prediction:swing", prediction.minute, gained, facts)
        ]

    def _highlight(self, highlight: Highlight) -> list[ExplainContext]:
        facts = [("what happened", highlight.title), ("why it was chosen", highlight.reason)]
        return [
            self._context(
                highlight.id,
                "highlight",
                f"highlight:{highlight.category}",
                highlight.minute,
                highlight.team,
                facts,
                highlight.event_ids[:3],
            )
        ]


def _require_complete(written: dict) -> None:
    for mode in MODES:
        item = written.get(mode)
        if not isinstance(item, WrittenExplanation):
            raise ExplainError(f"missing the {mode} wording")
        if not (item.headline.strip() and item.why.strip()):
            raise ExplainError(f"blank text in the {mode} wording")


class ExplainService:
    """Chooses between the model-backed explainer and the scripted one for each finding."""

    def __init__(
        self,
        fallback: Explainer,
        primary: Explainer | None = None,
        *,
        max_calls: int = 20,
        timeout_s: float = 20.0,
    ) -> None:
        self._fallback = fallback
        self._primary = primary
        self._max_calls = max_calls
        self._timeout_s = timeout_s
        self._spent: dict[str, int] = {}

    @property
    def has_model(self) -> bool:
        return self._primary is not None

    async def explain(self, match_id: str, ctx: ExplainContext) -> list[Explanation]:
        written, source = await self._write(match_id, ctx)
        return [
            Explanation(
                id=f"{ctx.subject_id}-x-{mode}",
                match_id=match_id,
                minute=ctx.minute,
                subject_id=ctx.subject_id,
                subject_kind=ctx.kind,
                mode=mode,
                headline=written[mode].headline.strip(),
                why=written[mode].why.strip(),
                evidence=[f"{label}: {value}" for label, value in ctx.facts],
                source=source,
                agent=written[mode].agent,
                team=ctx.side,
            )
            for mode in MODES
        ]

    async def _write(self, match_id: str, ctx: ExplainContext) -> tuple[dict, str]:
        if self._primary is not None and self._spent.get(match_id, 0) < self._max_calls:
            make_room(self._spent, match_id)
            self._spent[match_id] = self._spent.get(match_id, 0) + 1
            try:
                written = await asyncio.wait_for(self._primary.explain(ctx), self._timeout_s)
                _require_complete(written)
                return written, "agent"
            except Exception as exc:  # noqa: BLE001 - every model failure falls back to the script
                log.warning(
                    "the explainer failed for %s in %s (%s); using the script", ctx.topic, match_id, exc
                )
        return await self._fallback.explain(ctx), "scripted"

"""Explanations written from templates. Needs no network; used whenever a model is not."""

from kickstream.domain.types import Mode
from kickstream.ports.explainer import ExplainContext, WrittenExplanation

AGENT = "scripted"

# Why each tactical pattern matters, for a fan. The analyst wording adds the numbers.
_PATTERN_WHY = {
    "high_press": "They are not letting {opponent} settle: win it near the box and the chance comes quickly.",
    "wing_overload_left": "Most of their play is going down the left, so that is where the next chance is likely to start.",
    "wing_overload_right": "Most of their play is going down the right, so that is where the next chance is likely to start.",
    "central_play": "They are going straight through the middle, the shortest way to goal and the most crowded.",
    "counter_attack": "They are happy to let {opponent} come on and then hit the space left behind.",
    "patient_build_up": "They are keeping the ball and waiting for a gap, which wears a defence down.",
    "direct_play": "They are getting it forward early instead of passing around, looking for a quick chance.",
    "low_block": "They are defending deep with numbers behind the ball, which leaves {opponent} little room near goal.",
}
_HIGHLIGHT_WHY = {
    "long_sequence": "Moves this long pull a defence out of shape, even when they do not end in a goal.",
    "big_save": "It will not make the headlines, but that save keeps the score where it is.",
    "dangerous_turnover": "Winning the ball that close to goal is the quickest route to a chance.",
    "tactical_foul": "A cheap foul here stopped an attack before it became a chance.",
    "unsung_player": "No goal, but much of the side's play has gone through this player.",
}


class ScriptedExplainer:
    model = "scripted"

    async def explain(self, ctx: ExplainContext) -> dict[Mode, WrittenExplanation]:
        headline, fan, analyst = self._write(ctx)
        return {
            "fan": WrittenExplanation(headline, fan, AGENT),
            "analyst": WrittenExplanation(headline, analyst, AGENT),
        }

    @staticmethod
    def _write(ctx: ExplainContext) -> tuple[str, str, str]:
        team = ctx.team or "The game"
        opponent = ctx.away if ctx.side == "home" else ctx.home
        kind, _, detail = ctx.topic.partition(":")
        if kind == "pattern":
            headline = f"{team} are {ctx.fact('pattern')}"
            fan = _PATTERN_WHY[detail].format(opponent=opponent)
            analyst = (
                f"{fan} Over the last ten minutes: pressure {ctx.fact('pressure')}, {ctx.fact('tempo')}, "
                f"field tilt {ctx.fact('field tilt')}, moves of {ctx.fact('average move')}, and "
                f"{ctx.fact('left, centre and right')} of their play on the left, centre and right."
            )
            return headline, fan, analyst
        if kind == "prediction":
            headline = f"The odds have moved towards {team}"
            fan = (
                f"{team}'s chance of winning has gone from {ctx.fact('win chance before')} to "
                f"{ctx.fact('win chance now')}. The game is tilting their way."
            )
            rival = ctx.fact("opponent's win chance now")
            analyst = (
                f"{fan} A draw is now {ctx.fact('draw chance now')} and a {opponent} win {rival}; {team} have a "
                f"{ctx.fact('chance to score in the next ten minutes')} chance of scoring in the next ten minutes."
            )
            return headline, fan, analyst
        headline = ctx.fact("what happened", "A moment worth a second look")
        fan = _HIGHLIGHT_WHY.get(
            detail, "It is the kind of moment that is easy to miss and worth a second look."
        )
        return headline, fan, f"{fan} {ctx.fact('why it was chosen')}"

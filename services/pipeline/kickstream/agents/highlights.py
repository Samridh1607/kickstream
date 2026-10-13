"""Highlights Agent: ranks the key moments, and finds the events a highlight reel would otherwise miss."""

from kickstream.agents.base import POSSESSION, Declared
from kickstream.agents.squad import Squad
from kickstream.contracts import Highlight, KeyMoment, PlayerReport, PlayEvent
from kickstream.domain.labels import fact_text
from kickstream.domain.pitch import attacking_x, xg
from kickstream.domain.types import SIDES, Side, other

KEY_SCORE = {
    "goal": 95.0,
    "red_card": 85.0,
    "big_chance": 70.0,
    "momentum_swing": 55.0,
    "sustained_pressure": 50.0,
}
KEY_TITLE = {
    "goal": "Goal for {team}",
    "red_card": "Red card for {team}",
    "big_chance": "Big chance for {team}",
    "momentum_swing": "{team} take control",
    "sustained_pressure": "{team} keep up the pressure",
}
LONG_MOVE = 8  # touches in one move
SAVE_XG = (0.12, 0.30)  # a good save, short of the big chance the analytics already call out
HIGH_WIN = 62.0  # how far up the pitch a ball must be won to count
BREAK_DANGER = 0.3  # how threatening a move must be for the foul that stops it to matter
UNSUNG_TOUCHES = 20
UNSUNG_ACCURACY = 80.0
PHASE_PHRASES = {
    "build_up": "building from the back",
    "progression": "moving through midfield",
    "final_third": "in the final third",
    "set_piece": "on a set piece",
    "transition": "breaking forward",
    "defending": "defending",
    "restart": "restarting",
}
COOLDOWN_MIN = {"long_sequence": 5, "dangerous_turnover": 6, "tactical_foul": 8, "big_save": 0}


class HighlightsAgent:
    declared = Declared(
        id="highlights",
        name="Highlights Agent",
        description="Selects key moments and hidden events.",
        instructions=(
            "Score every key moment from 0 to 100 so the best can be picked. Then look for what the key "
            "moments miss: a long passing move, a good save from a shot that was not a big chance, a ball "
            "won high up the pitch, a foul that stopped a break, and at each interval the player who did "
            "the most without scoring. Say in one sentence why each was chosen, using only its numbers."
        ),
        triggers=("key_moment", "play", "players"),
        tools=(
            ("rank", "Scores a key moment by its kind and its numbers."),
            ("moves", "Follows each possession sequence to its end."),
            ("hidden_events", "Tests each event against the hidden-event rules, with a cooldown per side."),
            ("unsung", "Finds the busiest accurate passer without a goal."),
        ),
        outputs=("highlight",),
        upstream=("event_interpreter", "player_tracking"),
    )
    accepts = (KeyMoment, PlayEvent, PlayerReport)

    def __init__(self, squad: Squad) -> None:
        self.note = ""
        self._squad = squad
        self._count = 0
        self._move: list[PlayEvent] = []  # the touches of the sequence being played
        self._previous: PlayEvent | None = None
        self._last: dict[tuple[str, Side], int] = {}
        self._report: PlayerReport | None = None
        self._named: set[str] = set()

    def handle(self, payload: KeyMoment | PlayEvent | PlayerReport) -> list[Highlight]:
        if isinstance(payload, PlayerReport):
            self._report = payload
            return []
        found = [self._key(payload)] if isinstance(payload, KeyMoment) else self._hidden(payload)
        if found:
            self.note = found[-1].title
        return found

    def _new(self, match_id: str, minute: int, **fields) -> Highlight:
        self._count += 1
        return Highlight(id=f"{match_id}-h{self._count}", match_id=match_id, minute=minute, **fields)

    def _key(self, moment: KeyMoment) -> Highlight:
        chance = next((fact.value for fact in moment.facts if fact.label == "xg"), 0.0)
        bonus = min(20.0, chance * 20.0) if moment.kind == "big_chance" else 0.0
        title = KEY_TITLE[moment.kind].format(team=self._squad.name(moment.team))
        if moment.player_id and moment.kind in ("goal", "red_card", "big_chance"):
            title = f"{title}: {self._squad.player_name(moment.player_id)}"
        return self._new(
            moment.match_id,
            moment.minute,
            kind="key",
            category=moment.kind,
            team=moment.team,
            player_id=moment.player_id,
            title=title,
            reason=f"{fact_text(moment.facts, 'en')}; the score is {moment.score_home}-{moment.score_away}.",
            score=KEY_SCORE[moment.kind] + bonus,
            moment_id=moment.id,
            event_ids=[moment.event_id] if moment.event_id else [],
        )

    def _rested(self, category: str, side: Side, minute: int) -> bool:
        if minute - self._last.get((category, side), -99) < COOLDOWN_MIN[category]:
            return False
        self._last[(category, side)] = minute
        return True

    def _hidden(self, play: PlayEvent) -> list[Highlight]:
        found: list[Highlight] = []
        previous, self._previous = self._previous, play
        side = play.team

        if play.type in POSSESSION and side is not None:
            if self._move and self._move[-1].sequence != play.sequence:
                found += self._long_move()
                self._move = []
                if play.phase == "transition" and attacking_x(side, play.x) >= HIGH_WIN:
                    found += self._turnover(play, side)
            self._move.append(play)
        elif play.type == "save" and side is not None and previous is not None and previous.type == "shot":
            found += self._save(play, previous, side)
        elif play.type == "foul" and side is not None and previous is not None:
            found += self._foul(play, previous, side)
        elif play.type in ("half_time", "full_time"):
            found += self._long_move()
            self._move = []
            found += self._unsung(play)
        return found

    def _long_move(self) -> list[Highlight]:
        move = self._move
        if len(move) < LONG_MOVE:
            return []
        last, side = move[-1], move[-1].team
        if not self._rested("long_sequence", side, last.minute):
            return []
        ended = (
            "ending in a shot"
            if last.type in ("shot", "goal")
            else f"reaching the {last.zone.replace('_', ' ')}"
        )
        return [
            self._new(
                last.match_id,
                last.minute,
                kind="hidden",
                category="long_sequence",
                team=side,
                player_id=last.player_id,
                title=f"{len(move)}-touch move by {self._squad.name(side)}",
                reason=f"{len(move)} touches in a row without losing the ball, {ended}.",
                score=min(90.0, 40.0 + 2.0 * len(move) + (15.0 if last.type in ("shot", "goal") else 0.0)),
                event_ids=[touch.event_id for touch in move[-20:]],
            )
        ]

    def _turnover(self, play: PlayEvent, side: Side) -> list[Highlight]:
        if not self._rested("dangerous_turnover", side, play.minute):
            return []
        along = attacking_x(side, play.x)
        return [
            self._new(
                play.match_id,
                play.minute,
                kind="hidden",
                category="dangerous_turnover",
                team=side,
                player_id=play.player_id,
                title=f"{self._squad.name(side)} win the ball high",
                reason=f"The ball was won {along:.0f}% of the way up the pitch, where the danger is {play.danger:.2f}.",
                score=min(85.0, 45.0 + (along - HIGH_WIN)),
                event_ids=[play.event_id],
            )
        ]

    def _save(self, play: PlayEvent, shot: PlayEvent, side: Side) -> list[Highlight]:
        shooting = other(side)
        chance = xg(attacking_x(shooting, shot.x), shot.y)
        if not SAVE_XG[0] <= chance < SAVE_XG[1]:
            return []
        return [
            self._new(
                play.match_id,
                play.minute,
                kind="hidden",
                category="big_save",
                team=side,
                player_id=play.player_id,
                title=f"Save by {self._squad.player_name(play.player_id, 'the keeper')}",
                reason=f"Kept out a shot worth {chance:.2f} expected goals from {self._squad.player_name(shot.player_id)}.",
                score=round(60.0 + chance * 80.0, 1),
                event_ids=[shot.event_id, play.event_id],
            )
        ]

    def _foul(self, play: PlayEvent, stopped: PlayEvent, side: Side) -> list[Highlight]:
        breaking = stopped.team == other(side) and (
            stopped.phase == "transition" or stopped.danger >= BREAK_DANGER
        )
        if not breaking or not self._rested("tactical_foul", side, play.minute):
            return []
        return [
            self._new(
                play.match_id,
                play.minute,
                kind="hidden",
                category="tactical_foul",
                team=side,
                player_id=play.player_id,
                title=f"Foul by {self._squad.player_name(play.player_id)} stops the attack",
                reason=f"{self._squad.name(other(side))} were {PHASE_PHRASES[stopped.phase]} with danger {stopped.danger:.2f} when the foul came.",
                score=min(75.0, 40.0 + stopped.danger * 50.0),
                event_ids=[stopped.event_id, play.event_id],
            )
        ]

    def _unsung(self, play: PlayEvent) -> list[Highlight]:
        if self._report is None:
            return []
        found = []
        for side in SIDES:
            quiet = [
                player
                for player in self._report.players
                if player.team == side
                and player.goals == 0
                and player.touches >= UNSUNG_TOUCHES
                and player.pass_accuracy >= UNSUNG_ACCURACY
                and player.player_id not in self._named
            ]
            if not quiet:
                continue
            best = max(quiet, key=lambda player: (player.touches, player.pass_accuracy))
            self._named.add(best.player_id)
            found.append(
                self._new(
                    play.match_id,
                    play.minute,
                    kind="hidden",
                    category="unsung_player",
                    team=side,
                    player_id=best.player_id,
                    title=f"Unsung: {best.name}",
                    reason=f"{best.touches} touches at {best.pass_accuracy:.0f}% passing and a rating of {best.rating}, without a goal.",
                    score=min(70.0, 35.0 + best.touches * 0.5),
                    event_ids=[],
                )
            )
        return found

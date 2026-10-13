"""A made-up fan chat, for trying the fan zone with no platform connected.

Every account and every word here is invented, as the match itself is. What it returns is marked as a
demo wherever it is shown. It reacts to the match's key moments and votes in an open poll.
"""

import random

from kickstream.ports.social import FeedBatch, FeedContext, IncomingComment, IncomingSuperChat

_FANS = (
    ("Priya K", "@priya_onside"),
    ("Tom the Terrace", "@terrace_tom"),
    ("Lucía R", "@lucia_ultra"),
    ("Kofi", "@kofi_ninety"),
    ("Mei", "@mei_matchday"),
    ("Big Dave", "@bigdave_nbr"),
    ("Aisha", "@aisha_awaydays"),
    ("Rafa", "@rafa_golazo"),
    ("Sam Okoro", "@sam_okoro"),
    ("Hanna", "@hanna_halfspace"),
    ("Jonno", "@jonno_cornerflag"),
    ("Zara", "@zara_xg"),
)
_PLATFORMS = ("x", "x", "youtube", "youtube", "twitch", "facebook")
_CHATTER = (
    "Come on, keep the ball moving!",
    "Great atmosphere tonight 🔥",
    "That midfield is running the show",
    "Why are we sitting so deep?",
    "Ref has been poor all night",
    "Love this stream, the stats are brilliant",
    "Need a sub, legs have gone",
    "Watching from Lagos, hello everyone 👏",
    "This pressing is superb",
    "Offside all day, never a chance",
    "Who is your player of the match so far?",
    "What a save that was earlier",
    "The left wing is wide open #Kickstream",
    "Awful touch, has to do better",
    "Quality pass, pure class",
    "Second half will be different #Kickstream",
)
_REACTIONS = {
    "goal": (
        "GOAL!!! {team} ⚽🔥",
        "What a goal for {team}! Unreal",
        "Yes!! {team} score, get in!",
        "No way, terrible defending",
    ),
    "red_card": (
        "Red card! That changes everything",
        "Never a red, shocking decision",
        "Had to go, awful tackle",
    ),
    "big_chance": ("How has {team} missed that?!", "So close for {team}!", "Has to score there, poor finish"),
    "momentum_swing": ("{team} are all over them now", "Momentum is with {team} 🔥"),
    "sustained_pressure": ("{team} keep coming, a goal is on the way", "Brilliant pressure from {team}"),
}
_THANKS = (
    "Keep up the great stream!",
    "For the coffee ☕",
    "Best coverage around",
    "Greetings from the away end",
    "",
)
_AMOUNTS = (2.0, 5.0, 5.0, 10.0, 20.0, 50.0)


class DemoFeed:
    demo = True
    interval_s = 2.5

    def __init__(self, seed: int = 7) -> None:
        self._rng = random.Random(seed)
        self._count = 0

    def _id(self) -> str:
        self._count += 1
        return f"demo-{self._count}"

    def _comment(self, text: str) -> IncomingComment:
        author, handle = self._rng.choice(_FANS)
        return IncomingComment(
            id=self._id(),
            platform=self._rng.choice(_PLATFORMS),
            author=author,
            handle=handle,
            text=text,
            likes=self._rng.choice((0, 0, 1, 2, 5, 12, 40)),
        )

    async def fetch(self, context: FeedContext) -> FeedBatch:
        rng = self._rng
        comments = []
        for kind, team in context.moments:
            lines = _REACTIONS.get(kind, ())
            for _ in range(rng.randint(2, 4) if lines else 0):
                comments.append(self._comment(rng.choice(lines).format(team=team)))
        for _ in range(rng.randint(0, 2)):
            comments.append(self._comment(rng.choice(_CHATTER)))
        if context.poll_options:
            for _ in range(rng.randint(1, 3)):
                # The first options are a little more popular, so the bars are not all alike.
                weights = [context.poll_options - index + 1 for index in range(context.poll_options)]
                choice = rng.choices(range(1, context.poll_options + 1), weights)[0]
                comments.append(self._comment(str(choice)))
        superchats = []
        if rng.random() < 0.03:
            author, _ = rng.choice(_FANS)
            superchats.append(
                IncomingSuperChat(
                    id=self._id(),
                    platform=rng.choice(("youtube", "twitch")),
                    name=author,
                    amount=rng.choice(_AMOUNTS),
                    currency="USD",
                    message=rng.choice(_THANKS),
                )
            )
        return FeedBatch(tuple(comments), tuple(superchats))

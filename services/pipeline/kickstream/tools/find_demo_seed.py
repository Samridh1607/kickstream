"""Find a seed whose match makes a good demo. Run: python -m kickstream.tools.find_demo_seed"""

from collections import Counter

from kickstream.analytics.state import AnalyticsConfig, MatchState, apply
from kickstream.contracts import KeyMoment
from kickstream.domain.teams import AWAY, HOME
from kickstream.simulator.generate import generate


def summarize(seed: int) -> tuple[int, list[KeyMoment]]:
    events = generate("m-demo", seed, HOME, AWAY)
    state, cfg = MatchState("m-demo"), AnalyticsConfig()
    key_moments = [o for e in events for o in apply(state, e, cfg) if isinstance(o, KeyMoment)]
    return sum(e.type == "goal" for e in events), key_moments


def is_watchable(goals: int, key_moments: list[KeyMoment]) -> bool:
    return (2 <= goals <= 5 and 10 <= len(key_moments) <= 20 and len({m.kind for m in key_moments}) >= 3
            and any(m.kind == "goal" and m.minute < 45 for m in key_moments))


def main() -> None:
    counts = []
    for seed in range(1, 301):
        goals, key_moments = summarize(seed)
        counts.append(len(key_moments))
        if is_watchable(goals, key_moments):
            print(f"DEMO_SEED = {seed}  goals={goals} moments={len(key_moments)} "
                  f"kinds={dict(Counter(m.kind for m in key_moments))}")
            return
    counts.sort()
    print(f"no seed in 1..300 qualifies; key moments per match: min={counts[0]} median={counts[150]} max={counts[-1]}")


if __name__ == "__main__":
    main()

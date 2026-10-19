import pytest

from kickstream.adapters.scripted_explainer import ScriptedExplainer
from kickstream.agents.explain import ExplainabilityAgent, ExplainService
from kickstream.agents.highlights import HighlightsAgent
from kickstream.agents.interpreter import EventInterpreter, danger_of, lane_of, zone_of
from kickstream.agents.prediction import PredictionAgent, outcome_odds
from kickstream.agents.registry import AGENT_IDS, DECLARED, AgentError, AgentSwitches
from kickstream.agents.squad import Squad
from kickstream.agents.tactics import TacticalAnalyst, rhythm_of
from kickstream.agents.tracking import PlayerTracker
from kickstream.agents.visualize import VisualizationAgent
from kickstream.contracts import Highlight, Player, PlayEvent, Prediction, TacticalInsight, TeamTactics
from kickstream.domain.teams import AWAY, HOME
from kickstream.ports.explainer import ExplainError, WrittenExplanation
from tests.factories import MATCH, event, moment

NAMES = {"home": HOME.name, "away": AWAY.name}


def interpret(events) -> list[PlayEvent]:
    interpreter = EventInterpreter()
    return [play for item in events for play in interpreter.handle(item)]


def play(seq, type_="pass", team="home", minute=0, second=0, x=50.0, y=50.0, **extra) -> PlayEvent:
    """One structured event, as the interpreter would hand it on."""
    fields = dict(
        id=f"{MATCH}-y{seq}",
        match_id=MATCH,
        minute=minute,
        second=second,
        event_id=f"{MATCH}-e{seq}",
        type=type_,
        team=team,
        x=x,
        y=y,
        zone=zone_of(team, x),
        lane=lane_of(team, y),
        phase="progression",
        sequence=1,
        sequence_length=1,
        danger=0.0,
    )
    return PlayEvent(**{**fields, **extra})


def play_of(item) -> PlayEvent:
    return EventInterpreter().handle(item)[0]


# --- Event Interpreter ---------------------------------------------------------------------------


def test_a_position_is_named_as_the_side_in_possession_sees_it():
    assert zone_of("home", 80) == "attacking_third" and zone_of("away", 80) == "defensive_third"
    assert lane_of("home", 10) == "left" and lane_of("away", 10) == "right"
    assert zone_of(None, 50) == "middle_third"


def test_danger_rises_towards_the_goal_being_attacked():
    assert danger_of("home", 20, 50) < danger_of("home", 70, 50) < danger_of("home", 95, 50) <= 1.0
    assert danger_of("away", 5, 50) == danger_of("home", 95, 50)


def test_every_detection_becomes_one_structured_event_that_keeps_its_facts():
    plays = interpret(
        [
            event(1, "kickoff", "home"),
            event(
                2,
                "pass",
                "home",
                x=40,
                completed=True,
                pass_distance=18.2,
                pass_difficulty=3,
                ball_speed=18.2,
            ),
        ]
    )
    assert [p.event_id for p in plays] == [f"{MATCH}-e1", f"{MATCH}-e2"]
    assert (plays[0].phase, plays[1].phase, plays[1].completed) == ("restart", "progression", True)
    assert (plays[1].pass_distance, plays[1].pass_difficulty, plays[1].ball_speed) == (18.2, 3, 18.2)


def test_touches_by_one_side_form_a_sequence_until_the_other_side_has_the_ball():
    plays = interpret(
        [
            event(1, "kickoff", "home"),
            event(2, "pass", "home", x=40),
            event(3, "pass", "home", x=50),
            event(4, "foul", "away", x=50),
            event(5, "pass", "home", x=55),
            event(6, "pass", "away", x=40),
        ]
    )
    assert [p.sequence for p in plays] == [1, 1, 1, 1, 1, 2]
    assert [p.sequence_length for p in plays] == [0, 1, 2, 2, 3, 1]
    assert plays[3].phase == "defending" and plays[3].danger == 0


def test_the_first_touches_after_winning_the_ball_upfield_are_a_transition():
    plays = interpret(
        [
            event(1, "kickoff", "home"),
            event(2, "pass", "home", x=40),
            event(3, "pass", "away", x=50),  # away won it at halfway, their attacking x is 50
            event(4, "pass", "away", x=30),
            event(5, "pass", "away", x=25),
            event(6, "pass", "away", x=20),
            event(7, "corner", "away", x=1, y=1),
        ]
    )
    assert [p.phase for p in plays[2:]] == [
        "transition",
        "transition",
        "transition",
        "final_third",
        "set_piece",
    ]


def test_the_interpreter_passes_xg_and_location_on():
    play = EventInterpreter().handle(event(1, "shot", "home", xg=0.3, located=False))[0]
    assert (play.xg, play.located, play.danger) == (0.3, False, 0.0)
    assert (play.zone, play.lane) == ("middle_third", "centre")


# --- Tactical Analyst ----------------------------------------------------------------------------


def test_the_analyst_reports_once_a_minute_on_the_minutes_before_it():
    analyst = TacticalAnalyst(NAMES)
    assert analyst.handle(play(1, minute=0)) == []
    assert analyst.handle(play(2, minute=0, second=30)) == []
    [insight] = analyst.handle(play(3, minute=1))
    assert (insight.id, insight.minute) == (f"{MATCH}-t1", 1)
    assert insight.home.tempo == 2.0 and insight.away.tempo == 0.0
    assert analyst.handle(play(4, minute=1, second=20)) == []


def test_a_pattern_is_named_only_once_a_side_has_played_enough_to_show_it():
    analyst = TacticalAnalyst(NAMES)
    for seq in range(1, 9):
        analyst.handle(play(seq, minute=0, second=seq, y=10))
    [early] = analyst.handle(play(9, team="away", minute=1))
    assert early.home.patterns == []
    for seq in range(10, 20):
        analyst.handle(play(seq, minute=1, second=seq, y=10))
    [later] = analyst.handle(play(20, team="away", minute=2))
    assert "wing_overload_left" in later.home.patterns
    assert later.home.lanes[0] == 1.0 and "overloading the left wing" in later.summary


def test_winning_the_ball_high_again_and_again_is_a_high_press():
    analyst = TacticalAnalyst(NAMES)
    seq = 0
    for sequence in range(1, 14):
        side = "home" if sequence % 2 else "away"
        for touch in range(1, 4):
            seq += 1
            won = touch == 1 and side == "home"
            analyst.handle(
                play(
                    seq,
                    team=side,
                    minute=0,
                    second=seq,
                    x=70,
                    sequence=sequence,
                    sequence_length=touch,
                    phase="transition" if won else "progression",
                )
            )
    [insight] = analyst.handle(play(99, minute=1, sequence=14))
    assert "high_press" in insight.home.patterns and "high_press" not in insight.away.patterns


def test_the_analyst_reads_nothing_into_unlocated_plays():
    analyst = TacticalAnalyst(NAMES)
    for seq in range(1, 20):
        analyst.handle(play(seq, minute=0, second=seq, y=10, located=False))
    [insight] = analyst.handle(play(20, team="away", minute=1, located=False))
    assert (insight.home.tempo, insight.home.lanes, insight.home.patterns) == (0.0, [0.333] * 3, [])


def test_rhythm_follows_how_many_passes_are_being_played():
    assert [rhythm_of(rate) for rate in (3, 6, 7, 9)] == ["slow", "steady", "fast", "frantic"]


def _frantic_minute(analyst, momentum) -> TacticalInsight:
    analyst.momentum = momentum
    for seq in range(1, 11):
        analyst.handle(play(seq, minute=0, second=seq * 5))
    [insight] = analyst.handle(play(11, minute=1))
    return insight


def test_momentum_past_the_swing_strength_is_control_and_a_frantic_game_nobody_controls_is_chaos():
    controlled = _frantic_minute(TacticalAnalyst(NAMES), -0.5)
    assert (controlled.rhythm, controlled.control, controlled.momentum) == ("frantic", "away", -0.5)
    assert controlled.summary.endswith(f"Control: {AWAY.name} are in control.")
    chaotic = _frantic_minute(TacticalAnalyst(NAMES), 0.2)
    assert chaotic.control is None
    assert chaotic.summary.endswith("Chaos: the rhythm is frantic and neither side is in control.")


def test_a_calm_game_nobody_controls_has_neither_fact():
    analyst = TacticalAnalyst(NAMES)
    analyst.momentum = 0.1
    analyst.handle(play(1, minute=0))
    [insight] = analyst.handle(play(2, minute=1))
    assert insight.control is None and "Control" not in insight.summary and "Chaos" not in insight.summary


# --- Prediction Agent ----------------------------------------------------------------------------


def test_the_three_outcomes_always_add_up_and_a_lead_is_worth_more_late():
    win, draw, loss = outcome_odds(0, 1.2, 1.2)
    assert win + draw + loss == pytest.approx(1.0) and win == pytest.approx(loss)
    assert outcome_odds(1, 0.1, 0.1)[0] > outcome_odds(1, 1.5, 1.5)[0] > 0.5


def test_a_forecast_is_made_once_a_minute_and_a_goal_moves_it():
    agent = PredictionAgent()
    assert agent.handle(play(1, minute=0)) == []
    [before] = agent.handle(play(2, minute=1))
    agent.handle(play(3, "goal", minute=1, second=30, x=100, danger=1.0))
    [after] = agent.handle(play(4, team="away", minute=2))
    assert before.win_home + before.draw + before.win_away == pytest.approx(1.0, abs=0.002)
    assert after.win_home > before.win_home + 0.15
    assert (after.cols, after.rows, len(after.danger)) == (6, 4, 24) and max(after.danger) == 1.0


def test_next_actions_are_learned_from_what_followed_each_touch_in_this_match():
    agent = PredictionAgent()
    agent.handle(play(1, x=80))
    for seq in range(2, 12):
        agent.handle(play(seq, "shot", second=seq, x=80, outcome="off_target"))
    [forecast] = agent.handle(play(12, minute=1, x=80))
    odds = {action.action: action.probability for action in forecast.next_actions}
    assert sum(odds.values()) == pytest.approx(1.0, abs=0.002)
    assert odds["shot"] > odds["pass"] > 0 and forecast.possession == "home"


def test_a_red_card_costs_the_side_that_got_it():
    def home_win(with_red: bool) -> float:
        agent = PredictionAgent()
        agent.handle(play(1))
        if with_red:
            agent.handle(play(2, "red_card", second=5))
        return agent.handle(play(3, minute=1))[0].win_home

    assert home_win(True) < home_win(False)


def test_prediction_uses_the_sources_own_xg():
    def home_win(chance: float) -> float:
        agent = PredictionAgent()
        agent.handle(play(1, "shot", minute=30, x=60, xg=chance, outcome="saved"))
        return agent.handle(play(2, minute=60))[0].win_home

    assert home_win(0.9) > home_win(0.01)


def test_prediction_without_located_play_uses_the_base_rate_only():
    def forecast(*plays: PlayEvent) -> Prediction:
        agent = PredictionAgent()
        for item in plays:
            agent.handle(item)
        return agent.handle(play(99, "substitution", minute=60, located=False))[0]

    quiet = forecast()
    assert quiet.win_home == pytest.approx(quiet.win_away) and max(quiet.danger) == 0
    shooting = forecast(play(1, "shot", minute=30, xg=0.9, outcome="saved", danger=0.9, located=False))
    assert (shooting.win_home, shooting.possession, shooting.next_actions) == (quiet.win_home, None, [])
    carded = forecast(play(2, "red_card", team="away", minute=30, located=False))
    assert carded.win_home > quiet.win_home


# --- Player Tracking Agent -----------------------------------------------------------------------


def test_each_event_is_credited_to_the_player_who_made_it():
    tracker = PlayerTracker(Squad(HOME, AWAY))
    tracker.handle(play(1, player_id="nbr-9", completed=True))
    tracker.handle(play(2, player_id="nbr-9", completed=False))
    tracker.handle(play(3, "shot", player_id="nbr-9", x=90, outcome="goal"))
    tracker.handle(play(4, "goal", player_id="nbr-9", x=100))
    tracker.handle(play(5, "foul", team="away", player_id="hbc-4"))
    [report] = tracker.handle(play(6, minute=1, player_id="nbr-2", completed=True))
    lines = {line.player_id: line for line in report.players}
    striker = lines["nbr-9"]
    assert (striker.touches, striker.passes, striker.pass_accuracy) == (3, 2, 50.0)
    assert (striker.shots, striker.shots_on_target, striker.goals) == (1, 1, 1)
    assert striker.xg > 0 and sum(striker.heat) == 3
    assert striker.rating > lines["nbr-2"].rating > lines["hbc-4"].rating
    assert len(report.players) == 28 and "Luca Marrowby" in tracker.note


def test_a_player_callout_fires_when_distance_or_speed_crosses_a_threshold():
    quiet = PlayerTracker(Squad(HOME, AWAY))
    quiet.handle(play(1, player_id="nbr-9", completed=True, pass_distance=100, ball_speed=12))
    [below] = quiet.handle(play(2, minute=1, player_id="nbr-2", completed=True))
    line = {item.player_id: item for item in below.players}["nbr-9"]
    assert line.distance == 100 and line.top_speed == 12 and line.callout is None

    loud = PlayerTracker(Squad(HOME, AWAY))
    loud.handle(play(1, player_id="nbr-9", completed=True, pass_distance=600, ball_speed=30, shot_speed=None))
    loud.handle(play(2, "shot", player_id="nbr-9", x=90, outcome="saved", shot_speed=33))
    [above] = loud.handle(play(3, minute=1, player_id="nbr-2", completed=True))
    striker = {item.player_id: item for item in above.players}["nbr-9"]
    assert striker.distance == 600 and striker.top_speed == 33
    assert striker.callout == "Luca Marrowby covered 600 m; Luca Marrowby reached 33 m/s"


def test_a_substitute_comes_on_and_a_sent_off_player_leaves():
    squad = Squad(HOME, AWAY)
    tracker = PlayerTracker(squad)
    squad.apply(play(1, "substitution", player_id="nbr-9", player_in_id="nbr-12"))
    squad.apply(play(2, "red_card", team="away", player_id="hbc-4"))
    [report] = tracker.handle(play(3, minute=1))
    on_pitch = {line.player_id for line in report.players if line.on_pitch}
    assert "nbr-12" in on_pitch and not {"nbr-9", "hbc-4"} & on_pitch
    assert len(on_pitch) == 21


def test_a_players_shot_counts_the_sources_xg_and_an_unlocated_touch_adds_no_heat():
    tracker = PlayerTracker(Squad(HOME, AWAY))
    tracker.handle(play(1, "shot", player_id="nbr-9", x=90, xg=0.05, outcome="saved"))
    tracker.handle(play(2, "shot", player_id="nbr-9", x=90, outcome="off_target", located=False))
    [report] = tracker.handle(play(3, minute=1, player_id="nbr-2", located=False))
    striker = next(line for line in report.players if line.player_id == "nbr-9")
    assert (striker.shots, striker.xg, striker.touches, sum(striker.heat)) == (2, 0.05, 2, 1)


def test_the_squad_starts_the_players_marked_starting_and_learns_new_ones():
    home = HOME.model_copy(
        update={
            "players": [p.model_copy(update={"starting": p.number in range(4, 15)}) for p in HOME.players]
        }
    )
    squad = Squad(home, AWAY)
    assert squad.on_pitch["home"] == [p.id for p in home.players if p.starting]
    newcomer = Player(id="ol-1", name="New Scorer", number=0, position="MF")
    squad.refresh(home.model_copy(update={"players": [*home.players, newcomer]}), AWAY)
    assert squad.player_name("ol-1") == "New Scorer"
    assert squad.on_pitch["home"] == [p.id for p in home.players if p.starting]


def test_a_squad_with_no_starters_marked_starts_the_first_eleven():
    home = HOME.model_copy(
        update={"players": [p.model_copy(update={"starting": False}) for p in HOME.players]}
    )
    assert Squad(home, AWAY).on_pitch["home"] == [p.id for p in HOME.players[:11]]


# --- Visualization Agent -------------------------------------------------------------------------


def test_the_scene_places_the_player_on_the_ball_and_estimates_the_rest():
    agent = VisualizationAgent(Squad(HOME, AWAY))
    agent.handle(play(1, player_id="nbr-6", x=40, y=30))
    [scene] = agent.handle(play(2, player_id="nbr-9", x=80, y=60, danger=0.6))
    on_ball = [player for player in scene.players if player.on_ball]
    assert [(p.id, p.x, p.y, p.estimated) for p in on_ball] == [("nbr-9", 80.0, 60.0, False)]
    assert len(scene.players) == 22 and all(p.estimated for p in scene.players if not p.on_ball)
    keeper = next(player for player in scene.players if player.id == "hbc-1")
    assert keeper.x == 95.0  # the away keeper stands in front of the away goal


def test_the_ball_flies_an_arc_from_the_last_touch_and_lands_where_it_is_now():
    agent = VisualizationAgent(Squad(HOME, AWAY))
    agent.handle(play(1, x=20, y=20))
    [scene] = agent.handle(play(2, x=80, y=60))
    first, last = scene.trail[0], scene.trail[-1]
    assert (first.x, first.y, first.z) == (20.0, 20.0, 0.0) and (last.x, last.y, last.z) == (80.0, 60.0, 0.0)
    assert max(point.z for point in scene.trail) > 1.0
    assert [(lane.from_x, lane.to_x, lane.team) for lane in scene.lanes] == [(20.0, 80.0, "home")]


def test_danger_raises_a_column_and_an_attack_brings_the_camera_round():
    agent = VisualizationAgent(Squad(HOME, AWAY))
    [calm] = agent.handle(play(1, x=40))
    [attack] = agent.handle(play(2, x=85, y=50, danger=0.7))
    [restart] = agent.handle(play(3, "kickoff", team="away", phase="restart", sequence=2))
    assert (calm.camera, attack.camera, restart.camera) == ("broadcast", "attack_home", "tactical")
    assert calm.columns == [] and attack.columns[0].team == "home" and attack.columns[0].intensity == 1.0
    assert restart.lanes == []  # a new sequence starts with no pass lanes


def test_the_visualization_agent_draws_nothing_for_an_unlocated_play():
    assert (
        VisualizationAgent(Squad(HOME, AWAY)).handle(play_of(event(1, "goal", "home", located=False))) == []
    )


def test_an_unlocated_play_leaves_the_picture_as_it_was():
    agent = VisualizationAgent(Squad(HOME, AWAY))
    agent.handle(play(1, x=20, y=20))
    agent.handle(play(2, "goal", x=90, y=50, danger=1.0, located=False))
    [scene] = agent.handle(play(3, x=40, y=30))
    assert (scene.trail[0].x, scene.trail[0].y) == (20.0, 20.0) and scene.columns == []
    assert [(lane.from_x, lane.to_x) for lane in scene.lanes] == [(20.0, 40.0)]


# --- Highlights Agent ----------------------------------------------------------------------------


def test_key_moments_are_ranked_goals_first():
    agent = HighlightsAgent(Squad(HOME, AWAY))
    [goal] = agent.handle(moment(1, "goal", player_id="nbr-9", event_id=f"{MATCH}-e40"))
    [swing] = agent.handle(moment(2, "momentum_swing", team="away"))
    assert (goal.kind, goal.category, goal.moment_id) == ("key", "goal", f"{MATCH}-k1")
    assert goal.title == "Goal for Northbridge FC: Luca Marrowby" and goal.score > swing.score
    assert swing.title == "Harbour City take control"


def test_a_long_move_is_a_hidden_event_once_it_ends():
    agent = HighlightsAgent(Squad(HOME, AWAY))
    for touch in range(1, 10):
        assert agent.handle(play(touch, second=touch, sequence_length=touch)) == []
    [found] = agent.handle(play(10, team="away", second=30, sequence=2))
    assert (found.kind, found.category, found.team) == ("hidden", "long_sequence", "home")
    assert found.title == "9-touch move by Northbridge FC" and len(found.event_ids) == 9


def test_a_good_save_from_a_lesser_chance_is_a_hidden_event():
    agent = HighlightsAgent(Squad(HOME, AWAY))
    agent.handle(play(1, "shot", player_id="nbr-9", x=88, y=50, outcome="saved"))
    [found] = agent.handle(play(2, "save", team="away", player_id="hbc-1", second=1, x=97))
    assert (found.category, found.team, found.title) == ("big_save", "away", "Save by Osric Pendlebury")
    assert "Luca Marrowby" in found.reason


def test_a_save_is_judged_by_the_sources_xg_and_never_by_a_position_it_lacks():
    def saves(shot: PlayEvent) -> list[Highlight]:
        agent = HighlightsAgent(Squad(HOME, AWAY))
        agent.handle(shot)
        return agent.handle(play(2, "save", team="away", player_id="hbc-1", second=1, x=97))

    [found] = saves(play(1, "shot", player_id="nbr-9", x=50, y=50, xg=0.2, outcome="saved"))
    assert "0.20 expected goals" in found.reason
    assert saves(play(1, "shot", player_id="nbr-9", x=88, y=50, outcome="saved", located=False)) == []


def test_winning_the_ball_high_is_found_only_where_the_position_is_known():
    def turnovers(located: bool) -> list[Highlight]:
        agent = HighlightsAgent(Squad(HOME, AWAY))
        agent.handle(play(1, team="away", x=50))
        return agent.handle(play(2, x=80, sequence=2, phase="transition", danger=0.4, located=located))

    assert [h.category for h in turnovers(True)] == ["dangerous_turnover"]
    assert turnovers(False) == []


def test_a_foul_that_stops_a_break_is_found_once_per_cooldown():
    agent = HighlightsAgent(Squad(HOME, AWAY))
    agent.handle(play(1, phase="transition", danger=0.2))
    [found] = agent.handle(play(2, "foul", team="away", player_id="hbc-4", second=1))
    assert found.category == "tactical_foul" and "breaking forward" in found.reason
    agent.handle(play(3, phase="transition", second=10))
    assert agent.handle(play(4, "foul", team="away", player_id="hbc-4", second=11)) == []


def test_at_the_interval_the_busiest_accurate_player_without_a_goal_is_named_once():
    squad = Squad(HOME, AWAY)
    tracker, agent = PlayerTracker(squad), HighlightsAgent(squad)
    for touch in range(1, 26):
        tracker.handle(play(touch, player_id="nbr-6", second=touch % 60, completed=True))
    [report] = tracker.handle(play(30, minute=1, player_id="nbr-6", completed=True))
    agent.handle(report)
    [found] = agent.handle(play(31, "half_time", team=None, minute=45))
    assert (found.category, found.player_id) == ("unsung_player", "nbr-6")
    assert agent.handle(play(32, "full_time", team=None, minute=90)) == []


# --- Explainability Agent ------------------------------------------------------------------------


def tactics(minute, home=(), away=()) -> TacticalInsight:
    def team(patterns):
        return TeamTactics(
            pressure=60,
            tempo=3.2,
            field_tilt=64,
            avg_sequence=4.1,
            lanes=[0.5, 0.3, 0.2],
            patterns=list(patterns),
        )

    return TacticalInsight(
        id=f"{MATCH}-t{minute}",
        match_id=MATCH,
        minute=minute,
        home=team(home),
        away=team(away),
        rhythm="fast",
        summary="",
    )


def forecast(minute, win_home) -> Prediction:
    return Prediction(
        id=f"{MATCH}-f{minute}",
        match_id=MATCH,
        minute=minute,
        win_home=win_home,
        draw=0.2,
        win_away=round(0.8 - win_home, 3),
        next_goal_home=0.2,
        next_goal_away=0.1,
        next_actions=[],
        cols=6,
        rows=4,
        danger=[0.0] * 24,
    )


def test_tactics_are_explained_when_a_pattern_is_new_and_not_too_often():
    agent = ExplainabilityAgent(NAMES)
    assert agent.consider(tactics(10)) == []
    [ctx] = agent.consider(tactics(11, home=["high_press"]))
    assert (ctx.topic, ctx.side, ctx.team) == ("pattern:high_press", "home", HOME.name)
    assert ctx.fact("field tilt") == "64%" and ctx.evidence == (f"{MATCH}-t11",)
    assert agent.consider(tactics(12, home=["high_press"])) == []  # nothing new
    assert agent.consider(tactics(13, home=["high_press"], away=["low_block"])) == []  # too soon
    assert [c.topic for c in agent.consider(tactics(16, home=["high_press"], away=["low_block"]))] == [
        "pattern:low_block"
    ]


def test_a_tactics_explanation_carries_the_control_or_chaos_fact():
    agent = ExplainabilityAgent(NAMES)
    agent.consider(tactics(10))
    [held] = agent.consider(tactics(11, home=["high_press"]).model_copy(update={"control": "home"}))
    assert held.fact("control") == f"{HOME.name} are in control" and held.fact("chaos") == ""
    frantic = tactics(16, home=["high_press"], away=["low_block"]).model_copy(update={"rhythm": "frantic"})
    [chaos] = agent.consider(frantic)
    assert chaos.fact("chaos") == "the rhythm is frantic and neither side is in control"
    assert chaos.fact("control") == ""


def test_a_forecast_is_explained_when_the_odds_have_moved_enough():
    agent = ExplainabilityAgent(NAMES)
    assert agent.consider(forecast(1, 0.40)) == []
    assert agent.consider(forecast(2, 0.45)) == []
    [ctx] = agent.consider(forecast(9, 0.56))  # 16 points since the last one explained
    assert (ctx.topic, ctx.side) == ("prediction:swing", "home")
    assert (ctx.fact("win chance before"), ctx.fact("win chance now")) == ("40%", "56%")
    [back] = agent.consider(forecast(20, 0.30))
    assert back.side == "away"


def test_only_hidden_highlights_are_explained():
    agent = ExplainabilityAgent(NAMES)
    fields = dict(
        match_id=MATCH, minute=30, team="away", title="12-touch move", reason="12 touches.", score=64
    )
    key = Highlight(id="h1", kind="key", category="goal", event_ids=[], **fields)
    hidden = Highlight(id="h2", kind="hidden", category="long_sequence", event_ids=["e1", "e2"], **fields)
    assert agent.consider(key) == []
    [ctx] = agent.consider(hidden)
    assert (ctx.topic, ctx.evidence) == ("highlight:long_sequence", ("h2", "e1", "e2"))


class FakeExplainer:
    model = "fake-model"

    def __init__(self, fail_with: Exception | None = None, blank: bool = False) -> None:
        self.calls = 0
        self._fail_with = fail_with
        self._blank = blank

    async def explain(self, ctx):
        self.calls += 1
        if self._fail_with:
            raise self._fail_with
        why = "" if self._blank else "Because of the numbers."
        return {
            mode: WrittenExplanation(f"{mode} headline", why, "explainability") for mode in ("fan", "analyst")
        }


async def context():
    agent = ExplainabilityAgent(NAMES)
    [ctx] = agent.consider(tactics(11, home=["high_press"]))
    return ctx


async def test_without_a_model_the_script_writes_both_wordings():
    explanations = await ExplainService(ScriptedExplainer()).explain(MATCH, await context())
    fan, analyst = explanations
    assert (fan.mode, analyst.mode) == ("fan", "analyst") and fan.source == "scripted"
    assert fan.headline == "Northbridge FC are winning the ball high up the pitch"
    assert "Harbour City" in fan.why and "field tilt 64%" in analyst.why and "64%" not in fan.why
    assert fan.id == f"{MATCH}-t11-x-fan" and "field tilt: 64%" in fan.evidence and fan.team == "home"


async def test_with_a_model_the_agent_writes_and_any_failure_falls_back_to_the_script():
    written = await ExplainService(ScriptedExplainer(), FakeExplainer()).explain(MATCH, await context())
    assert {(e.source, e.agent) for e in written} == {("agent", "explainability")}
    for broken in (
        FakeExplainer(ExplainError("bad")),
        FakeExplainer(RuntimeError("down")),
        FakeExplainer(blank=True),
    ):
        fallen = await ExplainService(ScriptedExplainer(), broken).explain(MATCH, await context())
        assert {e.source for e in fallen} == {"scripted"} and broken.calls == 1


async def test_the_model_is_called_no_more_than_the_limit_for_a_match():
    model = FakeExplainer()
    service = ExplainService(ScriptedExplainer(), model, max_calls=2)
    sources = [(await service.explain(MATCH, await context()))[0].source for _ in range(3)]
    assert sources == ["agent", "agent", "scripted"] and model.calls == 2
    assert (await service.explain("m-2", await context()))[0].source == "agent"


async def test_the_script_has_wording_for_every_kind_of_finding():
    agent = ExplainabilityAgent(NAMES)
    agent.consider(forecast(1, 0.40))
    [swing] = agent.consider(forecast(9, 0.60))
    written = await ScriptedExplainer().explain(swing)
    assert written["fan"].headline == "The odds have moved towards Northbridge FC"
    assert "from 40% to 60%" in written["fan"].why and "A draw is now 20%" in written["analyst"].why


# --- registry ------------------------------------------------------------------------------------


class MemoryRecord:
    def __init__(self, record=None, broken=False):
        self.record, self.broken = record, broken

    def load(self):
        return self.record

    def save(self, record):
        if self.broken:
            raise OSError("disk full")
        self.record = record

    def set_aside(self):
        self.record = None


def test_the_catalogue_declares_all_seven_agents_after_the_agents_they_listen_to():
    assert AGENT_IDS == (
        "event_interpreter",
        "tactical_analyst",
        "prediction",
        "player_tracking",
        "visualization",
        "highlights",
        "explainability",
    )
    for position, declared in enumerate(DECLARED):
        assert set(declared.upstream) <= set(AGENT_IDS[:position])
        assert declared.instructions and declared.triggers and declared.tools and declared.outputs
    catalog = AgentSwitches().catalog(model=False)
    assert [agent.enabled for agent in catalog.agents] == [True] * 7 and catalog.model is False


def test_a_switch_is_kept_and_an_unknown_agent_or_a_failed_save_is_refused():
    record = MemoryRecord()
    switches = AgentSwitches(record)
    switches.set("prediction", False)
    assert record.record == {"off": ["prediction"]} and not switches.enabled("prediction")
    assert not AgentSwitches(record).enabled("prediction")
    switches.set("prediction", True)
    assert record.record == {"off": []}
    with pytest.raises(AgentError) as unknown:
        switches.set("referee", False)
    assert unknown.value.status == 404
    broken = AgentSwitches(MemoryRecord(broken=True))
    with pytest.raises(AgentError) as unsaved:
        broken.set("prediction", False)
    assert unsaved.value.status == 503 and broken.enabled("prediction")


def test_a_saved_record_naming_unknown_agents_still_loads():
    assert AgentSwitches(MemoryRecord({"off": ["referee", "highlights"]})).enabled("event_interpreter")
    assert not AgentSwitches(MemoryRecord({"off": ["referee", "highlights"]})).enabled("highlights")
    assert AgentSwitches(MemoryRecord({"off": "everything"})).enabled("highlights")

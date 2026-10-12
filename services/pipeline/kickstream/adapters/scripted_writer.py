"""Template-based narratives. Needs no network; used whenever the agent writer is unavailable."""

from kickstream.domain.labels import fact_text
from kickstream.domain.types import VARIANTS, Language, Mode, Variant
from kickstream.ports.writer import MomentContext, RecapContext, WrittenRecap, WrittenText

_MOMENT: dict[Language, dict[Mode, dict[str, str]]] = {
    "en": {
        "fan": {
            "goal": "GOAL! {player} scores for {team} in minute {minute}. It's {score}!",
            "red_card": "Red card! {team} are a player down after {player} is sent off in minute {minute}.",
            "big_chance": "So close! {player} had a huge chance for {team} in minute {minute}.",
            "momentum_swing": "The game is turning. {team} have taken control around minute {minute}.",
            "sustained_pressure": "{team} are camped in the final third and the pressure keeps building.",
        },
        "analyst": {
            "goal": "{team} score through {player} ({minute}'). The goal reflects the balance of play: {facts}. Score: {score}.",
            "red_card": "{player} is dismissed ({minute}'), leaving {team} short-handed. Expect a deeper block and fewer forward passes: {facts}.",
            "big_chance": "{player} gets a high-value chance for {team} ({minute}'). Chance quality: {facts}.",
            "momentum_swing": "Momentum has shifted to {team} ({minute}'). Territory and shot volume now favor them: {facts}.",
            "sustained_pressure": "{team} have held high pressure in the attacking third for several minutes ({minute}'): {facts}.",
        },
    },
    "es": {
        "fan": {
            "goal": "¡GOL! {player} marca para {team} en el minuto {minute}. ¡{score}!",
            "red_card": "¡Tarjeta roja! {team} se queda con uno menos tras la expulsión de {player} en el minuto {minute}.",
            "big_chance": "¡Qué cerca! {player} tuvo una ocasión clarísima para {team} en el minuto {minute}.",
            "momentum_swing": "El partido está cambiando. {team} toma el control hacia el minuto {minute}.",
            "sustained_pressure": "{team} está instalado en el último tercio y la presión no deja de crecer.",
        },
        "analyst": {
            "goal": "{team} marca por medio de {player} ({minute}'). El gol refleja el desarrollo del juego: {facts}. Marcador: {score}.",
            "red_card": "{player} es expulsado ({minute}') y {team} queda en inferioridad. Es previsible un bloque más bajo y menos pases hacia adelante: {facts}.",
            "big_chance": "{player} dispone de una ocasión de alto valor para {team} ({minute}'). Calidad de la ocasión: {facts}.",
            "momentum_swing": "El impulso ha pasado a {team} ({minute}'). El territorio y el volumen de remates ahora le favorecen: {facts}.",
            "sustained_pressure": "{team} ha mantenido una presión alta en el tercio de ataque durante varios minutos ({minute}'): {facts}.",
        },
    },
    "hi": {
        "fan": {
            "goal": "गोल! {player} ने {minute}वें मिनट में {team} के लिए गोल किया। स्कोर {score}!",
            "red_card": "रेड कार्ड! {minute}वें मिनट में {player} को बाहर भेजा गया, {team} अब एक खिलाड़ी कम है।",
            "big_chance": "बहुत करीब! {minute}वें मिनट में {player} के पास {team} के लिए बड़ा मौका था।",
            "momentum_swing": "मैच का रुख बदल रहा है। {minute}वें मिनट के आसपास {team} ने नियंत्रण ले लिया है।",
            "sustained_pressure": "{team} लगातार आखिरी तिहाई में डटी है और दबाव बढ़ता जा रहा है।",
        },
        "analyst": {
            "goal": "{team} ने {player} के ज़रिए गोल किया ({minute}')। यह गोल खेल के संतुलन को दर्शाता है: {facts}। स्कोर: {score}।",
            "red_card": "{player} को बाहर भेजा गया ({minute}'), {team} एक खिलाड़ी कम है। अब गहरी रक्षा पंक्ति और कम आगे के पास की उम्मीद है: {facts}।",
            "big_chance": "{player} को {team} के लिए उच्च गुणवत्ता का मौका मिला ({minute}')। मौके की गुणवत्ता: {facts}।",
            "momentum_swing": "खेल की गति अब {team} के पक्ष में है ({minute}')। क्षेत्र और शॉट की संख्या अब उनके पक्ष में है: {facts}।",
            "sustained_pressure": "{team} ने कई मिनटों से आक्रमण क्षेत्र में ऊँचा दबाव बनाए रखा है ({minute}'): {facts}।",
        },
    },
}

_RECAP: dict[Language, dict[str, str]] = {
    "en": {
        "half_time": "Half-time", "full_time": "Full-time",
        "lead": "{leader} lead {score}.", "level": "{home} and {away} are level at {score}.",
        "shots": "Shots {home_shots}-{away_shots}, possession {home_poss}%-{away_poss}%.",
        "xg": "Expected goals {home_xg}-{away_xg}.",
        "moments": "{count} key moments so far.",
    },
    "es": {
        "half_time": "Descanso", "full_time": "Final",
        "lead": "{leader} gana {score}.", "level": "{home} y {away} empatan {score}.",
        "shots": "Remates {home_shots}-{away_shots}, posesión {home_poss}%-{away_poss}%.",
        "xg": "Goles esperados {home_xg}-{away_xg}.",
        "moments": "{count} momentos clave hasta ahora.",
    },
    "hi": {
        "half_time": "हाफ टाइम", "full_time": "फुल टाइम",
        "lead": "{leader} {score} से आगे है।", "level": "{home} और {away} {score} से बराबरी पर हैं।",
        "shots": "शॉट {home_shots}-{away_shots}, कब्ज़ा {home_poss}%-{away_poss}%।",
        "xg": "अपेक्षित गोल {home_xg}-{away_xg}।",
        "moments": "अब तक {count} अहम पल।",
    },
}


def _percent(value: float) -> str:
    return str(round(value))


class ScriptedNarrativeWriter:
    model = "scripted"

    async def write_moment(self, ctx: MomentContext) -> dict[Variant, WrittenText]:
        moment = ctx.moment
        team = (ctx.home if moment.team == "home" else ctx.away).name
        values = dict(team=team, player=ctx.player_name or team, minute=moment.minute,
                      score=f"{moment.score_home}-{moment.score_away}")
        return {
            (mode, language): WrittenText(
                _MOMENT[language][mode][moment.kind].format(**values, facts=fact_text(moment.facts, language)),
                "scripted")
            for mode, language in VARIANTS
        }

    async def write_recap(self, ctx: RecapContext) -> dict[Variant, WrittenRecap]:
        home, away = ctx.stats.home, ctx.stats.away
        score = f"{home.goals}-{away.goals}"
        leader = None if home.goals == away.goals else (ctx.home.name if home.goals > away.goals else ctx.away.name)
        values = dict(home=ctx.home.name, away=ctx.away.name, score=score, leader=leader,
                      home_shots=home.shots, away_shots=away.shots,
                      home_poss=_percent(home.possession), away_poss=_percent(away.possession),
                      home_xg=home.xg, away_xg=away.xg, count=len(ctx.moments))
        written = {}
        for mode, language in VARIANTS:
            strings = _RECAP[language]
            headline = strings["level" if leader is None else "lead"].format(**values)
            shots, expected = strings["shots"].format(**values), strings["xg"].format(**values)
            title = f"{strings[ctx.period]}: {ctx.home.name} {score} {ctx.away.name}"
            closing = strings["moments"].format(**values) if mode == "fan" else f"{shots} {expected}"
            written[(mode, language)] = WrittenRecap(title, (headline, shots, expected), f"{headline} {closing}", "scripted")
        return written

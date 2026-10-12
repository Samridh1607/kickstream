"""Localized labels shared by the scripted writer and the overlay engine."""

from kickstream.contracts import StatFact
from kickstream.domain.types import Language

FACT_LABELS: dict[Language, dict[str, str]] = {
    "en": {
        "xg": "expected goals", "shots": "shots", "shots_on_target": "shots on target",
        "possession": "possession %", "pressure": "pressure", "momentum": "momentum",
        "players_on_pitch": "players on pitch", "fouls": "fouls",
    },
    "es": {
        "xg": "goles esperados", "shots": "remates", "shots_on_target": "remates a puerta",
        "possession": "posesión %", "pressure": "presión", "momentum": "impulso",
        "players_on_pitch": "jugadores en el campo", "fouls": "faltas",
    },
    "hi": {
        "xg": "अपेक्षित गोल", "shots": "शॉट", "shots_on_target": "निशाने पर शॉट",
        "possession": "कब्ज़ा %", "pressure": "दबाव", "momentum": "गति",
        "players_on_pitch": "मैदान पर खिलाड़ी", "fouls": "फाउल",
    },
}

KIND_LABELS: dict[Language, dict[str, str]] = {
    "en": {"goal": "GOAL", "red_card": "RED CARD", "big_chance": "BIG CHANCE",
           "momentum_swing": "MOMENTUM SHIFT", "sustained_pressure": "SUSTAINED PRESSURE"},
    "es": {"goal": "GOL", "red_card": "TARJETA ROJA", "big_chance": "GRAN OCASIÓN",
           "momentum_swing": "CAMBIO DE IMPULSO", "sustained_pressure": "PRESIÓN SOSTENIDA"},
    "hi": {"goal": "गोल", "red_card": "रेड कार्ड", "big_chance": "बड़ा मौका",
           "momentum_swing": "रुख बदला", "sustained_pressure": "लगातार दबाव"},
}


def _number(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else f"{value:.2f}"


def fact_text(facts: list[StatFact], language: Language) -> str:
    labels = FACT_LABELS[language]
    return ", ".join(f"{labels[fact.label]} {_number(fact.value)}" for fact in facts)

"""Chooses between the agent writer and the scripted writer for each item.

Order of preference: cached agent output, a fresh agent call if the budget allows,
then scripted text. Any failure or incomplete result falls back for the whole item.
"""

import asyncio
import dataclasses
import hashlib
import json
import logging

from pydantic import BaseModel

from kickstream.contracts import Narrative, Recap
from kickstream.domain.types import VARIANTS
from kickstream.narration.budget import Budget
from kickstream.narration.cache import DiskCache
from kickstream.ports.writer import (
    MomentContext,
    NarrationError,
    NarrativeWriter,
    RecapContext,
    WrittenRecap,
    WrittenText,
)

log = logging.getLogger(__name__)
MOMENT_COST = 3  # commentator + tactical analyst + localizer
RECAP_COST = 2  # recap writer + localizer


# Identifiers that name a particular run of a match. They never reach a prompt, and leaving
# them in the key would make every replay of the same seeded match a cache miss.
_RUN_IDS = frozenset({"id", "match_id", "event_id"})


def _plain(value):
    """The context as plain data, without run identifiers."""
    if isinstance(value, BaseModel):
        return _plain(value.model_dump())
    if dataclasses.is_dataclass(value):
        return _plain({f.name: getattr(value, f.name) for f in dataclasses.fields(value)})
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items() if key not in _RUN_IDS}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def _cache_key(model: str, kind: str, ctx) -> str:
    # A prompt is a pure function of the context's content, so hashing that content stands in
    # for hashing the prompt.
    canonical = json.dumps(_plain(ctx), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(f"{model}\n{kind}\n{canonical}".encode()).hexdigest()


def _encode(written: dict) -> dict:
    return {f"{mode}:{language}": dataclasses.asdict(item) for (mode, language), item in written.items()}


def _decode(kind: str, raw: dict) -> dict:
    written = {}
    for key, item in raw.items():
        mode, language = key.split(":")
        if kind == "moment":
            written[(mode, language)] = WrittenText(item["text"], item["agent"])
        else:
            written[(mode, language)] = WrittenRecap(
                item["title"], tuple(item["bullets"]), item["text"], item["agent"]
            )
    return written


def _require_complete(written: dict) -> None:
    for variant in VARIANTS:
        item = written.get(variant)
        if item is None:
            raise NarrationError(f"missing variant {variant}")
        parts = [item.text]
        if isinstance(item, WrittenRecap):
            if len(item.bullets) != 3:
                raise NarrationError(f"recap {variant} needs three bullets")
            parts += [item.title, *item.bullets]
        if not all(isinstance(part, str) and part.strip() for part in parts):
            raise NarrationError(f"blank text in variant {variant}")


class NarrationService:
    def __init__(
        self,
        fallback: NarrativeWriter,
        primary: NarrativeWriter | None = None,
        budget: Budget | None = None,
        cache: DiskCache | None = None,
        timeout_s: float = 20.0,
    ) -> None:
        self._fallback = fallback
        self._primary = primary
        self._budget = budget
        self._cache = cache
        self._timeout_s = timeout_s

    async def moment(self, ctx: MomentContext) -> list[Narrative]:
        written, source = await self._write(
            "moment", ctx.moment.match_id, ctx, MOMENT_COST, ctx.moment.kind == "goal"
        )
        return self._narratives(ctx, written, source)

    async def scripted_moment(self, ctx: MomentContext) -> list[Narrative]:
        return self._narratives(ctx, await self._fallback.write_moment(ctx), "scripted")

    async def recap(self, ctx: RecapContext) -> list[Recap]:
        written, source = await self._write("recap", ctx.match_id, ctx, RECAP_COST, True)
        return [
            Recap(
                id=f"{ctx.match_id}-r-{ctx.period}-{mode}-{language}",
                match_id=ctx.match_id,
                minute=ctx.minute,
                period=ctx.period,
                mode=mode,
                language=language,
                title=item.title.strip(),
                bullets=[bullet.strip() for bullet in item.bullets],
                text=item.text.strip(),
                source=source,
                agent=item.agent,
                score_home=ctx.stats.home.goals,
                score_away=ctx.stats.away.goals,
            )
            for (mode, language), item in ((variant, written[variant]) for variant in VARIANTS)
        ]

    def _narratives(self, ctx: MomentContext, written: dict, source: str) -> list[Narrative]:
        moment = ctx.moment
        evidence = [
            moment.id,
            *([moment.event_id] if moment.event_id else []),
            *([ctx.stats.id] if ctx.stats else []),
        ]
        return [
            Narrative(
                id=f"{moment.id}-{mode}-{language}",
                match_id=moment.match_id,
                minute=moment.minute,
                moment_id=moment.id,
                mode=mode,
                language=language,
                text=written[(mode, language)].text.strip(),
                source=source,
                agent=written[(mode, language)].agent,
                evidence=evidence,
                team=moment.team,
                player_id=moment.player_id,
            )
            for mode, language in VARIANTS
        ]

    async def _write(self, kind: str, match_id: str, ctx, cost: int, priority: bool) -> tuple[dict, str]:
        if self._primary is not None:
            key = _cache_key(self._primary.model, kind, ctx)
            cached = self._cache.get(key) if self._cache else None
            if cached is not None:
                try:
                    written = _decode(kind, cached)
                    _require_complete(written)
                    return written, "agent"
                except (KeyError, TypeError, ValueError, NarrationError):
                    log.warning("ignoring unreadable narration cache entry %s", key)
            if self._budget is None or self._budget.try_spend(match_id, cost, priority):
                try:
                    call = (
                        self._primary.write_moment(ctx)
                        if kind == "moment"
                        else self._primary.write_recap(ctx)
                    )
                    written = await asyncio.wait_for(call, self._timeout_s)
                    _require_complete(written)
                    if self._cache:
                        self._cache.put(key, _encode(written))
                    return written, "agent"
                except Exception as exc:  # noqa: BLE001 - every model failure falls back to scripted text
                    log.warning(
                        "agent writer failed for %s in %s (%s); using scripted text", kind, match_id, exc
                    )
        call = self._fallback.write_moment(ctx) if kind == "moment" else self._fallback.write_recap(ctx)
        return await call, "scripted"

from kickstream.contracts import Envelope, ViewerProfile
from kickstream.ports.store import LogItem

_HIGHLIGHTABLE = {"key_moment", "narrative", "highlight"}


def to_envelope(item: LogItem, profile: ViewerProfile) -> Envelope | None:
    """Shape one log item for one viewer, or drop it if it is another viewer's variant."""
    if item.language is not None and item.language != profile.language:
        return None
    if item.mode is not None and item.mode != profile.mode:
        return None
    favorite = (profile.club is not None and item.team_id == profile.club) or (
        profile.player is not None and item.player_id == profile.player
    )
    return Envelope(
        id=item.id,
        type=item.type,
        match_id=item.match_id,
        minute=item.minute,
        highlighted=item.type in _HIGHLIGHTABLE and favorite,
        payload=item.payload.model_dump(mode="json"),
    )

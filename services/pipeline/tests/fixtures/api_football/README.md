These API-Football responses are hand-written from the documented response shape at
https://www.api-football.com/documentation-v3 (`GET /fixtures?date=` and `GET /fixtures?id=`), because no key was
available when the adapter was written. The clubs are real, but the players, ids and numbers are invented.
`fixture-1.json` to `fixture-4.json` are one match followed from the 12th minute to full time. Two details are
unverified: which of `player` / `assist` in a `subst` event is the player coming on, and which team an `Own Goal`
is listed under. Replace these files with recorded responses when a key is at hand (see Task 18 of
`docs/superpowers/plans/2026-10-14-kickstream-real-match-data.md`), never committing the key itself.

import type { People } from "../contracts";
import type { CameraTile } from "../studio/elements";

/** The people on stage, as the cameras element draws them. */
export const stageTiles = (people: People | null): CameraTile[] =>
  (people?.stage ?? []).map((person) => ({ id: person.id, name: person.name, acsId: person.acs_id ?? null, present: person.present }));

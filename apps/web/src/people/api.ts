import type { CallSeat, Guest, People } from "../contracts";
import { send } from "../studio/api";

export type Role = "speaker" | "cohost" | "member";
export const ROLE_NAMES: Record<Role, string> = { speaker: "Speaker", cohost: "Co-host", member: "Member" };

const id = encodeURIComponent;
const base = (broadcastId: string) => `/api/broadcasts/${id(broadcastId)}/people`;
const guestBase = (secret: string) => `/api/guest/${id(secret)}`;

export const peopleStream = (broadcastId: string) => `${base(broadcastId)}/stream`;
export const invite = (broadcastId: string, role: Role, name: string) =>
  send<People>("POST", `${base(broadcastId)}/invites`, name.trim() ? { role, name: name.trim() } : { role });
export const revokeInvite = (broadcastId: string, inviteId: string) => send<People>("DELETE", `${base(broadcastId)}/invites/${id(inviteId)}`);
export const setStage = (broadcastId: string, people: string[]) => send<People>("PUT", `${base(broadcastId)}/stage`, { people });
export const hostSeat = (broadcastId: string, name: string) => send<CallSeat>("POST", `${base(broadcastId)}/host/seat`, { name });
export const programSeat = (broadcastId: string) => send<CallSeat>("POST", `${base(broadcastId)}/program/seat`);

export const guestStream = (secret: string) => `${guestBase(secret)}/stream`;
export const getGuest = (secret: string) => send<Guest>("GET", guestBase(secret));
export const joinAsGuest = (secret: string, name: string) => send<CallSeat>("POST", `${guestBase(secret)}/join`, { name: name.trim() });
export const refreshGuestSeat = (secret: string) => send<CallSeat>("POST", `${guestBase(secret)}/seat/refresh`);

/** The address a guest opens: the public one when there is one, else this page's. */
export const inviteLink = (people: People, link: string, origin = window.location.origin) => `${people.public_origin ?? origin}${link}`;

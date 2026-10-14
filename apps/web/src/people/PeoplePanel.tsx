import type { Invite } from "../contracts";
import { ROLE_NAMES } from "./api";

export const HOST = "host";
export const SETUP = "Guests need Azure Communication Services. Put KICKSTREAM_ACS_CONNECTION_STRING in the .env file at the top of the project, then restart the pipeline.";

export const inviteLabel = (item: Invite) => item.joined_name ?? item.name ?? ROLE_NAMES[item.role];

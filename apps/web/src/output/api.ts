import type { Destination, Output } from "../contracts";
import { send } from "../studio/api";

export const OUTPUT_STREAM = "/api/studio/output/stream";

const id = encodeURIComponent;
const call = (method: string, path: string, body?: unknown) => send<Output>(method, `/api/studio/output${path}`, body);

export const addDestination = (added: { name: string; platform: Destination["platform"]; url: string; key: string }) => call("POST", "/destinations", added);
/** The key is left out, so the stored one is kept. */
export const setDestinationEnabled = (changed: Destination, enabled: boolean) =>
  call("PUT", `/destinations/${id(changed.id)}`, { name: changed.name, url: changed.url, enabled });
export const removeDestination = (destinationId: string) => call("DELETE", `/destinations/${id(destinationId)}`);
export const setQuality = (quality: Output["quality"]) => call("PUT", "/quality", { quality });
export const goLive = () => call("POST", "/start");
export const stopOutput = () => call("POST", "/stop");

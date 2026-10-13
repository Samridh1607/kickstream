import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Output } from "../contracts";
import { destination, output } from "../test/fixtures";
import { renderUi } from "../test/render";
import { OutputTab } from "./OutputTab";

interface Call {
  url: string;
  method: string;
  body: any;
}

function setup(doc: Output | null = output(), accepted = true) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(doc ?? output()), { status: 200 });
  }));
  const onRun = vi.fn(async (request: () => Promise<Output>) => {
    await request();
    return accepted;
  });
  renderUi(<OutputTab output={doc} now={1100} onRun={onRun} />);
  return { calls };
}

const last = (calls: Call[]) => calls[calls.length - 1];
const KEY = "sk-live-abcd-1234-wxyz";

test("before the output arrives the tab says it is connecting", () => {
  setup(null);
  expect(screen.getByText("Connecting to the output…")).toBeTruthy();
});

test("with no destinations it says how to begin and cannot go live", () => {
  setup();
  expect(screen.getByText("Add a destination to go live.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Go live" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Off air")).toBeTruthy();
});

test("a destination is added with its key, and the key box is emptied afterwards", async () => {
  const { calls } = setup();
  fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "youtube" } });
  expect((screen.getByLabelText("Server address") as HTMLInputElement).placeholder).toBe("rtmp://a.rtmp.youtube.com/live2");
  const key = screen.getByLabelText("Stream key") as HTMLInputElement;
  expect(key.type).toBe("password");
  expect(key.getAttribute("autocomplete")).toBe("off");
  fireEvent.change(key, { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(last(calls)).toEqual({
    url: "/api/studio/output/destinations", method: "POST", body: { name: "YouTube", platform: "youtube", url: "", key: KEY },
  }));
  await waitFor(() => expect(key.value).toBe(""));
});

test("a refused destination keeps what was typed", async () => {
  setup(output(), false);
  const key = screen.getByLabelText("Stream key") as HTMLInputElement;
  fireEvent.change(key, { target: { value: KEY } });
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(key.value).toBe(KEY);
});

test("recording to a file asks for no address or key", async () => {
  const { calls } = setup();
  fireEvent.change(screen.getByLabelText("Platform"), { target: { value: "file" } });
  expect(screen.queryByLabelText("Stream key")).toBeNull();
  expect(screen.queryByLabelText("Server address")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add destination" }));
  await waitFor(() => expect(last(calls).body).toEqual({ name: "Record to file", platform: "file", url: "", key: "" }));
});

test("idle destinations can be switched, removed and sent live", async () => {
  const doc = output({ destinations: [destination(), destination({ id: "d2", name: "Recording", platform: "file", url: "", key_hint: "", enabled: false })] });
  const { calls } = setup(doc);
  const first = within(screen.getByTestId("destination-d1"));
  expect(first.getByText("Key ending wxyz")).toBeTruthy();
  fireEvent.click(first.getByRole("switch", { name: "Send to YouTube" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/output/destinations/d1", method: "PUT", body: { enabled: false } }));
  fireEvent.click(within(screen.getByTestId("destination-d2")).getByRole("button", { name: "Remove Recording" }));
  await waitFor(() => expect(last(calls)).toMatchObject({ url: "/api/studio/output/destinations/d2", method: "DELETE" }));
  fireEvent.change(screen.getByLabelText("Quality"), { target: { value: "1080p30" } });
  await waitFor(() => expect(last(calls).body).toEqual({ quality: "1080p30" }));
  fireEvent.click(screen.getByRole("button", { name: "Go live" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/output/start"));
});

test("while live it shows how long, each destination's status, and only Stop", async () => {
  const doc = output({
    state: "live", started_at: 1000 - 75,
    destinations: [
      destination({ status: "live", live_since: 930 }),
      destination({ id: "d2", name: "X", platform: "x", status: "retrying", reason: "Connection refused" }),
      destination({ id: "d3", name: "Facebook", platform: "facebook", status: "failed", reason: "Bad key" }),
    ],
  });
  const { calls } = setup(doc);
  const stream = within(screen.getByRole("region", { name: "Stream" }));
  expect(stream.getByText("Live")).toBeTruthy();
  expect(stream.getByText("2:55")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d1")).getByText("Live")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d2")).getByText("Retrying")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d2")).getByText("Connection refused")).toBeTruthy();
  expect(within(screen.getByTestId("destination-d3")).getByText("Failed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Go live" })).toBeNull();
  expect((screen.getByRole("switch", { name: "Send to YouTube" }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText("Quality") as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Add destination" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(last(calls).url).toBe("/api/studio/output/stop"));
});

test("starting and stopping are shown, and Stop cannot be pressed twice", () => {
  setup(output({ state: "stopping", destinations: [destination()] }));
  expect(screen.getByText("Stopping")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a run that ended by itself says why, and recordings are listed with their size", () => {
  setup(output({ problem: "The hidden browser stopped.", recordings: [{ file: "2026-10-13-101500.mp4", size_bytes: 5_400_000, made_at: 900 }] }));
  expect(screen.getByText("The hidden browser stopped.")).toBeTruthy();
  expect(screen.getByText("2026-10-13-101500.mp4")).toBeTruthy();
  expect(screen.getByText("5.4 MB")).toBeTruthy();
});

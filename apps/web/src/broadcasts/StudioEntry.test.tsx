import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Broadcasts } from "../contracts";
import { broadcast, broadcasts, endedBroadcast, FakeEventSource, FakeEventSourceCtor } from "../test/fixtures";
import { renderUi } from "../test/render";
import { StudioEntry } from "./StudioEntry";

function show(doc: Broadcasts) {
  const navigate = vi.fn();
  renderUi(<StudioEntry eventSource={FakeEventSourceCtor} retryMs={10} navigate={navigate} />);
  act(() => {
    const source = FakeEventSource.instances.filter((item) => item.url === "/api/broadcasts/stream" && !item.closed).at(-1)!;
    source.open();
    source.emitRaw(JSON.stringify(doc));
  });
  return navigate;
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

test("the studio opens on the broadcast that is live", () => {
  const navigate = show(broadcasts({
    broadcasts: [broadcast(), broadcast({ id: "b2", title: "On air", state: "live" })], current_id: "b2",
  }));
  expect(navigate).toHaveBeenCalledWith("/broadcasts/b2/studio");
});

test("with nothing live, the studio opens on the current broadcast", () => {
  const navigate = show(broadcasts({ broadcasts: [broadcast()], current_id: "b1" }));
  expect(navigate).toHaveBeenCalledWith("/broadcasts/b1/studio");
});

test("with no current broadcast, the studio asks for one: a ready one, or a new one", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify(broadcasts({ revision: 3, broadcasts: [broadcast({ id: "b9", title: "Cup final" })], current_id: "b9" })), { status: 200 },
  )));
  const navigate = show(broadcasts({ broadcasts: [broadcast({ id: "b2", title: "Next week" }), endedBroadcast()] }));
  expect(navigate).not.toHaveBeenCalled();
  const choice = within(screen.getByRole("region", { name: "Choose a broadcast" }));
  expect(choice.getByRole("heading", { name: "Choose a broadcast for the studio" })).toBeTruthy();
  const ready = within(choice.getByRole("list", { name: "Broadcasts ready to go live" }));
  expect(ready.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/broadcasts/b2/studio"]);

  fireEvent.click(choice.getByRole("button", { name: "Create a broadcast" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByRole("textbox", { name: /Title/ }), { target: { value: "Cup final" } });
  fireEvent.click(dialog.getByRole("button", { name: "Create broadcast" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("/broadcasts/b9/studio"));
});

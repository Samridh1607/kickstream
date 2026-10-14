import { fireEvent, screen, within } from "@testing-library/react";
import type { StudioBroadcast } from "../broadcasts/StudioBroadcast";
import type { Broadcast } from "../contracts";
import { broadcast, broadcasts, destination, output } from "../test/fixtures";
import { renderUi } from "../test/render";
import { TopBar, type TopBarProps } from "./TopBar";

const NOW = 10_000;

function linkTo(item: Broadcast | null, over: Partial<StudioBroadcast> = {}): StudioBroadcast {
  return {
    doc: broadcasts({ broadcasts: item ? [item] : [], current_id: item?.id ?? null }),
    broadcast: item, liveElsewhere: null, accept: vi.fn(), refusal: null, ...over,
  };
}

function show(over: Partial<TopBarProps> = {}) {
  const props: TopBarProps = {
    link: linkTo(broadcast()), output: output(), connected: true, onAirName: "Live match", editing: false,
    onToggleEdit: vi.fn(), now: NOW, ...over,
  };
  renderUi(<TopBar {...props} />);
  return props;
}

const bar = () => within(screen.getByRole("region", { name: "Studio top bar" }));
const live = broadcast({ state: "live", sessions: [{ started_at: NOW - 3661, ended_at: null, destinations: [], problem: null }] });

test("while the broadcast is live the top bar shows an elapsed timer and End broadcast", () => {
  const onEnd = vi.fn();
  show({
    link: linkTo(live), onGoLive: vi.fn(), onEnd,
    output: output({ state: "live", started_at: NOW - 3661, destinations: [destination({ status: "live" }), destination({ id: "d2", name: "Twitch", enabled: false })] }),
  });
  expect(bar().getByText("LIVE")).toBeTruthy();
  expect(bar().getByText("1:01:01")).toBeTruthy();
  expect(bar().queryByRole("button", { name: "Go live" })).toBeNull();
  const lights = within(bar().getByRole("group", { name: "Destinations" }));
  expect(lights.getByText("YouTube")).toBeTruthy();
  expect(lights.getByText("Live")).toBeTruthy();
  expect(lights.queryByText("Twitch")).toBeNull();
  fireEvent.click(bar().getByRole("button", { name: "End broadcast" }));
  expect(onEnd).toHaveBeenCalledWith(live);
});

test("under an hour the timer still shows hours", () => {
  show({ link: linkTo(broadcast({ state: "live", sessions: [{ started_at: NOW - 65, ended_at: null, destinations: [], problem: null }] })), onEnd: vi.fn() });
  expect(bar().getByText("0:01:05")).toBeTruthy();
});

test("End broadcast waits while busy", () => {
  show({ link: linkTo(live), onEnd: vi.fn(), busy: true });
  expect((bar().getByRole("button", { name: "End broadcast" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a ready broadcast offers Go live, which calls onGoLive", () => {
  const onGoLive = vi.fn();
  show({ onGoLive, onEnd: vi.fn() });
  expect(bar().getByText("Ready")).toBeTruthy();
  expect(bar().getByText("Recording on")).toBeTruthy();
  expect(bar().queryByRole("button", { name: "End broadcast" })).toBeNull();
  fireEvent.click(bar().getByRole("button", { name: "Go live" }));
  expect(onGoLive).toHaveBeenCalledTimes(1);
});

test("a blocked Go live is disabled and says why", () => {
  const onGoLive = vi.fn();
  show({ onGoLive, goLiveBlocked: "Turn on a destination in the Stream tool first." });
  const go = bar().getByRole("button", { name: "Go live" });
  expect(go.getAttribute("aria-disabled")).toBe("true");
  expect(go.getAttribute("title")).toBe("Turn on a destination in the Stream tool first.");
  fireEvent.click(go);
  expect(onGoLive).not.toHaveBeenCalled();
});

test("what the page adds sits in the bar", () => {
  show({ extras: <button type="button">Ask Copilot</button> });
  expect(bar().getByRole("button", { name: "Ask Copilot" })).toBeTruthy();
});

test("without onGoLive there is no Go live button", () => {
  show();
  expect(bar().queryByRole("button", { name: "Go live" })).toBeNull();
});

test("Edit layout calls onToggleEdit and shows whether layout editing is open", () => {
  const props = show();
  const toggle = bar().getByRole("button", { name: "Edit layout" });
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(toggle);
  expect(props.onToggleEdit).toHaveBeenCalledTimes(1);
});

test("Edit layout is pressed while layout editing is open", () => {
  show({ editing: true });
  expect(bar().getByRole("button", { name: "Edit layout" }).getAttribute("aria-pressed")).toBe("true");
});

test("Shortcuts is a placeholder for a later phase", () => {
  show();
  const shortcuts = bar().getByRole("button", { name: "Shortcuts" });
  expect(shortcuts.getAttribute("aria-disabled")).toBe("true");
  expect(shortcuts.getAttribute("title")).toBe("Coming in a later phase");
});

test("the broadcast part names the broadcast and links back to it", () => {
  show();
  const part = within(bar().getByRole("region", { name: "Studio broadcast" }));
  expect(part.getByRole("link", { name: "Derby day" }).getAttribute("href")).toBe("/broadcasts/b1");
  expect(part.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
  expect(part.getByText("Studio").getAttribute("aria-current")).toBe("page");
});

test("the bar shows the connection and the scene on air", () => {
  show({ connected: false, onAirName: "Break" });
  expect(bar().getByText("Reconnecting")).toBeTruthy();
  expect(bar().getByText("On air: Break")).toBeTruthy();
});

test("a deleted broadcast is explained", () => {
  show({ link: linkTo(null) });
  expect(bar().getByText(/This broadcast no longer exists/)).toBeTruthy();
  expect(bar().getByRole("link", { name: "Choose or create one on Home" }).getAttribute("href")).toBe("/");
});

test("an ended broadcast is explained and cannot be ended again", () => {
  show({ link: linkTo(broadcast({ state: "ended" })), onEnd: vi.fn() });
  expect(bar().getByText("Ended")).toBeTruthy();
  expect(bar().getByText(/This broadcast has ended, so it cannot go live again/)).toBeTruthy();
  expect(bar().queryByRole("button", { name: "End broadcast" })).toBeNull();
});

test("another broadcast on air is explained with a link to its studio", () => {
  show({ link: linkTo(broadcast(), { liveElsewhere: broadcast({ id: "b2", title: "Cup final", state: "live" }) }) });
  expect(bar().getByText(/“Cup final” is live/)).toBeTruthy();
  expect(bar().getByRole("link", { name: "Open its studio" }).getAttribute("href")).toBe("/broadcasts/b2/studio");
});

test("a refusal to open the broadcast is shown", () => {
  show({ link: linkTo(broadcast(), { refusal: "Another broadcast is current." }) });
  expect(bar().getByText("Another broadcast is current.")).toBeTruthy();
});

test("the plain studio has no broadcast part but shows the stream while it is live", () => {
  show({ link: null, output: output({ state: "live", started_at: NOW - 30, destinations: [destination({ status: "connecting" })] }) });
  expect(bar().queryByRole("region", { name: "Studio broadcast" })).toBeNull();
  expect(bar().getByText("LIVE")).toBeTruthy();
  expect(bar().getByText("0:00:30")).toBeTruthy();
  expect(bar().getByText("Connecting")).toBeTruthy();
});

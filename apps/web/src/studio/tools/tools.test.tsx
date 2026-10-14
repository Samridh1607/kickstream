import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { People } from "../../contracts";
import { renderUi } from "../../test/render";
import { invitation, output, peopleDoc, studio } from "../../test/fixtures";
import { SETUP } from "../../people/PeoplePanel";
import { BannersTool } from "./BannersTool";
import { GuestsTool } from "./GuestsTool";
import { StreamTool } from "./StreamTool";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function serve(answer: People = peopleDoc()) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return sent;
}

function showBanners() {
  const props = { onShow: vi.fn(async () => true), onClear: vi.fn(), onAuto: vi.fn(), onSaveTicker: vi.fn() };
  renderUi(<BannersTool studio={studio()} {...props} />);
  return props;
}

/** Runs each request as the studio page does and reports whether it was accepted. */
function showGuests(people: People | null) {
  const onRun = vi.fn(async (request: () => Promise<People>) => {
    await request();
    return true;
  });
  renderUi(<GuestsTool broadcastId="b1" people={people} onRun={onRun} />);
  return onRun;
}

test("the banners tool shows the banner and the ticker, and shows the banner typed", async () => {
  const { onShow } = showBanners();
  expect(screen.getByRole("region", { name: "Banner" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Ticker" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Banner text"), { target: { value: "Half-time" } });
  fireEvent.click(screen.getByRole("button", { name: "Show banner" }));
  await waitFor(() => expect(onShow).toHaveBeenCalledWith("Half-time"));
});

test("saving the ticker sends one message per line", () => {
  const { onSaveTicker } = showBanners();
  fireEvent.change(screen.getByLabelText("Messages, one per line"), { target: { value: "Welcome\n\n  Kick-off at 3  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save ticker" }));
  expect(onSaveTicker).toHaveBeenCalledWith(expect.objectContaining({ messages: ["Welcome", "Kick-off at 3"] }));
});

test("the guests tool invites someone with a role and a name, then clears the name", async () => {
  const sent = serve();
  const onRun = showGuests(peopleDoc());
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "cohost" } });
  fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Kim" } });
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => expect(onRun).toHaveBeenCalled());
  expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites", method: "POST", body: { role: "cohost", name: "Kim" } });
  await waitFor(() => expect((screen.getByLabelText("Name (optional)") as HTMLInputElement).value).toBe(""));
});

test("revoking an invite from the guests tool stops the link", async () => {
  const sent = serve();
  const onRun = showGuests(peopleDoc({ invites: [invitation()] }));
  const guests = within(screen.getByRole("list", { name: "Guests" }));
  expect((guests.getByLabelText("Invite link for Sam") as HTMLInputElement).value).toBe("https://guests.example/guest/abc");
  fireEvent.click(guests.getByRole("button", { name: "Revoke invite for Sam" }));
  await waitFor(() => expect(onRun).toHaveBeenCalled());
  expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites/i1", method: "DELETE" });
});

test("with no calling service the guests tool says how to set one up", () => {
  showGuests(peopleDoc({ service: null }));
  expect(screen.getByText(SETUP)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
});

test("the stream tool shows the output controls with one Stream region", () => {
  renderUi(<StreamTool output={output()} now={1000} onRun={vi.fn(async () => true)} />);
  expect(screen.getByRole("region", { name: "Stream" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Destinations" })).toBeTruthy();
});

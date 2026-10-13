import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JoinOptions } from "../calls/RoomCall";
import type { People } from "../contracts";
import { callSeat, invitation, peopleDoc } from "../test/fixtures";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { PeoplePanel, SETUP } from "./PeoplePanel";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

const hostSeatAnswer = async () => new Response(JSON.stringify(callSeat({ acs_id: "8:fake:host" })), { status: 200 });

function serve(answer: People = peopleDoc(), seat: () => Promise<Response> = hostSeatAnswer) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/seat")) return seat();
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return sent;
}

function show(people: People | null, { live = false, call = new FakeRoomCall() } = {}) {
  const onPeople = vi.fn();
  const ui = (doc: People | null, isLive = live) => (
    <FluentProvider theme={webLightTheme}>
      <PeoplePanel broadcastId="b1" people={doc} live={isLive} onPeople={onPeople} newCall={() => call} />
    </FluentProvider>
  );
  const view = render(ui(people));
  return { onPeople, call, unmount: view.unmount, rerender: (doc: People | null, isLive = live) => view.rerender(ui(doc, isLive)) };
}

const joinedSam = invitation({ joined_name: "Sam", acs_id: "8:fake:2", present: true });

test("with no calling service the panel says how to set one up", () => {
  serve();
  show(peopleDoc({ service: null }));
  expect(screen.getByText(SETUP)).toBeTruthy();
});

test("the streamer invites someone with a role and an optional name", async () => {
  const sent = serve();
  const { onPeople } = show(peopleDoc());
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "cohost" } });
  fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Kim" } });
  fireEvent.click(screen.getByRole("button", { name: "Invite" }));
  await waitFor(() => expect(onPeople).toHaveBeenCalled());
  expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites", method: "POST", body: { role: "cohost", name: "Kim" } });
});

test("each invite shows its public link to copy, its role and whether the guest is here", async () => {
  serve();
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show(peopleDoc({ invites: [joinedSam, invitation({ id: "i2", role: "member", name: "Mia", link: "/guest/def" })] }));
  const guests = within(screen.getByRole("list", { name: "Guests" }));
  expect((guests.getByLabelText("Invite link for Sam") as HTMLInputElement).value).toBe("https://guests.example/guest/abc");
  fireEvent.click(guests.getByRole("button", { name: "Copy link for Sam" }));
  expect(writeText).toHaveBeenCalledWith("https://guests.example/guest/abc");
  expect(guests.getByText("Present")).toBeTruthy();
  expect(guests.getByText("Not joined yet")).toBeTruthy();
  expect(guests.getByText("Member")).toBeTruthy();
});

test("joined speakers go on and off the stage, and members never do", async () => {
  const sent = serve();
  const { rerender } = show(peopleDoc({ invites: [joinedSam, invitation({ id: "i2", role: "member", name: "Mia", link: "/guest/def", acs_id: "8:fake:3" })] }));
  expect(screen.queryByRole("button", { name: "Add Mia to stage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Sam to stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/stage", method: "PUT", body: { people: ["i1"] } }));
  rerender(peopleDoc({ invites: [joinedSam], stage: [{ id: "i1", name: "Sam", acs_id: "8:fake:2", present: true }] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Sam from stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ body: { people: [] } }));
});

test("while a stage change is on its way the stage cannot be changed again", async () => {
  let answer: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
  const joinedJo = invitation({ id: "i2", name: "Jo", link: "/guest/def", joined_name: "Jo", acs_id: "8:fake:3", present: true });
  show(peopleDoc({ invites: [joinedSam, joinedJo] }));
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  fireEvent.click(button("Add Sam to stage"));
  await waitFor(() => expect(button("Add Jo to stage").disabled).toBe(true));
  expect(button("Add Sam to stage").disabled).toBe(true);
  await act(async () => answer(new Response(JSON.stringify(peopleDoc()), { status: 200 })));
  await waitFor(() => expect(button("Add Jo to stage").disabled).toBe(false));
});

test("a host on stage without their camera can still take themselves off", async () => {
  const sent = serve();
  show(peopleDoc({ host_acs_id: "8:fake:host", stage: [{ id: "host", name: "Host", acs_id: "8:fake:host", present: false }] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove me from stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/stage", method: "PUT", body: { people: [] } }));
});

test("a link that cannot be copied is explained", async () => {
  serve();
  const writeText = vi.fn(async () => {
    throw new Error("Denied");
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  show(peopleDoc({ invites: [joinedSam] }));
  fireEvent.click(screen.getByRole("button", { name: "Copy link for Sam" }));
  expect(await screen.findByText("The link could not be copied. Select it and copy it yourself.")).toBeTruthy();
});

test("a guest who has not joined cannot be put on stage yet", () => {
  serve();
  show(peopleDoc({ invites: [invitation()] }));
  expect((screen.getByRole("button", { name: "Add Sam to stage" }) as HTMLButtonElement).disabled).toBe(true);
});

test("revoking an invite asks the pipeline to stop the link", async () => {
  const sent = serve();
  show(peopleDoc({ invites: [joinedSam] }));
  fireEvent.click(screen.getByRole("button", { name: "Revoke invite for Sam" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/invites/i1", method: "DELETE" }));
});

test("the host joins with their camera and can put themselves on stage", async () => {
  const sent = serve();
  const { call, rerender } = show(peopleDoc());
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(sent.find((one) => one.url.endsWith("/host/seat"))).toMatchObject({ method: "POST", body: { name: "Host" } });
  expect(call.joined[0]).toMatchObject({ roomId: "room-1", name: "Host" });
  rerender(peopleDoc({ host_acs_id: "8:fake:host" }));
  fireEvent.click(screen.getByRole("button", { name: "Add me to stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ body: { people: ["host"] } }));
});

test("while live the host off stage is muted and cannot unmute", async () => {
  serve();
  const { call } = show(peopleDoc(), { live: true });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(call.muted).toBe(true);
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
});

test("the host can mute a guest who is in the room", async () => {
  serve();
  const { call } = show(peopleDoc({ invites: [joinedSam] }));
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  fireEvent.click(await screen.findByRole("button", { name: "Mute Sam" }));
  await waitFor(() => expect(call.mutedOthers).toEqual(["8:fake:2"]));
});

test("a host whose broadcast goes live while their seat is pending joins muted", async () => {
  let answer: (response: Response) => void = () => {};
  const sent = serve(peopleDoc(), () => new Promise<Response>((resolve) => { answer = resolve; }));
  const { call, rerender } = show(peopleDoc());
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(sent.some((one) => one.url.endsWith("/host/seat"))).toBe(true));
  await act(async () => call.setMuted(false));
  rerender(peopleDoc(), true);
  await act(async () => answer(new Response(JSON.stringify(callSeat({ acs_id: "8:fake:host" })), { status: 200 })));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(call.muted).toBe(true);
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
});

/** A call whose join connects when the test says, with the microphone as the room left it. */
class ConnectingCall extends FakeRoomCall {
  private connected: (() => void) | null = null;

  override join(options: JoinOptions) {
    this.joined.push(options);
    return new Promise<void>((resolve) => {
      this.connected = resolve;
    });
  }

  connect(muted: boolean) {
    this.muted = muted;
    this.state = "joined";
    this.emit();
    this.connected?.();
  }
}

test("a host off stage is muted again once their call connects during a live broadcast", async () => {
  serve();
  const call = new ConnectingCall();
  const { rerender } = show(peopleDoc(), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  rerender(peopleDoc(), true);
  act(() => call.connect(false));
  await waitFor(() => expect(call.muted).toBe(true));
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
});

/** A call whose join never connects; leaving rejects it, as a superseded join does. */
class StartingCall extends FakeRoomCall {
  private cancel: (() => void) | null = null;

  override join(options: JoinOptions) {
    this.joined.push(options);
    return new Promise<void>((_, reject) => {
      this.cancel = () => reject(new Error("The call was left before it was joined."));
    });
  }

  override async leave() {
    await super.leave();
    this.cancel?.();
  }
}

test("closing the panel leaves the host's call, and the join it cuts short is not an error", async () => {
  serve();
  const call = new StartingCall();
  const errors = vi.spyOn(console, "error");
  const { unmount } = show(peopleDoc(), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  unmount();
  await waitFor(() => expect(call.left).toBe(1));
  expect(errors).not.toHaveBeenCalled();
});

test("a host whose camera cannot join is told why and can try again", async () => {
  serve();
  const call = new FakeRoomCall();
  call.failJoin = "The room is closed.";
  show(peopleDoc(), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  expect(await screen.findByText("The room is closed.")).toBeTruthy();
  call.failJoin = null;
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
});

/** A call whose microphones fail on request. */
class FailingCall extends FakeRoomCall {
  failMute: string | null = null;

  override async setMuted(muted: boolean) {
    if (this.failMute) throw new Error(this.failMute);
    await super.setMuted(muted);
  }

  override async muteParticipant(acsId: string) {
    if (this.failMute) throw new Error(this.failMute);
    await super.muteParticipant(acsId);
  }
}

test("a microphone that cannot be changed is explained", async () => {
  serve();
  const call = new FailingCall();
  show(peopleDoc({ invites: [joinedSam] }), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  call.failMute = "The microphone is busy.";
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(await screen.findByText("The microphone is busy.")).toBeTruthy();
});

test("a guest who cannot be muted is explained", async () => {
  serve();
  const call = new FailingCall();
  show(peopleDoc({ invites: [joinedSam] }), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  call.failMute = "Sam could not be muted.";
  fireEvent.click(screen.getByRole("button", { name: "Mute Sam" }));
  expect(await screen.findByText("Sam could not be muted.")).toBeTruthy();
});

test("a live mute that fails is explained", async () => {
  serve();
  const call = new FailingCall();
  const { rerender } = show(peopleDoc(), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  call.failMute = "The microphone is busy.";
  rerender(peopleDoc(), true);
  expect(await screen.findByText("The microphone is busy.")).toBeTruthy();
});

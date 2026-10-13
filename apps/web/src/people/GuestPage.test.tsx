import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { JoinOptions } from "../calls/RoomCall";
import type { Guest } from "../contracts";
import { callSeat, FakeEventSource, FakeEventSourceCtor, guestDoc } from "../test/fixtures";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { renderUi } from "../test/render";
import { GuestPage, guestBanner } from "./GuestPage";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function serve(answers: Record<string, () => Response | Promise<Response>> = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    sent.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${url}`];
    if (answer) return answer();
    return new Response(JSON.stringify(method === "GET" ? guestDoc() : callSeat()), { status: 200 });
  }));
  return sent;
}

function open(doc: Guest = guestDoc(), call = new FakeRoomCall()) {
  renderUi(<GuestPage secret="s3cret" eventSource={FakeEventSourceCtor} retryMs={10} newCall={() => call} />);
  act(() => {
    FakeEventSource.last.open();
    FakeEventSource.last.emitRaw(JSON.stringify(doc));
  });
  return call;
}

const send = (doc: Guest) => act(() => FakeEventSource.last.emitRaw(JSON.stringify(doc)));

async function join(call: FakeRoomCall) {
  await waitFor(() => expect(call.cameraOn).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
}

beforeEach(() => {
  FakeEventSource.instances = [];
});

test("the banner says where the guest is", () => {
  expect(guestBanner(guestDoc({ on_stage: true, broadcast_state: "live" }))).toBe("You're on stage — you're live");
  expect(guestBanner(guestDoc({ on_stage: true }))).toBe("You're on stage");
  expect(guestBanner(guestDoc({ muted_live: true, broadcast_state: "live" }))).toBe("You're backstage and muted while the broadcast is live");
  expect(guestBanner(guestDoc())).toBe("You're backstage");
});

test("the guest previews their camera, names themselves and joins the room", async () => {
  const sent = serve();
  const call = open();
  expect(FakeEventSource.last.url).toBe("/api/guest/s3cret/stream");
  expect(screen.getByText("Join “Derby day” as Speaker")).toBeTruthy();
  await waitFor(() => expect(call.cameraOn).toBe(true));
  expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Sam");
  fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Sam Lee" } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(sent.find((one) => one.method === "POST")).toMatchObject({ url: "/api/guest/s3cret/join", body: { name: "Sam Lee" } });
  expect(call.joined[0]).toMatchObject({ roomId: "room-1", token: "t1", name: "Sam Lee" });
  expect(call.muted).toBe(false);
  expect(await screen.findByText("You're backstage")).toBeTruthy();
});

test("while the broadcast is live a guest backstage is muted and cannot unmute", async () => {
  serve();
  const call = open();
  await join(call);
  send(guestDoc({ revision: 2, joined: true, broadcast_state: "live", muted_live: true }));
  await waitFor(() => expect(call.muted).toBe(true));
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
  send(guestDoc({ revision: 3, joined: true, broadcast_state: "live", on_stage: true }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByText("You're on stage — you're live")).toBeTruthy();
});

test("an unknown link says the invite is no longer valid", async () => {
  serve({ "GET /api/guest/s3cret": () => new Response(JSON.stringify({ detail: [{ loc: ["body", "invite"], msg: "This invite is no longer valid." }] }), { status: 404 }) });
  renderUi(<GuestPage secret="s3cret" eventSource={FakeEventSourceCtor} retryMs={10} newCall={() => new FakeRoomCall()} />);
  expect(await screen.findByText("This invite is no longer valid")).toBeTruthy();
});

test("a guest whose invite is revoked leaves the room", async () => {
  serve();
  const call = open();
  await join(call);
  send(guestDoc({ revision: 2, valid: false }));
  expect(await screen.findByText("This invite is no longer valid")).toBeTruthy();
  await waitFor(() => expect(call.left).toBeGreaterThan(0));
});

test("a co-host can open the studio in a new tab once they have joined, staying in the call", async () => {
  serve();
  const call = open(guestDoc({ role: "cohost", broadcast_id: "b1" }));
  await join(call);
  const link = screen.getByRole("link", { name: "Open studio" });
  expect(link.getAttribute("href")).toBe("/broadcasts/b1/studio");
  expect(link.getAttribute("target")).toBe("_blank");
});

test("a camera that cannot be used is explained and the guest can still join", async () => {
  serve();
  const call = new FakeRoomCall();
  call.failDevices = "Permission denied";
  open(guestDoc(), call);
  expect(await screen.findByText(/Your camera or microphone could not be used \(Permission denied\)/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
});

test("the others in the room are shown with their video", async () => {
  serve();
  const call = open();
  await join(call);
  act(() => {
    call.participants = [{ acsId: "8:fake:9", name: "Kim", video: true, speaking: false, muted: false }];
    call.emit();
  });
  expect(await screen.findByText("Kim")).toBeTruthy();
  expect(call.rendered).toContain("8:fake:9");
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

test("a join cut short by leaving the call is not shown as a problem", async () => {
  serve();
  const first = new StartingCall();
  const calls = [first, new FakeRoomCall()];
  renderUi(<GuestPage secret="s3cret" eventSource={FakeEventSourceCtor} retryMs={10} newCall={() => calls.shift()!} />);
  act(() => {
    FakeEventSource.last.open();
    FakeEventSource.last.emitRaw(JSON.stringify(guestDoc()));
  });
  await waitFor(() => expect(first.cameraOn).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(first.joined).toHaveLength(1));
  send(guestDoc({ revision: 2, service: "acs" }));
  await waitFor(() => expect(first.left).toBe(1));
  await waitFor(() => expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText("The call was left before it was joined.")).toBeNull();
});

test("a guest whose broadcast goes live while their join is pending joins muted", async () => {
  let answer: (response: Response) => void = () => {};
  const sent = serve({ "POST /api/guest/s3cret/join": () => new Promise<Response>((resolve) => { answer = resolve; }) });
  const call = open();
  await waitFor(() => expect(call.cameraOn).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(sent.some((one) => one.method === "POST")).toBe(true));
  send(guestDoc({ revision: 2, broadcast_state: "live", muted_live: true }));
  await act(async () => answer(new Response(JSON.stringify(callSeat()), { status: 200 })));
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

test("a guest backstage is muted again once their call connects during a live broadcast", async () => {
  serve();
  const call = new ConnectingCall();
  open(guestDoc(), call);
  await waitFor(() => expect(call.cameraOn).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  send(guestDoc({ revision: 2, broadcast_state: "live", muted_live: true }));
  act(() => call.connect(false));
  await waitFor(() => expect(call.muted).toBe(true));
  expect((screen.getByRole("button", { name: "Unmute" }) as HTMLButtonElement).disabled).toBe(true);
});

/** A call whose microphone or leaving fails on request. */
class FailingCall extends FakeRoomCall {
  failMute: string | null = null;
  failLeave = false;

  override async setMuted(muted: boolean) {
    if (this.failMute) throw new Error(this.failMute);
    await super.setMuted(muted);
  }

  override async leave() {
    await super.leave();
    if (this.failLeave) throw new Error("The call could not be left.");
  }
}

test("a microphone that cannot be changed is explained", async () => {
  serve();
  const call = new FailingCall();
  open(guestDoc(), call);
  await join(call);
  call.failMute = "The microphone is busy.";
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(await screen.findByText("The microphone is busy.")).toBeTruthy();
});

test("a live mute that fails is explained", async () => {
  serve();
  const call = new FailingCall();
  open(guestDoc(), call);
  await join(call);
  call.failMute = "The microphone is busy.";
  send(guestDoc({ revision: 2, joined: true, broadcast_state: "live", muted_live: true }));
  expect(await screen.findByText("The microphone is busy.")).toBeTruthy();
});

test("a call that cannot be left when the invite is revoked is not a problem", async () => {
  serve();
  const call = new FailingCall();
  call.failLeave = true;
  open(guestDoc(), call);
  await join(call);
  send(guestDoc({ revision: 2, valid: false }));
  expect(await screen.findByText("This invite is no longer valid")).toBeTruthy();
  await waitFor(() => expect(call.left).toBe(1));
});

import { FluentProvider, webLightTheme } from "@fluentui/react-components";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useHostCall } from "../calls/useHostCall";
import type { People } from "../contracts";
import { HOST, SETUP } from "../people/PeoplePanel";
import { callSeat, invitation, peopleDoc } from "../test/fixtures";
import { FakeRoomCall } from "../test/FakeRoomCall";
import { Backstage } from "./Backstage";

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

function serve(answer: People = peopleDoc()) {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    sent.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/seat")) return new Response(JSON.stringify(callSeat({ acs_id: "8:fake:host" })), { status: 200 });
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return sent;
}

interface HarnessProps {
  people: People | null;
  live: boolean;
  call: FakeRoomCall;
  onRun(request: () => Promise<People>): Promise<boolean>;
  onInvite(): void;
}

function Harness({ people, live, call, onRun, onInvite }: HarnessProps) {
  const mutedLive = live && !(people?.stage.some((person) => person.id === HOST) ?? false);
  const host = useHostCall({ broadcastId: "b1", people, mutedLive, newCall: () => call });
  return <Backstage broadcastId="b1" people={people} live={live} host={host} onRun={onRun} onInvite={onInvite} />;
}

function show(people: People | null, { live = false, call = new FakeRoomCall() } = {}) {
  const onRun = vi.fn(async (request: () => Promise<People>) => {
    await request();
    return true;
  });
  const onInvite = vi.fn();
  const ui = (doc: People | null) => (
    <FluentProvider theme={webLightTheme}>
      <Harness people={doc} live={live} call={call} onRun={onRun} onInvite={onInvite} />
    </FluentProvider>
  );
  const view = render(ui(people));
  return { call, onRun, onInvite, rerender: (doc: People | null) => view.rerender(ui(doc)) };
}

const joinedSam = invitation({ joined_name: "Sam", acs_id: "8:fake:2", present: true });
const backstage = () => within(screen.getByRole("region", { name: "Backstage" }));

test("with no calling service backstage says how to set one up", () => {
  serve();
  show(peopleDoc({ service: null }));
  expect(backstage().getByText(SETUP)).toBeTruthy();
});

test("the host joins with their camera and can mute themselves", async () => {
  const sent = serve();
  const { call } = show(peopleDoc());
  fireEvent.click(backstage().getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  expect(sent.find((one) => one.url.endsWith("/host/seat"))).toMatchObject({ method: "POST", body: { name: "Host" } });
  fireEvent.click(await screen.findByRole("button", { name: "Mute" }));
  await waitFor(() => expect(call.muted).toBe(true));
  fireEvent.click(await screen.findByRole("button", { name: "Unmute" }));
  await waitFor(() => expect(call.muted).toBe(false));
});

test("the host in the room puts themselves on stage", async () => {
  const sent = serve();
  const { call, onRun, rerender } = show(peopleDoc());
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  rerender(peopleDoc({ host_acs_id: "8:fake:host" }));
  fireEvent.click(screen.getByRole("button", { name: "Add me to stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/stage", method: "PUT", body: { people: ["host"] } }));
  expect(onRun).toHaveBeenCalledTimes(1);
});

test("joined speakers go on and off the stage, and members stay backstage", async () => {
  const sent = serve();
  const mia = invitation({ id: "i2", role: "member", name: "Mia", link: "/guest/def", acs_id: "8:fake:3", present: true });
  const { rerender } = show(peopleDoc({ invites: [joinedSam, mia] }));
  expect(screen.getByText("Backstage only")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add Mia to stage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add Sam to stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ url: "/api/broadcasts/b1/people/stage", method: "PUT", body: { people: ["i1"] } }));
  rerender(peopleDoc({ invites: [joinedSam], stage: [{ id: "i1", name: "Sam", acs_id: "8:fake:2", present: true }] }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Sam from stage" }));
  await waitFor(() => expect(sent.at(-1)).toMatchObject({ body: { people: [] } }));
});

test("each guest shows whether they are here yet", () => {
  serve();
  show(peopleDoc({ invites: [joinedSam, invitation({ id: "i2", name: "Jo", link: "/guest/def" })] }));
  expect(backstage().getByText("Present")).toBeTruthy();
  expect(backstage().getByText("Not joined yet")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add Jo to stage" }) as HTMLButtonElement).disabled).toBe(true);
});

test("while a stage change is on its way a second click sends nothing", async () => {
  const stageCalls: string[] = [];
  let answer: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    stageCalls.push(url);
    return new Promise<Response>((resolve) => { answer = resolve; });
  }));
  const joinedJo = invitation({ id: "i2", name: "Jo", link: "/guest/def", joined_name: "Jo", acs_id: "8:fake:3", present: true });
  show(peopleDoc({ invites: [joinedSam, joinedJo] }));
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  fireEvent.click(button("Add Sam to stage"));
  await waitFor(() => expect(button("Add Sam to stage").disabled).toBe(true));
  fireEvent.click(button("Add Sam to stage"));
  fireEvent.click(button("Add Jo to stage"));
  expect(stageCalls).toHaveLength(1);
  await act(async () => answer(new Response(JSON.stringify(peopleDoc()), { status: 200 })));
  await waitFor(() => expect(button("Add Jo to stage").disabled).toBe(false));
});

test("the host can mute a guest who is in the room", async () => {
  serve();
  const { call } = show(peopleDoc({ invites: [joinedSam] }));
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  await waitFor(() => expect(call.joined).toHaveLength(1));
  fireEvent.click(await screen.findByRole("button", { name: "Mute Sam" }));
  await waitFor(() => expect(call.mutedOthers).toEqual(["8:fake:2"]));
});

test("a host whose camera cannot join is told why in their tile", async () => {
  serve();
  const call = new FakeRoomCall();
  call.failJoin = "The room is closed.";
  show(peopleDoc(), { call });
  fireEvent.click(screen.getByRole("button", { name: "Join with camera" }));
  expect(await backstage().findByText("The room is closed.")).toBeTruthy();
});

test("the invite tile opens the guests tool", () => {
  serve();
  const { onInvite } = show(peopleDoc());
  fireEvent.click(screen.getByRole("button", { name: "Invite a guest" }));
  expect(onInvite).toHaveBeenCalledTimes(1);
});

import { AcsRoomCall } from "./acs";
import type { JoinOptions } from "./RoomCall";

const sdk = vi.hoisted(() => {
  type Listener = (args?: unknown) => void;

  class Emitter {
    private readonly listeners = new Map<string, Set<Listener>>();
    on(event: string, listener: Listener) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event)!.add(listener);
    }
    off(event: string, listener: Listener) {
      this.listeners.get(event)?.delete(listener);
    }
    fire(event: string, args?: unknown) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(args);
    }
  }

  class FakeCall extends Emitter {
    state = "Connecting";
    isLocalVideoStarted = false;
    callEndReason: { code: number; subCode?: number } | undefined = undefined;
    remoteParticipants: unknown[] = [];
    remoteAudioStreams: unknown[] = [];
    mute = vi.fn(async () => this.mutedBy(true));
    unmute = vi.fn(async () => this.mutedBy(false));
    hangUp = vi.fn(async () => this.reach("Disconnected"));
    constructor(public isMuted: boolean) {
      super();
    }
    reach(state: string, code?: number) {
      this.state = state;
      if (code !== undefined) this.callEndReason = { code };
      this.fire("stateChanged");
    }
    mutedBy(muted: boolean) {
      this.isMuted = muted;
      this.fire("isMutedChanged");
    }
  }

  const state = {
    log: [] as string[],
    agents: [] as FakeAgent[],
    calls: [] as FakeCall[],
    renderers: [] as FakeRenderer[],
    joinThrows: null as Error | null,
    gates: [] as Promise<void>[],
    asked: 0,
    Emitter,
  };

  class FakeAgent {
    dispose = vi.fn(async () => {
      state.log.push(`dispose ${this.n}`);
    });
    join = vi.fn((_locator: unknown, options?: { audioOptions?: { muted?: boolean } }) => {
      if (state.joinThrows) throw state.joinThrows;
      const call = new FakeCall(Boolean(options?.audioOptions?.muted));
      state.calls.push(call);
      return call;
    });
    constructor(readonly n: number) {}
  }

  class FakeClient {
    createCallAgent = vi.fn(async () => {
      state.asked += 1;
      const gate = state.gates.shift();
      if (gate) await gate;
      const agent = new FakeAgent(state.agents.length + 1);
      state.agents.push(agent);
      state.log.push(`create ${agent.n}`);
      return agent;
    });
    getDeviceManager = vi.fn(async () => ({}));
  }

  class FakeRenderer {
    dispose = vi.fn();
    createView = vi.fn(async () => {
      throw new Error("The stream went away.");
    });
    constructor() {
      state.renderers.push(this);
    }
  }

  return { state, FakeClient, FakeRenderer };
});

vi.mock("@azure/communication-calling", () => ({
  CallClient: sdk.FakeClient,
  VideoStreamRenderer: sdk.FakeRenderer,
  LocalVideoStream: class {},
}));
vi.mock("@azure/communication-common", () => ({
  AzureCommunicationTokenCredential: class {},
}));

beforeEach(() => {
  sdk.state.log = [];
  sdk.state.agents = [];
  sdk.state.calls = [];
  sdk.state.renderers = [];
  sdk.state.joinThrows = null;
  sdk.state.gates = [];
  sdk.state.asked = 0;
});

const options: JoinOptions = { roomId: "room-1", token: "t1", name: "Host", refresh: async () => "t2" };
const LEFT = "The call was left before it was joined.";

function holdNextAgent() {
  let release!: () => void;
  sdk.state.gates.push(new Promise<void>((resolve) => {
    release = resolve;
  }));
  return () => release();
}

async function joinAndConnect(call: AcsRoomCall) {
  const before = sdk.state.calls.length;
  const joining = call.join(options);
  await vi.waitFor(() => expect(sdk.state.calls).toHaveLength(before + 1));
  const remote = sdk.state.calls[before];
  remote.reach("Connected");
  await joining;
  return remote;
}

test("a mute from someone else shows on the call", async () => {
  const call = new AcsRoomCall();
  const remote = await joinAndConnect(call);
  await call.setMuted(false);
  expect(call.muted).toBe(false);
  const changed = vi.fn();
  call.onChange(changed);
  remote.mutedBy(true);
  expect(call.muted).toBe(true);
  expect(changed).toHaveBeenCalled();
});

test("an unmute that fails leaves the call muted", async () => {
  const call = new AcsRoomCall();
  const remote = await joinAndConnect(call);
  remote.unmute.mockRejectedValueOnce(new Error("No microphone."));
  await expect(call.setMuted(false)).rejects.toThrow("No microphone.");
  expect(call.muted).toBe(true);
});

test("a join that is dropped gives up its agent, so the next join can make one", async () => {
  const call = new AcsRoomCall();
  const first = call.join(options);
  await vi.waitFor(() => expect(sdk.state.calls).toHaveLength(1));
  sdk.state.calls[0].reach("Disconnected", 403);
  await expect(first).rejects.toThrow("The call ended (code 403).");
  expect([call.state, call.problem]).toEqual(["dropped", "The call ended (code 403)."]);
  expect(sdk.state.agents[0].dispose).toHaveBeenCalled();
  await joinAndConnect(call);
  expect([call.state, call.problem]).toEqual(["joined", null]);
  expect(sdk.state.log).toEqual(["create 1", "dispose 1", "create 2"]);
});

test("a join the service refuses at once is dropped and gives up its agent", async () => {
  sdk.state.joinThrows = new Error("Bad room.");
  const call = new AcsRoomCall();
  await expect(call.join(options)).rejects.toThrow("Bad room.");
  expect([call.state, call.problem]).toEqual(["dropped", "The call could not be joined."]);
  expect(sdk.state.agents[0].dispose).toHaveBeenCalled();
});

test("leaving while the agent is still being made gives it up without joining", async () => {
  const release = holdNextAgent();
  const call = new AcsRoomCall();
  const joining = call.join(options);
  await vi.waitFor(() => expect(sdk.state.asked).toBe(1));
  await call.leave();
  const given = expect(joining).rejects.toThrow(LEFT);
  release();
  await vi.waitFor(() => expect(sdk.state.agents[0]?.dispose).toHaveBeenCalled());
  await given;
  expect(sdk.state.agents[0].join).not.toHaveBeenCalled();
  expect(call.state).toBe("idle");
});

test("join, leave and join again leave one agent alive, joined", async () => {
  const release = holdNextAgent();
  const call = new AcsRoomCall();
  const first = call.join(options);
  await vi.waitFor(() => expect(sdk.state.asked).toBe(1));
  const leaving = call.leave();
  const second = call.join(options);
  const given = expect(first).rejects.toThrow(LEFT);
  release();
  await vi.waitFor(() => expect(sdk.state.agents[0]?.dispose).toHaveBeenCalled());
  await given;
  await leaving;
  await vi.waitFor(() => expect(sdk.state.calls).toHaveLength(1));
  sdk.state.calls[0].reach("Connected");
  await second;
  expect(call.state).toBe("joined");
  expect(sdk.state.agents.filter((agent) => agent.dispose.mock.calls.length === 0)).toHaveLength(1);
  expect(sdk.state.agents[0].dispose).toHaveBeenCalled();
  expect(sdk.state.agents[0].join).not.toHaveBeenCalled();
  expect(sdk.state.log).toEqual(["create 1", "dispose 1", "create 2"]);
});

test("a video that cannot be shown lets go of its renderer", async () => {
  const call = new AcsRoomCall();
  const remote = await joinAndConnect(call);
  const camera = Object.assign(new sdk.state.Emitter(), { mediaStreamType: "Video", isAvailable: true });
  const person = Object.assign(new sdk.state.Emitter(), {
    identifier: { kind: "communicationUser", communicationUserId: "8:a" },
    displayName: "Sam", isSpeaking: false, isMuted: false, videoStreams: [camera],
  });
  remote.remoteParticipants.push(person);
  remote.fire("remoteParticipantsUpdated", { added: [person], removed: [] });
  const box = document.createElement("div");
  const stop = call.renderVideo("8:a", box);
  await vi.waitFor(() => expect(sdk.state.renderers[0]?.dispose).toHaveBeenCalled());
  stop();
});

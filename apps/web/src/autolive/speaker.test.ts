import { AZURE_RETRY_MS, pickVoice, sayingMs, Speaker, type SpeakerDeps, type Spoken } from "./speaker";

const voice = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;
const VOICES = [
  voice("Google UK English Male", "en-GB"),
  voice("Microsoft Ryan Online (Natural) - English (United Kingdom)", "en-GB"),
  voice("Microsoft Sonia Online (Natural) - English (United Kingdom)", "en-GB"),
  voice("Microsoft Aria Online (Natural) - English (United States)", "en-US"),
];

test("the browser voice nearest the Azure one is the same speaker, then a natural voice in the language", () => {
  expect(pickVoice(VOICES, "en-GB-RyanNeural")?.name).toContain("Ryan");
  expect(pickVoice(VOICES, "en-GB-SoniaNeural")?.name).toContain("Sonia");
  expect(pickVoice(VOICES, "en-GB-ThomasNeural")?.name).toContain("Online (Natural)");
  expect(pickVoice(VOICES, "en-AU-WilliamNeural")?.name).toContain("Ryan");
  expect(pickVoice([voice("Google UK English Male", "en-GB")], "en-GB-RyanNeural")?.name).toBe("Google UK English Male");
  expect(pickVoice(VOICES, "fr-FR-HenriNeural")).toBeNull();
});

test("a line is given time to be said, more when spoken slowly", () => {
  expect(sayingMs("x".repeat(130), 1)).toBe(15000);
  expect(sayingMs("x".repeat(130), 0.5)).toBeGreaterThan(sayingMs("x".repeat(130), 1));
});

class FakeSynth {
  spoken: string[] = [];
  ends = true;
  cancelled = 0;
  getVoices = () => VOICES;
  speak = (utterance: FakeUtterance) => {
    this.spoken.push(utterance.text);
    if (this.ends) queueMicrotask(() => utterance.onend?.());
  };
  cancel = () => {
    this.cancelled += 1;
  };
}

class FakeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function audio() {
  const played: string[] = [];
  const connected: AudioNode[] = [];
  const output = {} as AudioNode;
  const context = {
    decodeAudioData: async (data: ArrayBuffer) => ({ duration: 0.01, label: new TextDecoder().decode(data) }),
    createBufferSource: () => {
      const source = {
        buffer: null as { label: string } | null,
        onended: null as (() => void) | null,
        connect: (node: AudioNode) => connected.push(node),
        disconnect: () => {},
        start: () => {
          played.push(source.buffer!.label);
          queueMicrotask(() => source.onended?.());
        },
        stop: () => {},
      };
      return source;
    },
  } as unknown as BaseAudioContext;
  return { played, connected, output, context };
}

function rig(over: Partial<SpeakerDeps> = {}) {
  const synth = new FakeSynth();
  const sound = audio();
  const asked: string[] = [];
  let clock = 0;
  const states: Spoken[] = [];
  const deps: SpeakerDeps = {
    fetchSpeech: async (text) => {
      asked.push(text);
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    },
    audio: () => ({ context: sound.context, outputs: [sound.output] }),
    synth: () => synth as unknown as SpeechSynthesis,
    Utterance: FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    now: () => clock,
    ...over,
  };
  const speaker = new Speaker(deps, (state) => states.push(state));
  return { speaker, synth, sound, asked, states, tick: (ms: number) => (clock += ms) };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Azure's audio plays into the outputs, and the captions follow it", async () => {
  const { speaker, sound, synth, states } = rig();
  speaker.say("  Over to   the Tactical Analyst. ");
  await vi.waitFor(() => expect(sound.played).toEqual(["Over to the Tactical Analyst."]));
  await settled();
  expect(sound.connected).toEqual([sound.output]);
  expect(synth.spoken).toEqual([]);
  expect(states.map((state) => [state.text, state.engine])).toEqual([["Over to the Tactical Analyst.", "azure"], [null, null]]);
});

test("when Azure fails the browser speaks, and Azure is not asked again for a while", async () => {
  const failing = vi.fn(async () => {
    throw new Error("Azure Speech refused the key.");
  });
  const { speaker, synth, states, tick } = rig({ fetchSpeech: failing });
  speaker.say("First line.");
  await vi.waitFor(() => expect(synth.spoken).toEqual(["First line."]));
  await settled();
  expect(states.at(-1)?.problem).toBe("Azure Speech refused the key.");
  speaker.say("Second line.");
  await vi.waitFor(() => expect(synth.spoken).toHaveLength(2));
  expect(failing).toHaveBeenCalledTimes(1);
  await settled();
  tick(AZURE_RETRY_MS);
  speaker.say("Third line.");
  await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
});

test("without Azure Speech set up the browser speaks in the nearest voice at the chosen rate", async () => {
  const { speaker, synth, asked } = rig();
  speaker.azure = false;
  speaker.voice = "en-GB-SoniaNeural";
  speaker.rate = 1.2;
  const said: FakeUtterance[] = [];
  synth.speak = (utterance) => {
    said.push(utterance);
    queueMicrotask(() => utterance.onend?.());
  };
  speaker.say("Hello.");
  await vi.waitFor(() => expect(said).toHaveLength(1));
  expect(asked).toEqual([]);
  expect(said[0].voice?.name).toContain("Sonia");
  expect([said[0].lang, said[0].rate]).toEqual(["en-GB", 1.2]);
});

test("new commentary drops what is waiting; narration waits only while there is room", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asked: string[] = [];
  const { speaker, sound } = rig({
    fetchSpeech: async (text) => {
      asked.push(text);
      if (asked.length === 1) await held;
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    },
  });
  speaker.say("On air now.");
  await vi.waitFor(() => expect(asked).toHaveLength(1));
  ["One.", "Two.", "Three.", "Four."].forEach((text) => speaker.say(text, "narration"));
  speaker.say("A new screen.");
  speaker.say("Goal!", "narration");
  release();
  await vi.waitFor(() => expect(sound.played).toEqual(["On air now.", "A new screen.", "Goal!"]));
});

test("a browser voice that never finishes is moved on from, and stop silences it", async () => {
  vi.useFakeTimers();
  try {
    const { speaker, synth } = rig();
    speaker.azure = false;
    synth.ends = false;
    speaker.say("Stuck line.");
    speaker.say("Waiting line.", "narration");
    await vi.advanceTimersByTimeAsync(0);
    expect(synth.spoken).toEqual(["Stuck line."]);
    await vi.advanceTimersByTimeAsync(sayingMs("Stuck line.", 1));
    expect(synth.spoken).toEqual(["Stuck line.", "Waiting line."]);
    speaker.stop();
    expect(synth.cancelled).toBeGreaterThanOrEqual(2);
  } finally {
    vi.useRealTimers();
  }
});

import { useEffect, useMemo, useRef, useState } from "react";
import type { AutoLive } from "../contracts";
import { programAudio } from "../studio/capture";
import { fetchSpeech } from "./api";
import { Speaker, type SpeakerDeps, type Spoken } from "./speaker";

/** A commentary line older than this when the page opens is not said: it belongs to an earlier moment. */
const STALE_S = 30;

export interface VoiceOptions {
  /** Whether to speak at all. */
  on: boolean;
  /** Put the voice on the stream's audio mix (the output page). */
  stream: boolean;
  /** Play the voice through this computer's speakers (the control page). */
  monitor: boolean;
  /** Stand-ins for the browser, for tests. */
  deps?: Partial<SpeakerDeps>;
}

function browserDeps(stream: boolean, monitor: boolean): SpeakerDeps {
  return {
    fetchSpeech,
    audio: () => {
      try {
        const program = programAudio();
        const outputs: AudioNode[] = [];
        if (stream) outputs.push(program.input);
        if (monitor) outputs.push(program.context.destination);
        return outputs.length > 0 ? { context: program.context, outputs } : null;
      } catch {
        return null;
      }
    },
    synth: () => (typeof window !== "undefined" ? window.speechSynthesis : undefined),
    Utterance: typeof window !== "undefined" ? window.SpeechSynthesisUtterance : undefined,
    now: () => Date.now(),
  };
}

const QUIET: Spoken = { text: null, engine: null, problem: null };

/** Speaks auto live's commentary, and the match narration when that is on, as they arrive. */
export function useAutoLiveVoice(doc: AutoLive | null, narrative: { id: string; text: string } | null, options: VoiceOptions) {
  const { on, stream, monitor, deps: injected } = options;
  const deps = useMemo(() => ({ ...browserDeps(stream, monitor), ...injected }), [stream, monitor, injected]);
  const [spoken, setSpoken] = useState<Spoken>(QUIET);
  const [speaker, setSpeaker] = useState<Speaker | null>(null);

  useEffect(() => {
    const made = new Speaker(deps, setSpoken);
    setSpeaker(made);
    return () => {
      made.dispose();
      setSpoken(QUIET);
    };
  }, [deps]);

  const voice = doc?.settings.voice;
  const rate = doc?.settings.rate;
  const azure = doc?.speech.azure;
  useEffect(() => {
    if (!speaker) return;
    if (voice) speaker.voice = voice;
    if (rate) speaker.rate = rate;
    speaker.azure = azure !== false;
  }, [speaker, voice, rate, azure]);

  useEffect(() => {
    if (!on) speaker?.stop();
  }, [on, speaker]);

  const talking = Boolean(doc?.settings.enabled && doc.settings.commentary);
  const commentary = doc?.commentary ?? null;
  const said = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!speaker || !doc) return;
    const first = said.current === undefined;
    const fresh = commentary !== null && commentary.id !== said.current;
    said.current = commentary?.id ?? null;
    if (!on || !talking || !commentary || !fresh) return;
    if (first && doc.server_time - commentary.at > STALE_S) return;
    speaker.say(commentary.text, "commentary");
    // Only a new line is said; the rest of the document changing must not repeat it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker, commentary?.id, on, talking]);

  const narrating = Boolean(doc?.settings.enabled && doc.settings.narration);
  const read = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!speaker) return;
    const first = read.current === undefined;
    const fresh = narrative !== null && narrative.id !== read.current;
    read.current = narrative?.id ?? null;
    if (first || !fresh || !on || !narrating || !narrative) return;
    speaker.say(narrative.text, "narration");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker, narrative?.id, on, narrating]);

  return { spoken, speaker };
}

/**
 * Auto live's voice. Each line is spoken by Azure Speech when it can, played through Web Audio so the
 * stream carries it; otherwise by the browser's own voice (Edge's natural voices are the closest match),
 * which the stream cannot record. One line at a time; a new commentary line drops whatever is waiting.
 */

export type Engine = "azure" | "browser";
export type LineKind = "commentary" | "narration";

export interface Spoken {
  /** What is being said now, for the captions. */
  text: string | null;
  engine: Engine | null;
  /** Why Azure is not speaking, when it is not. */
  problem: string | null;
}

export interface SpeakerAudio {
  context: BaseAudioContext;
  /** Where the voice plays: the stream's mix, and the speakers when monitoring. */
  outputs: AudioNode[];
}

export interface SpeakerDeps {
  fetchSpeech(text: string, signal: AbortSignal): Promise<ArrayBuffer>;
  /** Null where Web Audio is unavailable. */
  audio(): SpeakerAudio | null;
  /** Undefined where the browser has no speech synthesis. */
  synth(): SpeechSynthesis | undefined;
  Utterance?: typeof SpeechSynthesisUtterance;
  now(): number;
}

interface Line {
  text: string;
  kind: LineKind;
}

/** After Azure fails, the browser's voice speaks for this long before Azure is tried again. */
export const AZURE_RETRY_MS = 60_000;
const MAX_WAITING = 3;

/** How long a line should take to say, with room to spare: the guard when an end event never comes. */
export function sayingMs(text: string, rate: number): number {
  return Math.round((text.length / (13 * Math.max(rate, 0.5))) * 1000) + 5000;
}

/** The browser voice nearest an Azure one: the same speaker on Edge, else a natural voice in the language, else any. */
export function pickVoice(voices: readonly SpeechSynthesisVoice[], azureVoice: string): SpeechSynthesisVoice | null {
  const parts = azureVoice.split("-");
  const lang = parts.slice(0, 2).join("-").toLowerCase();
  const language = parts[0]?.toLowerCase() ?? "en";
  const speaker = (parts[2] ?? "").replace(/(Multilingual)?Neural$/i, "").toLowerCase();
  const langOf = (voice: SpeechSynthesisVoice) => voice.lang.replace("_", "-").toLowerCase();
  const natural = (voice: SpeechSynthesisVoice) => /natural|online|neural/i.test(voice.name);
  const inLang = voices.filter((voice) => langOf(voice) === lang);
  const inLanguage = voices.filter((voice) => langOf(voice).split("-")[0] === language);
  return (
    (speaker && inLang.find((voice) => voice.name.toLowerCase().includes(speaker) && natural(voice))) ||
    inLang.find(natural) ||
    inLanguage.find(natural) ||
    inLang[0] ||
    inLanguage[0] ||
    null
  );
}

export class Speaker {
  voice = "en-GB-RyanNeural";
  rate = 1;
  /** Whether Azure Speech is set up on the server. */
  azure = true;
  private waiting: Line[] = [];
  private busy = false;
  private abort: AbortController | null = null;
  private stopNow: (() => void) | null = null;
  private azureDownUntil = 0;
  private problem: string | null = null;
  private disposed = false;

  constructor(
    private readonly deps: SpeakerDeps,
    private readonly onState: (spoken: Spoken) => void = () => {},
  ) {}

  /** Queue a line. Commentary replaces anything waiting; narration waits its turn, if there is room. */
  say(text: string, kind: LineKind = "commentary"): void {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!clean || this.disposed) return;
    if (kind === "commentary") this.waiting = [];
    else if (this.waiting.length >= MAX_WAITING) return;
    this.waiting.push({ text: clean, kind });
    void this.drain();
  }

  /** Stop speaking and forget what is waiting. */
  stop(): void {
    this.waiting = [];
    this.abort?.abort();
    this.stopNow?.();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private emit(text: string | null, engine: Engine | null) {
    if (!this.disposed) this.onState({ text, engine, problem: this.problem });
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.waiting.length > 0 && !this.disposed) {
        const line = this.waiting.shift()!;
        await this.speak(line);
      }
    } finally {
      this.busy = false;
      this.emit(null, null);
    }
  }

  private async speak(line: Line): Promise<void> {
    if (this.azure && this.deps.now() >= this.azureDownUntil) {
      try {
        await this.speakAzure(line);
        this.problem = null;
        return;
      } catch (problem) {
        if ((problem as Error).name === "AbortError") return;
        this.problem = (problem as Error).message || "Azure Speech failed.";
        this.azureDownUntil = this.deps.now() + AZURE_RETRY_MS;
      }
    }
    await this.speakBrowser(line);
  }

  private async speakAzure(line: Line): Promise<void> {
    const audio = this.deps.audio();
    if (!audio) throw new Error("This browser cannot play Azure Speech.");
    const abort = new AbortController();
    this.abort = abort;
    try {
      const data = await this.deps.fetchSpeech(line.text, abort.signal);
      const buffer = await audio.context.decodeAudioData(data);
      if (abort.signal.aborted) return;
      const source = audio.context.createBufferSource();
      source.buffer = buffer;
      audio.outputs.forEach((output) => source.connect(output));
      this.emit(line.text, "azure");
      await new Promise<void>((resolve) => {
        // A suspended context never ends the sound: the guard moves on after its length.
        const guard = setTimeout(done, buffer.duration * 1000 + 2000);
        function done() {
          clearTimeout(guard);
          resolve();
        }
        source.onended = done;
        this.stopNow = () => {
          try {
            source.stop();
          } catch {
            // Not started yet.
          }
          done();
        };
        source.start();
      });
      source.disconnect();
    } finally {
      this.abort = null;
      this.stopNow = null;
    }
  }

  private async speakBrowser(line: Line): Promise<void> {
    const synth = this.deps.synth();
    const Utterance = this.deps.Utterance;
    if (!synth || !Utterance) {
      // Nothing can say it: show it for as long as it would take, so the captions keep their pace.
      this.emit(line.text, null);
      await new Promise<void>((resolve) => {
        const guard = setTimeout(resolve, sayingMs(line.text, this.rate));
        this.stopNow = () => {
          clearTimeout(guard);
          resolve();
        };
      });
      this.stopNow = null;
      return;
    }
    const utterance = new Utterance(line.text);
    const voice = pickVoice(synth.getVoices(), this.voice);
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? this.voice.split("-").slice(0, 2).join("-");
    utterance.rate = this.rate;
    this.emit(line.text, "browser");
    await new Promise<void>((resolve) => {
      // Some browsers never fire `end` (or stop long lines part way): the guard moves on.
      const guard = setTimeout(() => {
        synth.cancel();
        done();
      }, sayingMs(line.text, this.rate));
      function done() {
        clearTimeout(guard);
        resolve();
      }
      utterance.onend = done;
      utterance.onerror = done;
      this.stopNow = () => {
        synth.cancel();
        done();
      };
      synth.speak(utterance);
    });
    this.stopNow = null;
  }
}

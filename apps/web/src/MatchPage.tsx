import { App } from "./App";
import type { Output } from "./contracts";
import { OUTPUT_STREAM } from "./output/api";
import { AppNav } from "./shell/AppNav";
import { useLiveDocument } from "./stream/useLiveDocument";
import { useNow } from "./studio/useStudio";

/** The match data behind the stream, under the streamer's navigation: /match. */
export function MatchPage() {
  const { doc: output, offset } = useLiveDocument<Output>(OUTPUT_STREAM);
  const now = useNow() + offset;
  return (
    <>
      <AppNav current="match" output={output} now={now} />
      <App />
    </>
  );
}

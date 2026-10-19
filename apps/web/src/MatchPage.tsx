import { memo } from "react";
import { App } from "./App";
import type { Output } from "./contracts";
import { OUTPUT_STREAM } from "./output/api";
import { AppNav } from "./shell/AppNav";
import { useCanUseStudio } from "./shell/viewer";
import { useLiveDocument } from "./stream/useLiveDocument";
import { useNow } from "./studio/useStudio";

// The navigation's clock ticks four times a second; the match page below it must not be drawn again each time.
const Page = memo(App);

/** The match data behind the stream, under the streamer's navigation: /match. */
export function MatchPage() {
  // Only the studio's users may follow the output; a viewer is not shown it.
  const { doc: output, offset } = useLiveDocument<Output>(useCanUseStudio() ? OUTPUT_STREAM : null);
  const now = useNow() + offset;
  return (
    <>
      <AppNav current="match" output={output} now={now} />
      <Page />
    </>
  );
}

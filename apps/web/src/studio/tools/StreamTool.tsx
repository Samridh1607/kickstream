import type { ComponentProps } from "react";
import { OutputTab } from "../../output/OutputTab";

/** Quality, destinations, going live and recordings: the output controls, as they are. */
export function StreamTool(props: ComponentProps<typeof OutputTab>) {
  return <OutputTab {...props} />;
}

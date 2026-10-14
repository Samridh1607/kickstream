import type { ComponentProps } from "react";
import { FanPanel } from "../../fans/FanPanel";

export function CommentsTool({ fans, onRun }: ComponentProps<typeof FanPanel>) {
  return <FanPanel fans={fans} onRun={onRun} />;
}

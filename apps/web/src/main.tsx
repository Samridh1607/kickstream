import { FluentProvider } from "@fluentui/react-components";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BroadcastPage } from "./broadcasts/BroadcastPage";
import { StudioEntry } from "./broadcasts/StudioEntry";
import { HomePage } from "./home/HomePage";
import { MatchPage } from "./MatchPage";
import { isOutputView, ProgramPage } from "./studio/ProgramPage";
import { StudioPage } from "./studio/StudioPage";
import { useAppTheme } from "./theme";

/**
 * The pages: Home lists the broadcasts, each broadcast has its page and its studio, and the studio's clean output
 * and the match data stand beside them.
 */
function Page() {
  const path = window.location.pathname.replace(/\/+$/, "");
  const broadcast = /^\/broadcasts\/([^/]+)(\/studio)?$/.exec(path);
  if (broadcast) {
    const broadcastId = decodeURIComponent(broadcast[1]);
    return broadcast[2] ? <StudioPage broadcastId={broadcastId} /> : <BroadcastPage broadcastId={broadcastId} />;
  }
  if (path === "/studio") return isOutputView(window.location.search) ? <ProgramPage /> : <StudioEntry />;
  if (path === "/match") return <MatchPage />;
  return <HomePage />;
}

function Root() {
  return (
    <FluentProvider theme={useAppTheme()} style={{ minHeight: "100%" }}>
      <Page />
    </FluentProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

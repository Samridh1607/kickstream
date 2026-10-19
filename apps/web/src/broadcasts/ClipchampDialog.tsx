import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, makeStyles, MessageBar, MessageBarBody,
  Spinner, Text, tokens,
} from "@fluentui/react-components";
import { ArrowUploadRegular, DismissRegular, OpenRegular } from "@fluentui/react-icons";
import { useRef, useState } from "react";
import type { Reel } from "../contracts";
import { addEditedReel, removeEditedReel, reelUrl } from "./api";
import { type ClipchampDeps, megabytes, openInClipchamp, reelFileName } from "./clipchamp";

const useStyles = makeStyles({
  steps: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL, margin: 0, paddingLeft: tokens.spacingHorizontalXL },
  step: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS, alignItems: "flex-start" },
  muted: { color: tokens.colorNeutralForeground3 },
  file: { fontWeight: tokens.fontWeightSemibold },
  remove: { whiteSpace: "nowrap" },
  hidden: { display: "none" },
});

interface Props {
  broadcastId: string;
  reel: Reel;
  open: boolean;
  onClose(): void;
  /** Tests stand in for saving the file and opening the tab. */
  clipchamp?: ClipchampDeps;
}

/** The round trip to Clipchamp: take the reel there, edit it, and bring the exported video back. */
export function ClipchampDialog({ broadcastId, reel, open, onClose, clipchamp }: Props) {
  const styles = useStyles();
  const picker = useRef<HTMLInputElement>(null);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState<"adding" | "removing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const fileName = reelFileName(reel.title);

  const add = async (file: File | undefined) => {
    if (!file) return;
    setBusy("adding");
    setProblem(null);
    try {
      await addEditedReel(broadcastId, reel.id, file);
      setAdded(true);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The edited video could not be added.");
    } finally {
      setBusy(null);
      if (picker.current) picker.current.value = "";
    }
  };
  const remove = async () => {
    setBusy("removing");
    setProblem(null);
    try {
      await removeEditedReel(broadcastId, reel.id);
      setAdded(false);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : "The edited video could not be removed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface aria-label={`Edit "${reel.title}" in Clipchamp`}>
        <DialogBody>
          <DialogTitle action={<Button appearance="subtle" aria-label="Close" icon={<DismissRegular />} onClick={onClose} />}>
            Edit in Clipchamp
          </DialogTitle>
          <DialogContent>
            <ol className={styles.steps}>
              <li className={styles.step}>
                <Text weight="semibold">Take the reel to Clipchamp</Text>
                <Text size={200} className={styles.muted}>
                  Saves <span className={styles.file}>{fileName}</span> to your downloads and opens Clipchamp in a new tab.
                </Text>
                <Button appearance="primary" icon={<OpenRegular />}
                  onClick={() => {
                    setProblem(null);
                    openInClipchamp(reelUrl(broadcastId, reel.id), fileName, clipchamp).then(
                      () => setOpened(true),
                      (caught: unknown) => setProblem(caught instanceof Error ? caught.message : "The reel could not be saved."),
                    );
                  }}>
                  Save the reel and open Clipchamp
                </Button>
                {opened && <Text size={200} role="status">Saved, and Clipchamp is open in a new tab.</Text>}
              </li>
              <li className={styles.step}>
                <Text weight="semibold">Edit it in Clipchamp</Text>
                <Text size={200} className={styles.muted}>
                  Sign in, choose <b>Create a new video</b>, then <b>Import media</b> and pick {fileName} from your downloads, and drag
                  it onto the timeline. Add text, music, stickers or captions. When it is ready, choose <b>Export</b> and save it at 1080p.
                </Text>
              </li>
              <li className={styles.step}>
                <Text weight="semibold">Bring the edited video back</Text>
                <Text size={200} className={styles.muted}>
                  Add the MP4 Clipchamp exported. It is kept beside the original reel, which stays as it was.
                </Text>
                <input ref={picker} className={styles.hidden} type="file" accept="video/mp4,.mp4,.mov" aria-label="Edited video from Clipchamp"
                  onChange={(event) => void add(event.target.files?.[0])} />
                <Button icon={busy === "adding" ? <Spinner size="tiny" /> : <ArrowUploadRegular />} disabled={busy !== null}
                  onClick={() => picker.current?.click()}>
                  {busy === "adding" ? "Adding the edited video…" : reel.edited ? "Replace the edited video" : "Add the edited video"}
                </Button>
                {reel.edited && (
                  <Text size={200} role="status">
                    {added ? "Added: " : "Edited version: "}
                    <span className={styles.file}>{reel.edited.name}</span>{` · ${megabytes(reel.edited.size_bytes)}`}
                  </Text>
                )}
              </li>
            </ol>
            {problem && <MessageBar intent="error" style={{ marginTop: tokens.spacingVerticalM }}><MessageBarBody>{problem}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            {reel.edited && (
              <Button className={styles.remove} appearance="subtle" disabled={busy !== null} onClick={() => void remove()}>
                {busy === "removing" ? "Removing…" : "Remove edited version"}
              </Button>
            )}
            <Button appearance="secondary" onClick={onClose}>Done</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

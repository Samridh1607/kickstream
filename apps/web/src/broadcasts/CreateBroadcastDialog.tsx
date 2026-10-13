import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DialogTrigger, Field, Input,
  makeStyles, MessageBar, MessageBarBody, Switch, Textarea, tokens,
} from "@fluentui/react-components";
import { type FormEvent, type ReactElement, useState } from "react";
import type { Broadcasts } from "../contracts";
import { createBroadcast } from "./api";

const useStyles = makeStyles({
  form: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalL },
});

interface Props {
  /** The button that opens the dialog. */
  trigger: ReactElement;
  onCreated: (doc: Broadcasts) => void;
}

/** Title, description and whether to record: a new broadcast, ready to go live. */
export function CreateBroadcastDialog({ trigger, onCreated }: Props) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [record, setRecord] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setTitle("");
    setDescription("");
    setRecord(true);
    setProblem(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      onCreated(await createBroadcast({ title, description, record }));
      setOpen(false);
      reset();
    } catch (caught) {
      setProblem(caught instanceof Error && caught.message ? caught.message : "The broadcast could not be created.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => { setOpen(data.open); if (!data.open) reset(); }}>
      <DialogTrigger disableButtonEnhancement>{trigger}</DialogTrigger>
      <DialogSurface aria-label="Create a broadcast">
        <form onSubmit={(event) => void submit(event)}>
          <DialogBody>
            <DialogTitle>Create a broadcast</DialogTitle>
            <DialogContent className={styles.form}>
              {problem && (
                <MessageBar intent="error">
                  <MessageBarBody>{problem}</MessageBarBody>
                </MessageBar>
              )}
              <Field label="Title" required hint="What viewers see, such as the match or the show's name.">
                <Input value={title} maxLength={80} autoFocus placeholder="Northbridge FC vs Harbour City"
                  onChange={(_, data) => setTitle(data.value)} />
              </Field>
              <Field label="Description" hint="Optional. The AI agents use it when they write your reels.">
                <Textarea value={description} maxLength={500} resize="vertical" placeholder="Matchday 12, live from the Harbour stadium"
                  onChange={(_, data) => setDescription(data.value)} />
              </Field>
              <Switch checked={record} label="Record this broadcast" onChange={(_, data) => setRecord(data.checked)} />
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button type="submit" appearance="primary" disabled={busy || title.trim() === ""}>Create broadcast</Button>
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}

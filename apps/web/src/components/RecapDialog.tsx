import {
  Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Text,
} from "@fluentui/react-components";
import type { Recap } from "../contracts";
import { type Language, t } from "../i18n";

interface RecapDialogProps {
  recap: Recap | null;
  language: Language;
  onClose(): void;
}

/** Non-modal, so the match stays usable behind it. */
export function RecapDialog({ recap, language, onClose }: RecapDialogProps) {
  return (
    <Dialog modalType="non-modal" open={recap !== null} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface>
        {recap && (
          <DialogBody>
            <DialogTitle>{recap.title}</DialogTitle>
            <DialogContent>
              <Text block>{recap.text}</Text>
              <ul>
                {recap.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
              {recap.source === "scripted" && <Badge appearance="tint" color="subtle">{t(language, "scripted")}</Badge>}
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={onClose}>{t(language, "close")}</Button>
            </DialogActions>
          </DialogBody>
        )}
      </DialogSurface>
    </Dialog>
  );
}

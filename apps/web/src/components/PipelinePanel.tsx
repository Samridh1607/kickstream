import { Badge, makeStyles, Text, tokens } from "@fluentui/react-components";
import type { Overlay, ViewerProfile } from "../contracts";
import { type StringKey, t } from "../i18n";
import type { FeedMoment, FeedNarrative } from "../stream/store";

const MISSING = "–";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: tokens.spacingVerticalS },
  steps: { listStyleType: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: tokens.spacingVerticalXS },
  step: { display: "grid", gridTemplateColumns: "8rem 1fr", alignItems: "center", gap: tokens.spacingHorizontalS },
  evidence: { margin: 0, paddingLeft: tokens.spacingHorizontalL, fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200 },
});

interface PipelinePanelProps {
  narrative: FeedNarrative | undefined;
  moment: FeedMoment | undefined;
  overlay: Overlay | undefined;
  profile: ViewerProfile;
}

/** Shows which stage and agent produced the selected narrative, and what it cited. */
export function PipelinePanel({ narrative, moment, overlay, profile }: PipelinePanelProps) {
  const styles = useStyles();
  const language = profile.language;

  if (!narrative) {
    return (
      <section className={styles.root} aria-label={t(language, "pipeline")}>
        <Text as="h2" weight="semibold">{t(language, "pipeline")}</Text>
        <Text>{t(language, "pipelineEmpty")}</Text>
      </section>
    );
  }

  const facts = moment?.facts.map((fact) => `${fact.label} ${fact.value}`).join(", ");
  const steps: { stage: StringKey; detail: string }[] = [
    { stage: "stageIngest", detail: moment?.event_id ?? MISSING },
    { stage: "stageInterpret", detail: moment ? `${t(language, `kind_${moment.kind}` as StringKey)} · ${facts}` : MISSING },
    { stage: "stageExplain", detail: `${narrative.agent} · ${narrative.source}` },
    { stage: "stageRender", detail: overlay ? `${overlay.kind} · ${overlay.id}` : MISSING },
    {
      stage: "stagePersonalize",
      detail: [profile.mode, profile.language, narrative.highlighted ? t(language, "highlighted") : null]
        .filter(Boolean).join(" · "),
    },
  ];

  return (
    <section className={styles.root} aria-label={t(language, "pipeline")}>
      <Text as="h2" weight="semibold">{t(language, "pipeline")}</Text>
      <ol className={styles.steps}>
        {steps.map(({ stage, detail }) => (
          <li key={stage} className={styles.step} data-testid="pipeline-step">
            <Badge appearance="tint">{t(language, stage)}</Badge>
            <Text size={200}>{detail}</Text>
          </li>
        ))}
      </ol>
      <Text size={200} weight="semibold">{t(language, "evidence")}</Text>
      <ul className={styles.evidence}>
        {narrative.evidence.map((id) => (
          <li key={id} data-testid="evidence">{id}</li>
        ))}
      </ul>
    </section>
  );
}

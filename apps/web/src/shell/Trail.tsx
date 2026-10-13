import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import { ChevronRightRegular } from "@fluentui/react-icons";
import { Fragment } from "react";

const useStyles = makeStyles({
  trail: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", margin: 0, padding: 0, listStyleType: "none", fontSize: tokens.fontSizeBase200 },
  link: { color: "inherit", opacity: 0.85, textDecorationLine: "none", ":hover": { opacity: 1, textDecorationLine: "underline" } },
  here: { fontWeight: tokens.fontWeightSemibold, overflowWrap: "anywhere" },
  divider: { display: "inline-flex", opacity: 0.6, fontSize: "12px" },
});

export interface Step {
  label: string;
  /** Omitted for the page you are on. */
  href?: string;
}

/** Where this page sits: Home › a broadcast › its studio. */
export function Trail({ steps, className }: { steps: Step[]; className?: string }) {
  const styles = useStyles();
  return (
    <nav aria-label="Breadcrumb">
      <ol className={mergeClasses(styles.trail, className)}>
        {steps.map((step, index) => (
          <Fragment key={`${index}-${step.label}`}>
            {index > 0 && <li aria-hidden className={styles.divider}><ChevronRightRegular /></li>}
            <li>
              {step.href ? <a href={step.href} className={styles.link}>{step.label}</a>
                : <span className={styles.here} aria-current="page">{step.label}</span>}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

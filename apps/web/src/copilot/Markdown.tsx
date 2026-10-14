import { makeStyles, mergeClasses, tokens } from "@fluentui/react-components";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const useStyles = makeStyles({
  root: {
    overflowWrap: "anywhere", lineHeight: tokens.lineHeightBase400,
    "& > :first-child": { marginTop: 0 },
    "& > :last-child": { marginBottom: 0 },
    "& p": { margin: `0 0 ${tokens.spacingVerticalS}` },
    "& h1, & h2, & h3, & h4, & h5, & h6": {
      margin: `${tokens.spacingVerticalM} 0 ${tokens.spacingVerticalXS}`, fontWeight: tokens.fontWeightSemibold, lineHeight: tokens.lineHeightBase400,
      color: tokens.colorNeutralForeground1,
    },
    "& h1": { fontSize: tokens.fontSizeBase500 },
    "& h2": { fontSize: tokens.fontSizeBase400 },
    "& h3, & h4, & h5, & h6": { fontSize: tokens.fontSizeBase300 },
    "& ul, & ol": { margin: `0 0 ${tokens.spacingVerticalS}`, paddingLeft: "1.3em" },
    "& li": { marginBottom: tokens.spacingVerticalXXS },
    "& li::marker": { color: tokens.colorBrandForeground1 },
    "& strong": { fontWeight: tokens.fontWeightSemibold },
    "& a": { color: tokens.colorBrandForegroundLink, textDecorationLine: "underline" },
    "& a:hover": { color: tokens.colorBrandForegroundLinkHover },
    "& code": {
      fontFamily: tokens.fontFamilyMonospace, fontSize: "0.9em", padding: `0 ${tokens.spacingHorizontalXXS}`,
      borderRadius: tokens.borderRadiusSmall, backgroundColor: tokens.colorNeutralBackground3,
    },
    "& pre": {
      margin: `0 0 ${tokens.spacingVerticalS}`, padding: tokens.spacingHorizontalS, overflowX: "auto",
      borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
    },
    "& pre code": { padding: 0, backgroundColor: "transparent" },
    "& blockquote": {
      margin: `0 0 ${tokens.spacingVerticalS}`, paddingLeft: tokens.spacingHorizontalM, color: tokens.colorNeutralForeground3,
      borderLeft: `${tokens.strokeWidthThick} solid ${tokens.colorNeutralStroke1}`,
    },
    "& hr": { border: "none", borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, margin: `${tokens.spacingVerticalS} 0` },
  },
  tableWrap: {
    overflowX: "auto", margin: `0 0 ${tokens.spacingVerticalS}`, borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  table: {
    width: "100%", borderCollapse: "collapse", fontSize: tokens.fontSizeBase200,
    "& th, & td": { padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, textAlign: "left", verticalAlign: "top" },
    "& th": { fontWeight: tokens.fontWeightSemibold, backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground2 },
    "& td": { borderTop: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`, fontVariantNumeric: "tabular-nums" },
    "& tbody tr:hover": { backgroundColor: tokens.colorSubtleBackgroundHover },
  },
});

/**
 * An answer written in Markdown, with GitHub tables. Raw HTML and images are dropped, and links open
 * apart from the studio and are told nothing about where they came from.
 */
export function CopilotMarkdown({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const styles = useStyles();
  const components: Components = {
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    table: ({ node: _node, ...props }) => <div className={styles.tableWrap}><table {...props} className={styles.table} /></div>,
  };
  return (
    <div className={mergeClasses(styles.root, className)} data-testid={testId}>
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml disallowedElements={["img"]} unwrapDisallowed>{text}</Markdown>
    </div>
  );
}

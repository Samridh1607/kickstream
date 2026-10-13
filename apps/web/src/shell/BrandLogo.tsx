import { makeStyles } from "@fluentui/react-components";
import { LiveFilled } from "@fluentui/react-icons";

const useStyles = makeStyles({
  logo: {
    display: "inline-flex", flexShrink: 0, alignItems: "center", justifyContent: "center", borderRadius: "10px",
    color: "#FFFFFF", backgroundImage: "linear-gradient(135deg, #7535E3 0%, #D92D20 100%)",
  },
});

/** The Kickstream mark: a live icon on the brand gradient. */
export function BrandLogo({ size = 36 }: { size?: number }) {
  const styles = useStyles();
  return <span className={styles.logo} style={{ width: size, height: size, fontSize: Math.round(size * 0.6) }} aria-hidden><LiveFilled /></span>;
}

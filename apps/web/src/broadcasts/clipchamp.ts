/**
 * Clipchamp, Microsoft's video editor, has no way for another app to hand it a video. So a reel goes
 * there as a file: it is saved to the computer and Clipchamp is opened beside Kickstream, where the
 * streamer imports it; the video exported from Clipchamp comes back as an upload.
 */

export const CLIPCHAMP_URL = "https://app.clipchamp.com/";

/** A name Windows, macOS and Clipchamp all accept, from the reel's title. */
export function reelFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  return `${safe.slice(0, 80) || "Kickstream reel"}.mp4`;
}

export interface ClipchampDeps {
  save(href: string, fileName: string): Promise<void>;
  open(url: string): void;
}

const browser: ClipchampDeps = {
  // The file is fetched first: the server names its downloads, and that name would win over this one.
  save: async (href, fileName) => {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`The reel could not be saved (${response.status}).`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  open: (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
};

/**
 * Opens Clipchamp in a new tab and saves the reel. Call it from a click: the tab is opened first,
 * while the click still counts, or the browser blocks it.
 */
export function openInClipchamp(href: string, fileName: string, deps: ClipchampDeps = browser): Promise<void> {
  deps.open(CLIPCHAMP_URL);
  return deps.save(href, fileName);
}

/** "12.4 MB" */
export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export const DEFAULTS = Object.freeze({
  enabled: true,
  autoCapture: false,
  overlay: true,
  minSize: 1048576,
  extensions: "zip rar 7z tar gz iso pdf mp4 mkv webm mp3 flac wav",
  excludedHosts: "",
  youtubeMode: "video",
  youtubeHeight: 1080,
});
export function youtubeVideoUrl(value) {
  const safe = httpUrl(value);
  if (!safe) return null;
  const u = new URL(safe);
  if (
    ![
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be",
    ].includes(u.hostname)
  )
    return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const id = u.hostname.endsWith("youtu.be")
    ? parts[0]
    : u.pathname === "/watch"
      ? u.searchParams.get("v")
      : ["shorts", "embed", "live"].includes(parts[0]) && parts.length === 2
        ? parts[1]
        : null;
  return /^[a-zA-Z0-9_-]{11}$/.test(id || "")
    ? "https://www.youtube.com/watch?v=" + id
    : null;
}
export function httpUrl(value) {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
      return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}
export function hostExcluded(value, text) {
  const url = httpUrl(value);
  if (!url) return true;
  const host = new URL(url).hostname.toLowerCase();
  return String(text)
    .split(/[\s,;]+/)
    .some((entry) => {
      const rule = entry
        .toLowerCase()
        .replace(/^\*\./, "")
        .replace(/^\.+|\.+$/g, "");
      return rule && (host === rule || host.endsWith("." + rule));
    });
}
export function kind(url, mime = "") {
  if (youtubeVideoUrl(url)) return "youtube";
  const path = new URL(
    httpUrl(url) || "https://invalid/",
  ).pathname.toLowerCase();
  if (/\.(m3u8|mpd)$/.test(path) || /mpegurl|dash\+xml/i.test(mime))
    return "stream";
  if (/\.(m4s|ts)$/.test(path)) return "segment";
  if (
    /\.(mp4|webm|mkv|mov|m4v|avi|mp3|m4a|aac|ogg|opus|flac|wav)$/.test(path) ||
    /^(video|audio)\//i.test(mime)
  )
    return "media";
  return "file";
}
export function normalizeCandidates(items) {
  const found = new Map();
  for (const item of items || []) {
    const url = httpUrl(item?.url);
    if (!url) continue;
    const candidate = {
      url,
      name: String(item.name || "").slice(0, 180),
      mime: String(item.mime || "").slice(0, 100),
      size: Math.max(0, Number(item.size) || 0),
      source: String(item.source || "page").slice(0, 40),
      kind: kind(url, item.mime),
      method: item.method === "GET" ? "GET" : null,
    };
    const previous = found.get(url);
    if (!previous || candidate.size > previous.size) found.set(url, candidate);
    if (found.size >= 200) break;
  }
  return [...found.values()];
}
export function sendable(candidate) {
  return (
    Boolean(httpUrl(candidate?.url)) &&
    !["stream", "segment"].includes(kind(candidate.url, candidate.mime))
  );
}
export function nativePayload(candidate, pageUrl, later = false) {
  if (!sendable(candidate))
    throw new Error(
      "Adaptive streams and fragments need the planned media engine. Choose a direct file instead.",
    );
  const page = httpUrl(pageUrl);
  const youtube = youtubeVideoUrl(candidate.url);
  const payload = {
    url: youtube || httpUrl(candidate.url),
    referer: page ? new URL(page).origin + "/" : null,
    description: String(candidate.name || "").slice(0, 180),
    later,
  };
  if (youtube)
    payload.media = {
      mode: ["audio", "mp3"].includes(candidate.media?.mode)
        ? candidate.media.mode
        : "video",
      max_height:
        Number.isInteger(Number(candidate.media?.max_height)) &&
        Number(candidate.media?.max_height) >= 32 &&
        Number(candidate.media?.max_height) <= 8640
          ? Number(candidate.media.max_height)
          : 1080,
    };
  return payload;
}
export function captureEligible(item, config, now = Date.now()) {
  if (
    !config.enabled ||
    !config.autoCapture ||
    item.incognito ||
    item.byExtensionId ||
    item.danger !== "safe" ||
    item.state !== "in_progress" ||
    item.paused
  )
    return false;
  const url = httpUrl(item.finalUrl || item.url);
  if (
    !url ||
    hostExcluded(url, config.excludedHosts) ||
    !sendable({ url, mime: item.mime })
  )
    return false;
  if (
    now - Date.parse(item.startTime) > 60000 ||
    !Number.isFinite(Date.parse(item.startTime))
  )
    return false;
  if (item.totalBytes < config.minSize || item.totalBytes <= 0) return false;
  const ext = String(item.filename || new URL(url).pathname)
    .toLowerCase()
    .split(".")
    .pop();
  return String(config.extensions)
    .toLowerCase()
    .split(/[\s,;.]+/)
    .filter(Boolean)
    .includes(ext);
}
export function transferDecision(job, original) {
  if (!original || original.state !== "in_progress" || !original.paused)
    return "release";
  if (job?.status === "completed") {
    return original.totalBytes > 0 &&
      job.total === original.totalBytes &&
      job.downloaded === original.totalBytes &&
      /^[a-f0-9]{64}$/.test(job.sha256 || "")
      ? "complete"
      : "restore";
  }
  if (["failed", "cancelled", "paused"].includes(job?.status)) return "restore";
  return "wait";
}

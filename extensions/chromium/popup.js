import {
  DEFAULTS,
  httpUrl,
  kind,
  sendable,
  youtubeVideoUrl,
} from "./policy.js";
const $ = (id) => document.getElementById(id);
let tab = null,
  items = [],
  selected = new Set(),
  state = null,
  desktop = null,
  busy = false,
  currentView = "discover";
const bytes = (value) => {
  if (!Number.isFinite(value) || value < 0) return "Unknown size";
  if (value < 1024) return value + " B";
  const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return (value / 1024 ** i).toFixed(1) + " " + ["B", "KB", "MB", "GB"][i];
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function showNotice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !text;
}
async function rpc(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok)
    throw new Error(
      response?.error ||
        "The extension worker did not respond. Reload the extension.",
    );
  return response.data;
}
async function work(task) {
  if (busy) return;
  busy = true;
  document.body.setAttribute("aria-busy", "true");
  try {
    await task();
  } catch (e) {
    showNotice(e.message || String(e), true);
  } finally {
    busy = false;
    document.body.removeAttribute("aria-busy");
  }
}
function name(candidate) {
  try {
    return (
      candidate.name ||
      decodeURIComponent(new URL(candidate.url).pathname.split("/").pop()) ||
      new URL(candidate.url).hostname
    );
  } catch {
    return candidate.url;
  }
}
function visibleItems() {
  const query = $("search").value.toLowerCase(),
    filter = $("filter").value;
  return items.filter(
    (c) =>
      (filter === "all" ||
        (filter === "stream"
          ? ["stream", "segment"].includes(c.kind)
          : filter === "media"
            ? ["media", "youtube"].includes(c.kind)
            : c.kind === filter)) &&
      (!query || (name(c) + " " + c.url).toLowerCase().includes(query)),
  );
}
function updateSelected() {
  const visible = visibleItems().filter(sendable);
  $("selected-count").textContent = selected.size + " selected";
  $("send-selected").disabled = !selected.size;
  $("select-all").checked =
    Boolean(visible.length) && visible.every((c) => selected.has(c.url));
  $("select-all").indeterminate =
    visible.some((c) => selected.has(c.url)) && !$("select-all").checked;
}
function renderCandidates() {
  const list = $("candidates");
  list.replaceChildren();
  const candidates = visibleItems();
  $("count").textContent = items.length;
  if (!candidates.length) {
    const empty = element(
      "div",
      items.length ? "No matching files." : "No files discovered yet.",
      "empty",
    );
    empty.append(
      element(
        "small",
        "Scan the page, allow this site, or paste a direct file URL.",
      ),
    );
    list.append(empty);
  }
  for (const candidate of candidates) {
    const row = element("label", null, "item"),
      check = element("input");
    check.type = "checkbox";
    check.checked = selected.has(candidate.url);
    check.disabled = !sendable(candidate);
    check.setAttribute("aria-label", "Select " + name(candidate));
    check.addEventListener("change", () => {
      if (check.checked) selected.add(candidate.url);
      else selected.delete(candidate.url);
      updateSelected();
    });
    const info = element("span", null, "info"),
      title = element("strong", name(candidate));
    title.title = name(candidate);
    const origin = new URL(candidate.url);
    const meta = element(
      "small",
      origin.hostname +
        " · " +
        (candidate.size ? bytes(candidate.size) : candidate.source),
    );
    meta.title = candidate.url;
    info.append(title, meta);
    const tag = element(
      "span",
      sendable(candidate) ? candidate.kind : "Not supported",
      "tag" + (!sendable(candidate) ? " unsupported" : ""),
    );
    row.append(check, info, tag);
    list.append(row);
  }
  updateSelected();
}
async function loadYoutubeQualities() {
  const quality = $("youtube-quality");
  $("youtube-download").disabled = true;
  quality.disabled = true;
  quality.replaceChildren(new Option("Checking available qualities...", ""));
  try {
    const info = await rpc("video-formats", { url: youtubeVideoUrl(tab?.url) });
    const heights = [
      ...new Set(
        info.heights.filter((h) => Number.isInteger(h) && h >= 32 && h <= 8640),
      ),
    ].sort((a, b) => b - a);
    quality.replaceChildren(
      ...heights.map((h) => new Option(`${h}p`, String(h))),
    );
    const preferred = Number(state?.config?.youtubeHeight || 1080);
    quality.value = String(
      heights.includes(preferred)
        ? preferred
        : heights.find((h) => h <= preferred) || heights[0] || "",
    );
    quality.disabled = $("youtube-mode").value !== "video" || !heights.length;
    $("youtube-download").disabled =
      $("youtube-mode").value === "video"
        ? !heights.length
        : !info.audio_available;
    $("youtube-caption").textContent = info.title || tab.title;
  } catch (error) {
    quality.replaceChildren(new Option("Quality check failed", ""));
    $("youtube-caption").textContent = error.message;
  }
}
async function checkConnection() {
  try {
    desktop = await rpc("native", { operation: "status" });
    $("connection").textContent = "Background engine connected";
    $("plan").textContent =
      desktop.plan.name +
      " · " +
      desktop.count +
      " files · v" +
      desktop.version;
    $("dot").classList.add("online");
    $("retry").hidden = true;
    if (youtubeVideoUrl(tab?.url)) {
      $("youtube-download").disabled =
        !desktop.media?.youtube || !desktop.plan.paid_features;
      $("youtube-caption").textContent = !desktop.media?.youtube
        ? "Reopen the updated Current engine. YouTube needs yt-dlp, Deno, FFmpeg and FFprobe."
        : !desktop.plan.paid_features
          ? "YouTube downloads require Pro."
          : tab.title || "Send this video to Current.";
      if (desktop.media?.youtube && desktop.plan.paid_features)
        void loadYoutubeQualities();
    }
  } catch (e) {
    desktop = null;
    $("connection").textContent = "Desktop connection needed";
    $("plan").textContent = "Open Settings → Connect the desktop app";
    $("dot").classList.remove("online");
    $("retry").hidden = false;
    $("youtube-download").disabled = true;
    showNotice(e.message, true);
  }
}
async function readState() {
  state = await rpc("state", { tabId: tab?.id });
  if (state.notice && Date.now() - state.notice.at < 60000)
    showNotice(state.notice.text, state.notice.error);
  return state;
}
async function scan(selectedOnly = false) {
  if (tab?.id == null) throw new Error("Open a webpage in the active tab.");
  const result = await rpc("scan", { tabId: tab.id, selected: selectedOnly });
  items = result.items;
  selected.clear();
  renderCandidates();
  const notes = [];
  if (result.blob)
    notes.push("Blob playback found: the page does not expose a direct file.");
  if (result.protected) notes.push("Protected playback is not transferable.");
  if (items.some((c) => ["stream", "segment"].includes(c.kind)))
    notes.push(
      "Adaptive manifests/fragments are listed for visibility; media assembly is not available yet.",
    );
  $("media-note").textContent = notes.join(" ");
  $("media-note").hidden = !notes.length;
  if (!notes.length)
    showNotice(items.length + " links found. Choose the files you want.");
}
function fillSettings(cfg) {
  $("youtube-mode").value = cfg.youtubeMode || "video";
  if (
    [...$("youtube-quality").options].some(
      (o) => o.value === String(cfg.youtubeHeight || 1080),
    )
  )
    $("youtube-quality").value = String(cfg.youtubeHeight || 1080);
  $("enabled").checked = cfg.enabled;
  $("auto-capture").checked = cfg.autoCapture;
  $("overlay").checked = cfg.overlay;
  $("min-size").value = cfg.minSize / 1048576;
  $("extensions").value = cfg.extensions;
  $("excluded").value = cfg.excludedHosts;
}
async function refreshTransfers() {
  await rpc("reconcile");
  await checkConnection();
  await readState();
  const jobs = $("jobs");
  jobs.replaceChildren();
  if (!desktop?.jobs.length)
    jobs.append(
      element(
        "div",
        desktop
          ? "No downloads yet."
          : "Connect the desktop app to view downloads.",
        "empty",
      ),
    );
  for (const job of desktop?.jobs || []) {
    const row = element("div", null, "item"),
      info = element("div", null, "info");
    info.append(
      element("strong", job.filename),
      element(
        "small",
        job.status +
          " · " +
          bytes(job.downloaded) +
          (job.total ? " / " + bytes(job.total) : ""),
      ),
    );
    if (job.total) {
      const progress = element("div", null, "progress"),
        bar = element("i");
      bar.style.width = Math.min(100, (100 * job.downloaded) / job.total) + "%";
      progress.append(bar);
      info.append(progress);
    }
    if (job.error) {
      const error = element("small", job.error);
      error.title = job.error;
      info.append(error);
    }
    row.append(info);
    if (
      ["downloading", "probing", "queued"].includes(job.status) ||
      ["paused", "failed"].includes(job.status)
    ) {
      const action = ["paused", "failed"].includes(job.status)
          ? "resume"
          : "pause",
        button = element(
          "button",
          action === "resume" ? "Resume" : "Pause",
          "secondary",
        );
      button.addEventListener("click", () =>
        work(async () => {
          await rpc("native", {
            operation: "action",
            payload: { id: job.id, action },
          });
          await refreshTransfers();
        }),
      );
      row.append(button);
    }
    jobs.append(row);
  }
  const pending = $("pending");
  pending.replaceChildren();
  for (const [id, record] of Object.entries(state.pending)) {
    const row = element("div", null, "item"),
      info = element("div", null, "info");
    info.append(
      element("strong", record.filename),
      element("small", "Chrome copy retained · checks every 30 seconds"),
    );
    const release = element("button", "Use Chrome", "secondary");
    release.addEventListener("click", () =>
      work(async () => {
        await rpc("release", { browserId: id });
        await refreshTransfers();
      }),
    );
    row.append(info, release);
    pending.append(row);
  }
  const browserJobs = await rpc("browser-downloads"),
    list = $("browser-jobs");
  list.replaceChildren();
  const permitted = await chrome.permissions.contains({
    permissions: ["downloads"],
  });
  $("browser-permission").hidden = permitted;
  for (const job of browserJobs) {
    if (state.pending[job.id]) continue;
    const row = element("div", null, "item"),
      info = element("div", null, "info");
    info.append(
      element("strong", job.filename || "Browser download"),
      element("small", bytes(job.size) + (job.paused ? " · Paused" : "")),
    );
    const button = element("button", "Transfer", "secondary");
    button.disabled = job.danger !== "safe" || job.size <= 0;
    button.addEventListener("click", () =>
      work(async () => {
        await rpc("transfer", { browserId: job.id });
        await refreshTransfers();
      }),
    );
    row.append(info, button);
    list.append(row);
  }
}
async function changeView(view) {
  currentView = view;
  for (const section of document.querySelectorAll(".view"))
    section.hidden = section.id !== view;
  for (const button of document.querySelectorAll("nav button")) {
    if (button.dataset.view === view)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (view === "transfers") await refreshTransfers();
  if (view === "settings") fillSettings((await readState()).config);
}
for (const button of document.querySelectorAll("nav button"))
  button.addEventListener("click", () =>
    work(() => changeView(button.dataset.view)),
  );
$("search").addEventListener("input", renderCandidates);
$("filter").addEventListener("change", renderCandidates);
$("select-all").addEventListener("change", () => {
  for (const item of visibleItems().filter(sendable)) {
    if ($("select-all").checked) selected.add(item.url);
    else selected.delete(item.url);
  }
  renderCandidates();
});
$("scan").addEventListener("click", () => work(() => scan()));
$("scan-selected").addEventListener("click", () => work(() => scan(true)));
$("send-selected").addEventListener("click", () =>
  work(async () => {
    const chosen = items.filter((c) => selected.has(c.url));
    if (chosen.length > 100) throw new Error("Select at most 100 files.");
    if (chosen.length === 1) {
      const sent = await rpc("send", {
        candidate: chosen[0],
        tabId: tab?.id,
        later: $("later").checked,
      });
      selected.clear();
      showNotice(
        sent.launchWarning
          ? "Download added. " + sent.launchWarning
          : "Added to Current and opened the desktop app.",
        Boolean(sent.launchWarning),
      );
    } else {
      const result = await rpc("send-many", {
        items: chosen,
        tabId: tab?.id,
        later: $("later").checked,
      });
      for (const job of result.added) selected.delete(job.url);
      showNotice(
        result.added.length +
          " added" +
          (result.errors.length
            ? "; " +
              result.errors.length +
              " rejected: " +
              result.errors[0].error
            : ".") +
          (result.launchWarning ? " " + result.launchWarning : ""),
        Boolean(result.errors.length || result.launchWarning),
      );
    }
    renderCandidates();
  }),
);
$("url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  work(async () => {
    const url = httpUrl($("url").value.trim());
    if (!url)
      throw new Error("Use an HTTP(S) URL without embedded credentials.");
    const sent = await rpc("send", {
      candidate: { url },
      tabId: tab?.id,
      later: $("later").checked,
    });
    $("url").value = "";
    showNotice(
      sent.launchWarning
        ? "Download added. " + sent.launchWarning
        : "Download added and Current opened.",
      Boolean(sent.launchWarning),
    );
  });
});
$("retry").addEventListener("click", () => work(checkConnection));
$("open").addEventListener("click", () =>
  work(async () => {
    await rpc("native", { operation: "open" });
    showNotice("Opened the desktop application.");
  }),
);
$("refresh-transfers").addEventListener("click", () => work(refreshTransfers));
$("browser-permission").addEventListener("click", () =>
  work(async () => {
    if (await chrome.permissions.request({ permissions: ["downloads"] }))
      await refreshTransfers();
    else showNotice("Browser handoff permission was not granted.");
  }),
);
$("site").addEventListener("click", () =>
  work(async () => {
    const url = httpUrl(tab?.url);
    if (!url) throw new Error("Open a webpage first.");
    const origin = new URL(url).origin + "/*";
    if (await chrome.permissions.contains({ origins: [origin] })) {
      await chrome.permissions.remove({ origins: [origin] });
      $("site").textContent = "Enable on site";
      showNotice(
        "Persistent site access removed. Reload the page to remove its existing media button.",
      );
    } else if (await chrome.permissions.request({ origins: [origin] })) {
      await rpc("register-sites");
      $("site").textContent = "Disable on site";
      await scan();
      showNotice(
        "Site access enabled. Reload the page to observe new network media requests.",
      );
    }
  }),
);
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  work(async () => {
    const autoCapture = $("auto-capture").checked;
    if (
      autoCapture &&
      !(await chrome.permissions.contains({ permissions: ["downloads"] })) &&
      !(await chrome.permissions.request({ permissions: ["downloads"] }))
    ) {
      $("auto-capture").checked = false;
      throw new Error("Automatic handoff needs optional Downloads permission.");
    }
    await rpc("settings", {
      value: {
        enabled: $("enabled").checked,
        overlay: $("overlay").checked,
        autoCapture,
        minSize: Number($("min-size").value) * 1048576,
        extensions: $("extensions").value,
        excludedHosts: $("excluded").value,
      },
    });
    showNotice(
      "Preferences saved. Chrome retains its paused copy until Current verifies completion.",
    );
  });
});
const command =
  "& '.\\scripts\\register-browser.ps1' -ExtensionId '" +
  chrome.runtime.id +
  "'";
$("setup-command").textContent = command;
$("copy-command").addEventListener("click", () =>
  work(async () => {
    await navigator.clipboard.writeText(command);
    showNotice(
      "Copied. Run it from the Current application folder in PowerShell.",
    );
  }),
);
async function init() {
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $("youtube-panel").hidden = !youtubeVideoUrl(tab?.url);
    $("site").hidden = Boolean(youtubeVideoUrl(tab?.url));
    $("hostname").textContent = httpUrl(tab?.url)
      ? new URL(tab.url).hostname
      : "Open a webpage to discover files.";
    await readState();
    items = state.items;
    renderCandidates();
    fillSettings(state.config);
    if (
      httpUrl(tab?.url) &&
      (await chrome.permissions.contains({
        origins: [new URL(tab.url).origin + "/*"],
      }))
    )
      $("site").textContent = "Disable on site";
    await checkConnection();
  } catch (e) {
    showNotice(e.message, true);
  }
}
init();
for (const id of ["youtube-mode", "youtube-quality"])
  $(id).addEventListener("change", () =>
    work(async () => {
      await rpc("media-settings", {
        mode: $("youtube-mode").value,
        height: Number($("youtube-quality").value),
      });
      $("youtube-quality").disabled = $("youtube-mode").value !== "video";
    }),
  );
$("youtube-download").addEventListener("click", () =>
  work(async () => {
    const url = youtubeVideoUrl(tab?.url);
    if (!url) throw new Error("Open a single YouTube video first.");
    const sent = await rpc("send", {
      tabId: tab.id,
      candidate: {
        url,
        name: tab.title || "YouTube video",
        media: {
          mode: $("youtube-mode").value,
          max_height: Number($("youtube-quality").value),
        },
      },
      later: $("later").checked,
    });
    showNotice(
      sent.launchWarning
        ? "Added. " + sent.launchWarning
        : "YouTube job added and Current opened. Extraction and merging run in the software.",
      Boolean(sent.launchWarning),
    );
  }),
);
// Poll only while the popup is open; the alarm handles durable handoff completion.
setInterval(() => {
  if (currentView === "transfers" && !busy) work(refreshTransfers);
}, 4000);

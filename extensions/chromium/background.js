import {
  DEFAULTS,
  httpUrl,
  hostExcluded,
  kind,
  normalizeCandidates,
  nativePayload,
  captureEligible,
  transferDecision,
  youtubeVideoUrl,
} from "./policy.js";
const HOST = "app.current.downloadmanager";
let mutation = Promise.resolve(),
  reconciling = false;
const inFlight = new Set();
async function config() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get("config")).config };
}
async function session(key, fallback) {
  return (await chrome.storage.session.get(key))[key] ?? fallback;
}
function serialize(work) {
  const next = mutation.then(work, work);
  mutation = next.catch(() => {});
  return next;
}
const formatCache = new Map();
const formatRequests = new Map();
async function videoFormats(value) {
  const url = youtubeVideoUrl(value);
  if (!url) throw new Error("Choose a single YouTube video.");
  const cached = formatCache.get(url);
  if (cached && Date.now() - cached.at < 120000) return cached.data;
  if (formatRequests.has(url)) return formatRequests.get(url);
  const request = native("youtube_formats", { url })
    .then((data) => {
      if (!Array.isArray(data?.heights))
        throw new Error("Update Current to enable video quality detection.");
      if (formatCache.size >= 50)
        formatCache.delete(formatCache.keys().next().value);
      formatCache.set(url, { at: Date.now(), data });
      return data;
    })
    .finally(() => formatRequests.delete(url));
  formatRequests.set(url, request);
  return request;
}
async function native(operation, payload = null) {
  let response;
  try {
    response = await chrome.runtime.sendNativeMessage(HOST, {
      operation,
      payload,
    });
  } catch (e) {
    throw new Error(
      "Current is not connected. Register the native host using Setup. " +
        (e.message || e),
    );
  }
  if (!response?.ok)
    throw new Error(
      response?.error || "The desktop engine rejected the request.",
    );
  return response.job ?? response.data;
}
async function notice(text, error = false) {
  await chrome.storage.session.set({
    notice: { text: String(text).slice(0, 700), error, at: Date.now() },
  });
  await chrome.action.setBadgeBackgroundColor({
    color: error ? "#9f4c39" : "#356744",
  });
  await chrome.action.setBadgeText({ text: error ? "!" : "OK" });
}
async function remember(tabId, items) {
  if (tabId < 0) return;
  await serialize(async () => {
    const key = "page:" + tabId,
      old = await session(key, []);
    const value = [];
    let size = 0;
    for (const item of normalizeCandidates([...items, ...old])) {
      size += JSON.stringify(item).length * 2;
      if (size > 131072) break;
      value.push(item);
    }
    const pages = Object.keys(await chrome.storage.session.get(null)).filter(
      (k) => k.startsWith("page:") && k !== key,
    );
    if (pages.length >= 12)
      await chrome.storage.session.remove(pages.slice(0, pages.length - 11));
    await chrome.storage.session.set({ [key]: value });
    await chrome.action.setBadgeText({
      tabId,
      text: value.length ? String(value.length) : "",
    });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#356744" });
  });
}
async function discover(tabId, selected = false) {
  const tab = await chrome.tabs.get(tabId),
    cfg = await config();
  if (!httpUrl(tab.url))
    throw new Error(
      "Open an HTTP or HTTPS page. Chrome internal pages and the Web Store cannot be scanned.",
    );
  if (tab.incognito)
    throw new Error("Current does not scan private browsing tabs.");
  if (!cfg.enabled || hostExcluded(tab.url, cfg.excludedHosts))
    throw new Error("Integration is disabled for this page.");
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content.js"],
    });
  } catch {
    throw new Error(
      "This page cannot be scanned. Refresh it or paste a public file URL.",
    );
  }
  const result = await chrome.tabs.sendMessage(tabId, {
    type: "scan",
    selected,
  });
  if (!selected) await remember(tabId, result.items);
  return {
    items: normalizeCandidates(
      selected
        ? result.items
        : [...result.items, ...(await session("page:" + tabId, []))],
    ),
    blob: result.blob,
    protected: result.protected,
  };
}
async function submit(candidate, tabId, later = false) {
  const cfg = await config();
  if (!cfg.enabled) throw new Error("Enable Current integration first.");
  const tab =
    tabId == null ? null : await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.incognito) throw new Error("Private tab downloads stay in Chrome.");
  if (
    hostExcluded(candidate.url, cfg.excludedHosts) ||
    (httpUrl(tab?.url) && hostExcluded(tab.url, cfg.excludedHosts))
  )
    throw new Error("This site is excluded in Current settings.");
  const payload = nativePayload(
    {
      ...candidate,
      media: candidate.media || {
        mode: cfg.youtubeMode,
        max_height: cfg.youtubeHeight,
      },
    },
    tab?.url,
    later,
  );
  const job = await native(
    youtubeVideoUrl(candidate.url) ? "youtube" : "add",
    payload,
  );
  try {
    await native("open");
  } catch (e) {
    job.launchWarning = e.message;
  }
  await notice(
    "Added " +
      job.filename +
      " to Current." +
      (job.launchWarning ? " " + job.launchWarning : ""),
    Boolean(job.launchWarning),
  );
  return job;
}
async function registerSites() {
  const permissions = await chrome.permissions.getAll();
  await chrome.scripting
    .unregisterContentScripts({ ids: ["current-sites"] })
    .catch(() => {});
  const cfg = await config(),
    matches = (permissions.origins || []).filter((x) => /^https?:\/\//.test(x));
  if (cfg.enabled && matches.length)
    await chrome.scripting.registerContentScripts([
      {
        id: "current-sites",
        js: ["content.js"],
        matches,
        runAt: "document_idle",
        allFrames: true,
        persistAcrossSessions: true,
      },
    ]);
}
async function transfer(browserId, automatic = false) {
  if (inFlight.has(browserId))
    throw new Error("This browser download is already being transferred.");
  inFlight.add(browserId);
  let original,
    pausedByUs = false,
    job,
    recordCreated = false;
  try {
    if (!(await chrome.permissions.contains({ permissions: ["downloads"] })))
      throw new Error("Enable browser handoff in Settings first.");
    if ((await session("pending", {}))[browserId])
      throw new Error("This download already has a Current transfer.");
    [original] = await chrome.downloads.search({ id: browserId });
    const cfg = await config();
    if (!cfg.enabled) throw new Error("Integration is disabled.");
    if (
      !original ||
      original.state !== "in_progress" ||
      original.incognito ||
      original.danger !== "safe" ||
      original.totalBytes <= 0
    )
      throw new Error(
        "Only safe, active, non-private browser downloads with a known size can be handed off.",
      );
    if (automatic && !captureEligible(original, cfg)) return;
    const url = original.finalUrl || original.url;
    if (
      !httpUrl(url) ||
      hostExcluded(url, cfg.excludedHosts) ||
      (original.referrer && hostExcluded(original.referrer, cfg.excludedHosts))
    )
      throw new Error("This URL cannot be transferred or is excluded.");
    await native("ping");
    await chrome.alarms.create("current-handoffs", { periodInMinutes: 0.5 });
    await serialize(async () => {
      const records = await session("pending", {});
      records[browserId] = {
        jobId: null,
        pausedByUs: !original.paused,
        filename: original.filename?.split(/[\\/]/).pop() || "Download",
        at: Date.now(),
        failures: 0,
      };
      await chrome.storage.session.set({ pending: records });
    });
    recordCreated = true;
    if (!original.paused) {
      await chrome.downloads.pause(browserId);
      pausedByUs = true;
    }
    const [fresh] = await chrome.downloads.search({ id: browserId });
    if (!fresh || fresh.state !== "in_progress" || !fresh.paused)
      throw new Error(
        "Chrome finished or changed this download before handoff.",
      );
    job = await native(
      "add",
      nativePayload(
        {
          url,
          name: original.filename?.split(/[\\/]/).pop(),
          mime: original.mime,
        },
        original.referrer,
        true,
      ),
    );
    await serialize(async () => {
      const records = await session("pending", {});
      records[browserId] = {
        jobId: job.id,
        pausedByUs,
        filename: job.filename,
        at: Date.now(),
        failures: 0,
      };
      await chrome.storage.session.set({ pending: records });
    });
    await native("action", { id: job.id, action: "resume" });
    if (!automatic) {
      try {
        await native("open");
      } catch (e) {
        job.launchWarning = e.message;
      }
    }
    await chrome.alarms.create("current-handoffs", { periodInMinutes: 0.5 });
    await notice(
      "Current is downloading " +
        job.filename +
        ". Chrome keeps its paused copy until verification completes.",
    );
    return job;
  } catch (e) {
    if (job)
      await native("action", { id: job.id, action: "pause" }).catch(() => {});
    if (pausedByUs) await chrome.downloads.resume(browserId).catch(() => {});
    if (recordCreated)
      await serialize(async () => {
        const p = await session("pending", {});
        delete p[browserId];
        await chrome.storage.session.set({ pending: p });
      });
    throw e;
  } finally {
    inFlight.delete(browserId);
  }
}
async function reconcile() {
  if (
    reconciling ||
    !(await chrome.permissions.contains({ permissions: ["downloads"] }))
  )
    return;
  reconciling = true;
  try {
    const pending = await session("pending", {});
    for (const [id, record] of Object.entries(pending)) {
      if (inFlight.has(Number(id))) continue;
      let job, original;
      try {
        [original] = await chrome.downloads.search({ id: Number(id) });
      } catch {
        continue;
      }
      try {
        job = await native("job", { id: record.jobId });
        record.failures = 0;
      } catch {
        record.failures++;
      }
      let decision = (await config()).enabled
        ? transferDecision(job, original)
        : "restore";
      if (decision === "wait" && record.failures >= 3) decision = "restore";
      if (decision === "complete") {
        try {
          await chrome.downloads.cancel(Number(id));
        } catch {
          continue;
        }
        await notice(
          "Verified in Current: " +
            record.filename +
            ". Chrome’s paused copy was cancelled.",
        );
      } else if (decision === "restore") {
        if (record.pausedByUs) {
          try {
            await chrome.downloads.resume(Number(id));
          } catch {
            continue;
          }
        }
        await native("action", { id: record.jobId, action: "pause" }).catch(
          () => {},
        );
        await notice(
          "Current could not finish " +
            record.filename +
            ". Chrome’s original download was retained.",
          true,
        );
      } else if (decision === "release")
        await native("action", { id: record.jobId, action: "pause" }).catch(
          () => {},
        );
      await serialize(async () => {
        const records = await session("pending", {});
        if (decision === "wait") records[id] = record;
        else delete records[id];
        await chrome.storage.session.set({ pending: records });
      });
    }
    if (!Object.keys(await session("pending", {})).length)
      await chrome.alarms.clear("current-handoffs");
  } finally {
    reconciling = false;
  }
}
async function menus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "send",
    title: "Download with Current",
    contexts: ["link", "video", "audio", "image"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
  chrome.contextMenus.create({
    id: "scan",
    title: "Find downloads with Current",
    contexts: ["page", "selection"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
  });
}
chrome.runtime.onInstalled.addListener(() => {
  menus().catch(console.error);
  registerSites().catch(console.error);
});
chrome.runtime.onStartup.addListener(() => {
  menus().catch(console.error);
  registerSites().catch(console.error);
});
chrome.permissions.onRemoved.addListener(() =>
  registerSites().catch(console.error),
);
chrome.tabs.onRemoved.addListener((tabId) =>
  chrome.storage.session.remove("page:" + tabId),
);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading")
    chrome.storage.session.remove("page:" + tabId);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "current-handoffs") reconcile().catch(console.error);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const work =
    info.menuItemId === "send"
      ? submit({ url: info.linkUrl || info.srcUrl }, tab?.id)
      : discover(tab.id, Boolean(info.selectionText)).then(async (result) => {
          await chrome.storage.session.set({
            lastScan: { tabId: tab.id, at: Date.now(), ...result },
          });
          await chrome.action.openPopup();
        });
  work.catch((e) => notice(e.message, true));
});
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    (async () => {
      const cfg = await config();
      if (
        !cfg.enabled ||
        details.tabId < 0 ||
        details.method !== "GET" ||
        details.statusCode < 200 ||
        details.statusCode >= 300 ||
        hostExcluded(details.url, cfg.excludedHosts)
      )
        return;
      const tab = await chrome.tabs.get(details.tabId);
      if (tab.incognito || hostExcluded(tab.url, cfg.excludedHosts)) return;
      const headers = new Map(
        (details.responseHeaders || []).map((h) => [
          h.name.toLowerCase(),
          h.value,
        ]),
      );
      const mime = headers.get("content-type") || "",
        type = kind(details.url, mime);
      if (
        type === "file" &&
        !/attachment/i.test(headers.get("content-disposition") || "")
      )
        return;
      await remember(details.tabId, [
        {
          url: details.url,
          mime,
          size: Number(headers.get("content-length")) || 0,
          source: "network",
          method: "GET",
        },
      ]);
    })().catch(() => {});
  },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);
function browserDownload(item) {
  config()
    .then((cfg) => {
      if (captureEligible(item, cfg)) return transfer(item.id, true);
    })
    .catch((e) => notice(e.message, true));
}
let downloadListeners = false;
function installDownloadListeners() {
  if (downloadListeners || !chrome.downloads?.onDeterminingFilename) return;
  downloadListeners = true;
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    suggest();
    browserDownload(item);
  });
  chrome.downloads.onChanged.addListener(() =>
    reconcile().catch(console.error),
  );
}
installDownloadListeners();
chrome.permissions.onAdded.addListener(() => {
  installDownloadListeners();
  registerSites().catch(console.error);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  const task = (async () => {
    if (sender.tab) {
      const cfg = await config();
      if (
        sender.tab.incognito ||
        !cfg.enabled ||
        hostExcluded(sender.url, cfg.excludedHosts)
      )
        throw new Error("Integration is disabled for this page.");
      if (message.type === "report") {
        await remember(sender.tab.id, message.items);
        return {
          overlay: cfg.overlay,
          youtubeMode: cfg.youtubeMode,
          youtubeHeight: cfg.youtubeHeight,
        };
      }
      if (message.type === "video-formats") {
        const page = youtubeVideoUrl(sender.url);
        if (!page || youtubeVideoUrl(message.url) !== page)
          throw new Error("Only this page's YouTube video can be inspected.");
        return videoFormats(page);
      }
      if (message.type === "send")
        return submit(message.candidate, sender.tab.id);
      if (message.type === "content-config")
        return {
          overlay: cfg.overlay,
          youtubeMode: cfg.youtubeMode,
          youtubeHeight: cfg.youtubeHeight,
        };
      throw new Error("This action is available only in the extension popup.");
    }
    switch (message.type) {
      case "state": {
        const scan = await session("lastScan", null);
        const contextual =
          scan?.tabId === message.tabId && Date.now() - scan.at < 30000;
        if (contextual) await chrome.storage.session.remove("lastScan");
        return {
          config: await config(),
          notice: await session("notice", null),
          pending: await session("pending", {}),
          items:
            message.tabId == null
              ? []
              : contextual
                ? scan.items
                : await session("page:" + message.tabId, []),
        };
      }
      case "scan":
        return discover(message.tabId, Boolean(message.selected));
      case "send":
        return submit(message.candidate, message.tabId, Boolean(message.later));
      case "send-many": {
        const cfg = await config(),
          tab = await chrome.tabs.get(message.tabId),
          items = normalizeCandidates(message.items);
        if (
          !cfg.enabled ||
          tab.incognito ||
          hostExcluded(tab.url, cfg.excludedHosts)
        )
          throw new Error("Integration is disabled for this page.");
        if (items.length > 100)
          throw new Error("Send at most 100 links at a time.");
        if (items.some((c) => hostExcluded(c.url, cfg.excludedHosts)))
          throw new Error("The selection includes an excluded site.");
        const added = [],
          errors = [];
        if (items.some((c) => youtubeVideoUrl(c.url))) {
          const status = await native("status");
          if (!status.plan.paid_features)
            throw new Error("Batch and YouTube downloads require Pro.");
          for (const [index, candidate] of items.entries()) {
            try {
              const payload = nativePayload(
                {
                  ...candidate,
                  media: {
                    mode: cfg.youtubeMode,
                    max_height: cfg.youtubeHeight,
                  },
                },
                tab.url,
                Boolean(message.later),
              );
              added.push(
                await native(
                  youtubeVideoUrl(candidate.url) ? "youtube" : "add",
                  payload,
                ),
              );
            } catch (e) {
              errors.push({ index, error: e.message });
            }
          }
          if (added.length) await native("open").catch(() => {});
          return { added, errors };
        }
        for (let offset = 0; offset < items.length; offset += 20) {
          const result = await native(
            "add_many",
            items
              .slice(offset, offset + 20)
              .map((c) => nativePayload(c, tab.url, Boolean(message.later))),
          );
          added.push(...result.added);
          errors.push(
            ...result.errors.map((e) => ({ ...e, index: e.index + offset })),
          );
        }
        let launchWarning;
        if (added.length) {
          try {
            await native("open");
          } catch (e) {
            launchWarning = e.message;
          }
        }
        await notice(
          added.length +
            " links added" +
            (errors.length ? "; " + errors.length + " rejected." : "."),
          Boolean(errors.length),
        );
        return { added, errors, launchWarning };
      }
      case "video-formats":
        return videoFormats(message.url);
      case "native":
        if (!["status", "ping", "action", "open"].includes(message.operation))
          throw new Error("Unsupported popup operation.");
        return native(message.operation, message.payload);
      case "settings": {
        const old = await config(),
          value = message.value || {};
        const next = {
          ...old,
          enabled: !!value.enabled,
          autoCapture: !!value.autoCapture,
          overlay: !!value.overlay,
          minSize: Math.max(0, Math.min(1e12, Number(value.minSize) || 0)),
          extensions: String(value.extensions || "").slice(0, 500),
          excludedHosts: String(value.excludedHosts || "").slice(0, 2000),
        };
        await chrome.storage.local.set({ config: next });
        await registerSites();
        for (const tab of await chrome.tabs.query({})) {
          chrome.tabs
            .sendMessage(tab.id, {
              type: "preferences",
              enabled:
                next.enabled &&
                !hostExcluded(
                  tab.url || "https://invalid/",
                  next.excludedHosts,
                ),
              overlay: next.overlay,
            })
            .catch(() => {});
        }
        await reconcile();
        return next;
      }
      case "media-settings": {
        const cfg = await config();
        cfg.youtubeMode = ["audio", "mp3"].includes(message.mode)
          ? message.mode
          : "video";
        cfg.youtubeHeight =
          Number.isInteger(Number(message.height)) &&
          Number(message.height) >= 32 &&
          Number(message.height) <= 8640
            ? Number(message.height)
            : 1080;
        await chrome.storage.local.set({ config: cfg });
        return cfg;
      }
      case "register-sites":
        await registerSites();
        return true;
      case "browser-downloads":
        if (
          !(await chrome.permissions.contains({ permissions: ["downloads"] }))
        )
          return [];
        return (
          await chrome.downloads.search({
            state: "in_progress",
            orderBy: ["-startTime"],
            limit: 15,
          })
        )
          .filter((x) => !x.incognito)
          .map((x) => ({
            id: x.id,
            filename: x.filename.split(/[\\/]/).pop(),
            size: x.totalBytes,
            paused: x.paused,
            danger: x.danger,
          }));
      case "transfer":
        return transfer(message.browserId);
      case "release": {
        const record = (await session("pending", {}))[message.browserId];
        if (record) {
          await native("action", { id: record.jobId, action: "pause" }).catch(
            () => {},
          );
          if (record.pausedByUs)
            await chrome.downloads.resume(Number(message.browserId));
          await serialize(async () => {
            const p = await session("pending", {});
            delete p[message.browserId];
            await chrome.storage.session.set({ pending: p });
          });
        }
        return true;
      }
      case "reconcile":
        await reconcile();
        return true;
      default:
        throw new Error("Unsupported extension request.");
    }
  })();
  task.then(
    (data) => reply({ ok: true, data }),
    (e) => reply({ ok: false, error: e.message || String(e) }),
  );
  return true;
});

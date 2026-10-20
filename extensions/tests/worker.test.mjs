import test from "node:test";
import assert from "node:assert/strict";
const event = () => ({
  listeners: [],
  addListener(fn) {
    this.listeners.push(fn);
  },
});
let serial = 0;
async function fixture(options = {}) {
  const store = { local: {}, session: {} },
    calls = [],
    downloads = new Map([
      [
        7,
        {
          id: 7,
          url: "https://files.test/file.zip",
          finalUrl: "https://files.test/file.zip",
          referrer: "https://files.test/",
          filename: "C:\\Downloads\\file.zip",
          danger: "safe",
          state: "in_progress",
          paused: false,
          totalBytes: 4000000,
          startTime: new Date().toISOString(),
          ...options.original,
        },
      ],
    ]);
  let job = {
    id: "job-1",
    filename: "file.zip",
    status: "downloading",
    downloaded: 100,
    total: 4000000,
  };
  const area = (key) => ({
    async get(name) {
      if (name === null) return structuredClone(store[key]);
      const result = {};
      for (const field of Array.isArray(name) ? name : [name])
        if (store[key][field] !== undefined)
          result[field] = structuredClone(store[key][field]);
      return result;
    },
    async set(data) {
      Object.assign(store[key], structuredClone(data));
    },
    async remove(names) {
      for (const keyName of Array.isArray(names) ? names : [names])
        delete store[key][keyName];
    },
  });
  globalThis.chrome = {
    runtime: {
      id: "test-extension",
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      async sendNativeMessage(_host, request) {
        calls.push(["native", request.operation, request.payload]);
        if (options.offline) throw new Error("Host missing");
        if (options.failOpen && request.operation === "open")
          return { ok: false, error: "Window unavailable" };
        if (options.failAdd && request.operation === "add")
          return { ok: false, error: "Rejected" };
        if (request.operation === "youtube_formats")
          return {
            ok: true,
            data: {
              title: "Video fixture",
              heights: [720, 360],
              audio_available: true,
            },
          };
        if (request.operation === "ping")
          return { ok: true, data: { version: "0.1.0" } };
        if (["add", "youtube"].includes(request.operation))
          return { ok: true, job: { ...job, status: "paused" } };
        if (request.operation === "add_many")
          return {
            ok: true,
            data: {
              added: request.payload.map((p, i) => ({
                ...p,
                id: "batch-" + i,
              })),
              errors: [],
            },
          };
        if (request.operation === "job") {
          if (options.noJob) throw new Error("Unavailable");
          return { ok: true, data: job };
        }
        return { ok: true, data: null };
      },
    },
    storage: { local: area("local"), session: area("session") },
    permissions: {
      onRemoved: event(),
      onAdded: event(),
      async getAll() {
        return { origins: [] };
      },
      async contains() {
        return options.permission !== false;
      },
    },
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      async get(id) {
        return { id, url: "https://files.test/", incognito: false };
      },
      async query() {
        return [];
      },
      async sendMessage() {
        return { items: [] };
      },
    },
    scripting: {
      async unregisterContentScripts() {},
      async registerContentScripts() {},
      async executeScript() {},
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
      async openPopup() {},
    },
    alarms: {
      onAlarm: event(),
      async create() {
        calls.push(["alarm"]);
      },
      async clear() {
        calls.push(["clear-alarm"]);
      },
    },
    contextMenus: { onClicked: event(), async removeAll() {}, create() {} },
    webRequest: { onHeadersReceived: event() },
    downloads: {
      onDeterminingFilename: event(),
      onChanged: event(),
      async search(query) {
        const value = downloads.get(query.id);
        return value ? [structuredClone(value)] : [];
      },
      async pause(id) {
        calls.push(["pause-browser", id]);
        downloads.get(id).paused = true;
      },
      async resume(id) {
        calls.push(["resume-browser", id]);
        downloads.get(id).paused = false;
      },
      async cancel(id) {
        calls.push(["cancel-browser", id]);
        downloads.get(id).state = "interrupted";
      },
    },
  };
  await import("../chromium/background.js?test=" + serial++);
  const handler = chrome.runtime.onMessage.listeners[0];
  const rpc = (
    message,
    sender = {
      id: "test-extension",
      url: "chrome-extension://test-extension/popup.html",
    },
  ) => new Promise((resolve) => handler(message, sender, resolve));
  return {
    store,
    calls,
    downloads,
    rpc,
    setJob(value) {
      job = { ...job, ...value };
    },
    alarms: chrome.alarms.onAlarm,
  };
}
test("worker handoff keeps original paused until verified completion", async () => {
  const f = await fixture();
  const response = await f.rpc({ type: "transfer", browserId: 7 });
  assert.equal(response.ok, true);
  assert.equal(f.downloads.get(7).paused, true);
  assert.equal(
    f.calls.some((c) => c[0] === "cancel-browser"),
    false,
  );
  assert.equal(f.store.session.pending[7].jobId, "job-1");
  await f.rpc({ type: "reconcile" });
  assert.equal(
    f.calls.some((c) => c[0] === "cancel-browser"),
    false,
  );
  f.setJob({
    status: "completed",
    downloaded: 4000000,
    total: 4000000,
    sha256: "a".repeat(64),
  });
  await f.rpc({ type: "reconcile" });
  assert.equal(f.calls.filter((c) => c[0] === "cancel-browser").length, 1);
  assert.deepEqual(f.store.session.pending, {});
});
test("host failure before pause leaves the browser transfer untouched", async () => {
  const f = await fixture({ offline: true });
  assert.equal((await f.rpc({ type: "transfer", browserId: 7 })).ok, false);
  assert.equal(
    f.calls.some((c) => c[0] === "pause-browser"),
    false,
  );
});
test("native admission rejection resumes the browser and clears only its own record", async () => {
  const f = await fixture({ failAdd: true });
  assert.equal((await f.rpc({ type: "transfer", browserId: 7 })).ok, false);
  assert.equal(f.downloads.get(7).paused, false);
  assert.equal(
    f.calls.some((c) => c[0] === "cancel-browser"),
    false,
  );
  assert.deepEqual(f.store.session.pending, {});
});
test("failed engine transfer restores the original without cancelling it", async () => {
  const f = await fixture();
  await f.rpc({ type: "transfer", browserId: 7 });
  f.setJob({ status: "failed" });
  await f.rpc({ type: "reconcile" });
  assert.equal(f.downloads.get(7).paused, false);
  assert.equal(
    f.calls.some((c) => c[0] === "cancel-browser"),
    false,
  );
});
test("completed response with a different size restores the browser original", async () => {
  const f = await fixture();
  await f.rpc({ type: "transfer", browserId: 7 });
  f.setJob({
    status: "completed",
    total: 250,
    downloaded: 250,
    sha256: "a".repeat(64),
  });
  await f.rpc({ type: "reconcile" });
  assert.equal(f.downloads.get(7).paused, false);
  assert.equal(
    f.calls.some((c) => c[0] === "cancel-browser"),
    false,
  );
});
test("duplicate transfer request cannot erase an existing ownership record", async () => {
  const f = await fixture();
  await f.rpc({ type: "transfer", browserId: 7 });
  const original = structuredClone(f.store.session.pending[7]);
  assert.equal((await f.rpc({ type: "transfer", browserId: 7 })).ok, false);
  assert.deepEqual(f.store.session.pending[7], original);
});
test("an originally paused browser job remains paused after engine failure", async () => {
  const f = await fixture({ original: { paused: true } });
  await f.rpc({ type: "transfer", browserId: 7 });
  f.setJob({ status: "failed" });
  await f.rpc({ type: "reconcile" });
  assert.equal(f.downloads.get(7).paused, true);
  assert.equal(
    f.calls.some((c) => c[0] === "resume-browser"),
    false,
  );
});
test("unavailable native host during monitoring restores after three failed checks", async () => {
  const f = await fixture({ noJob: true });
  await f.rpc({ type: "transfer", browserId: 7 });
  await f.rpc({ type: "reconcile" });
  await f.rpc({ type: "reconcile" });
  assert.equal(f.downloads.get(7).paused, true);
  await f.rpc({ type: "reconcile" });
  assert.equal(f.downloads.get(7).paused, false);
});
test("content scripts cannot invoke native controls or browser capture", async () => {
  const f = await fixture(),
    sender = {
      id: "test-extension",
      url: "https://files.test/",
      tab: { id: 1, url: "https://files.test/" },
    };
  assert.equal(
    (await f.rpc({ type: "native", operation: "open" }, sender)).ok,
    false,
  );
  assert.equal(
    (await f.rpc({ type: "transfer", browserId: 7 }, sender)).ok,
    false,
  );
  assert.equal(f.calls.length, 0);
});
test("unknown-size and dangerous browser downloads are never paused", async () => {
  for (const original of [
    { totalBytes: -1 },
    { danger: "dangerous" },
    { incognito: true },
  ]) {
    const f = await fixture({ original });
    assert.equal((await f.rpc({ type: "transfer", browserId: 7 })).ok, false);
    assert.equal(
      f.calls.some((c) => c[0] === "pause-browser"),
      false,
    );
  }
});
test("disabling integration restores extension-owned browser handoffs", async () => {
  const f = await fixture();
  await f.rpc({ type: "transfer", browserId: 7 });
  await f.rpc({
    type: "settings",
    value: { enabled: false, overlay: false, autoCapture: false },
  });
  assert.equal(f.downloads.get(7).paused, false);
  assert.deepEqual(f.store.session.pending, {});
});
test("explicit extension download starts the engine and opens the desktop window", async () => {
  const f = await fixture();
  const result = await f.rpc({
    type: "send",
    candidate: { url: "https://files.test/a.zip" },
    tabId: 1,
  });
  assert.equal(result.ok, true);
  assert.ok(f.calls.find((c) => c[1] === "add"));
  assert.ok(f.calls.find((c) => c[1] === "open"));
});
test("a desktop launch failure does not lose a successfully admitted download", async () => {
  const f = await fixture({ failOpen: true });
  const result = await f.rpc({
    type: "send",
    candidate: { url: "https://files.test/a.zip" },
    tabId: 1,
  });
  assert.equal(result.ok, true);
  assert.match(result.data.launchWarning, /Window unavailable/);
});
test("batch download opens the desktop once for the selected group", async () => {
  const f = await fixture();
  const result = await f.rpc({
    type: "send-many",
    items: [
      { url: "https://files.test/a.zip" },
      { url: "https://files.test/b.zip" },
    ],
    tabId: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.added.length, 2);
  assert.equal(f.calls.filter((c) => c[1] === "open").length, 1);
});
test("YouTube sends a typed extraction job instead of downloading the watch-page HTML", async () => {
  const f = await fixture();
  const result = await f.rpc({
    type: "send",
    candidate: {
      url: "https://www.youtube.com/watch?v=BaW_jenozKc",
      media: { mode: "audio", max_height: 720 },
    },
    tabId: 1,
  });
  assert.equal(result.ok, true);
  const call = f.calls.find((c) => c[0] === "native" && c[1] === "youtube");
  assert.ok(call);
  assert.deepEqual(call[2].media, { mode: "audio", max_height: 720 });
  assert.equal(
    f.calls.some((c) => c[1] === "add"),
    false,
  );
  assert.ok(f.calls.some((c) => c[1] === "open"));
});
test("YouTube output preferences remain bounded and persistent", async () => {
  const f = await fixture();
  await f.rpc({ type: "media-settings", mode: "audio", height: 999999 });
  const state = await f.rpc({ type: "state", tabId: 1 });
  assert.equal(state.data.config.youtubeMode, "audio");
  assert.equal(state.data.config.youtubeHeight, 1080);
});

test("player MP3 and quality choices reach the native engine unchanged", async () => {
  for (const media of [
    { mode: "mp3", max_height: 1080 },
    { mode: "video", max_height: 480 },
  ]) {
    const f = await fixture();
    const result = await f.rpc({
      type: "send",
      candidate: { url: "https://www.youtube.com/watch?v=BaW_jenozKc", media },
      tabId: 1,
    });
    assert.equal(result.ok, true);
    const call = f.calls.find((c) => c[0] === "native" && c[1] === "youtube");
    assert.deepEqual(call[2].media, media);
  }
});

test("format discovery is read-only, cached, and limited to the current YouTube page", async () => {
  const f = await fixture();
  const url = "https://www.youtube.com/watch?v=BaW_jenozKc";
  const sender = { id: "test-extension", url, tab: { id: 1, url } };
  const response = await f.rpc({ type: "video-formats", url }, sender);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.heights, [720, 360]);
  await f.rpc({ type: "video-formats", url }, sender);
  assert.equal(f.calls.filter((c) => c[1] === "youtube_formats").length, 1);
  assert.equal(
    f.calls.some((c) => ["add", "youtube", "open"].includes(c[1])),
    false,
  );
  assert.equal(
    (
      await f.rpc(
        {
          type: "video-formats",
          url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
        },
        sender,
      )
    ).ok,
    false,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
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
} from "../chromium/policy.js";
test("only HTTP(S) without embedded credentials can leave the browser", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///C:/secret",
    "blob:https://a.test/id",
    "data:text/plain,test",
    "https://user:pass@a.test/file",
    "x".repeat(8200),
  ])
    assert.equal(httpUrl(url), null);
  assert.equal(
    httpUrl("https://a.test/file?signature=abc#fragment"),
    "https://a.test/file?signature=abc",
  );
});
test("domain exclusions respect hostname boundaries and subdomains", () => {
  assert.equal(
    hostExcluded("https://cdn.example.org/file", "example.org"),
    true,
  );
  assert.equal(
    hostExcluded("https://notexample.org/file", "example.org"),
    false,
  );
  assert.equal(
    hostExcluded("https://example.org.evil.test/file", "example.org"),
    false,
  );
  assert.equal(
    hostExcluded("https://A.Example.org/file", "*.example.org"),
    true,
  );
});
test("adaptive streams and fragments are classified instead of downloading playlist text", () => {
  assert.equal(kind("https://a.test/v.m3u8?sig=abc"), "stream");
  assert.equal(kind("https://a.test/watch", "application/dash+xml"), "stream");
  assert.equal(kind("https://a.test/v.m4s"), "segment");
  assert.equal(kind("https://a.test/v.mp4"), "media");
  assert.throws(() => nativePayload({ url: "https://a.test/v.m3u8" }));
});
test("candidate normalization deduplicates without destroying signed URL query strings", () => {
  const items = normalizeCandidates([
    { url: "https://a.test/v.mp4?sig=1#x" },
    { url: "https://a.test/v.mp4?sig=1", size: 23 },
    { url: "https://a.test/v.mp4?sig=2" },
    { url: "javascript:no" },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].size, 23);
  assert.ok(items[1].url.endsWith("sig=2"));
  assert.equal(
    normalizeCandidates(
      Array.from({ length: 300 }, (_, i) => ({ url: "https://a.test/" + i })),
    ).length,
    200,
  );
});
test("native request forwards only explicitly supported fields and an origin-only referrer", () => {
  const data = nativePayload(
    {
      url: "https://a.test/v.mp4",
      cookies: "private",
      authorization: "private",
      name: "Video",
    },
    "https://page.test/private?token=secret",
    true,
  );
  assert.deepEqual(Object.keys(data).sort(), [
    "description",
    "later",
    "referer",
    "url",
  ]);
  assert.equal(data.referer, "https://page.test/");
  assert.equal(data.later, true);
});
const now = Date.now(),
  browser = {
    id: 1,
    url: "https://a.test/file.zip",
    filename: "C:\\Downloads\\file.zip",
    state: "in_progress",
    danger: "safe",
    totalBytes: 4000000,
    startTime: new Date(now).toISOString(),
    paused: false,
  };
test("automatic handoff is opt-in and filters unsafe/private/unknown-size downloads", () => {
  assert.equal(captureEligible(browser, DEFAULTS, now), false);
  const cfg = { ...DEFAULTS, autoCapture: true };
  assert.equal(captureEligible(browser, cfg, now), true);
  for (const change of [
    { incognito: true },
    { danger: "dangerous" },
    { byExtensionId: "other" },
    { paused: true },
    { totalBytes: -1 },
    { state: "complete" },
    { startTime: "invalid" },
    { startTime: new Date(now - 120000).toISOString() },
  ])
    assert.equal(captureEligible({ ...browser, ...change }, cfg, now), false);
  assert.equal(
    captureEligible(browser, { ...cfg, excludedHosts: "a.test" }, now),
    false,
  );
});
test("a native acknowledgement or partial transfer never cancels the original", () => {
  const original = { ...browser, paused: true };
  assert.equal(transferDecision({ status: "downloading" }, original), "wait");
  assert.equal(transferDecision(null, original), "wait");
  for (const status of ["failed", "cancelled", "paused"])
    assert.equal(transferDecision({ status }, original), "restore");
  assert.equal(
    transferDecision(
      {
        status: "completed",
        sha256: "a".repeat(64),
        total: 4000000,
        downloaded: 4000000,
      },
      original,
    ),
    "complete",
  );
  assert.equal(
    transferDecision(
      {
        status: "completed",
        sha256: "a".repeat(64),
        total: 999,
        downloaded: 999,
      },
      original,
    ),
    "restore",
  );
  assert.equal(transferDecision({ status: "completed" }, original), "restore");
  assert.equal(
    transferDecision({ status: "completed" }, { ...original, paused: false }),
    "release",
  );
});
test("YouTube video URLs use a canonical single-video URL and typed media options", () => {
  assert.equal(
    youtubeVideoUrl("https://youtu.be/BaW_jenozKc?list=abc"),
    "https://www.youtube.com/watch?v=BaW_jenozKc",
  );
  assert.equal(kind("https://www.youtube.com/shorts/BaW_jenozKc"), "youtube");
  assert.equal(
    youtubeVideoUrl("https://youtube.com.evil.test/watch?v=BaW_jenozKc"),
    null,
  );
  assert.equal(youtubeVideoUrl("https://youtube.com/playlist?list=abc"), null);
  const payload = nativePayload(
    {
      url: "https://www.youtube.com/watch?v=BaW_jenozKc",
      media: { mode: "audio", max_height: 720 },
    },
    null,
  );
  assert.deepEqual(payload.media, { mode: "audio", max_height: 720 });
});

test("MP3 stays a typed audio choice and video heights remain bounded", () => {
  const url = "https://www.youtube.com/watch?v=BaW_jenozKc";
  assert.deepEqual(
    nativePayload({ url, media: { mode: "mp3", max_height: 720 } }, null).media,
    { mode: "mp3", max_height: 720 },
  );
  assert.deepEqual(
    nativePayload({ url, media: { mode: "video", max_height: 999999 } }, null)
      .media,
    { mode: "video", max_height: 1080 },
  );
});

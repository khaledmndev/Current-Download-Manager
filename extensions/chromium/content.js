// Original isolated-world scanner. It does not patch fetch/XHR or read cookies.
(() => {
  if (globalThis.__currentContent) return;
  globalThis.__currentContent = true;
  let timer,
    overlay = true,
    enabled = true,
    youtubeMode = "video",
    youtubeHeight = 1080,
    active = null,
    lastSignature = "",
    host,
    button,
    message,
    menu,
    menuMedia = null,
    dismissedMedia = null,
    sending = false;
  const clean = (value) => {
    try {
      const u = new URL(value, document.baseURI);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.href.length > 8192
      )
        return null;
      u.hash = "";
      return u.href;
    } catch {
      return null;
    }
  };
  const stream = (url) => /\.(m3u8|mpd|m4s|ts)(?:[?#]|$)/i.test(url);
  const mediaSources = (element) =>
    [
      element.currentSrc,
      element.src,
      ...[...element.querySelectorAll("source")].map((s) => s.src),
    ].filter(Boolean);
  function youtubePage() {
    try {
      const u = new URL(location.href),
        parts = u.pathname.split("/").filter(Boolean);
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
    } catch {
      return null;
    }
  }
  function requestUrl(element) {
    return (
      youtubePage() ||
      mediaSources(element)
        .map(clean)
        .find((value) => value && !stream(value))
    );
  }
  function pickMedia() {
    const visible = [...document.querySelectorAll("video,audio")]
      .slice(0, 100)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ element, rect }) =>
          rect.width >= 140 &&
          rect.height >= (element.tagName === "AUDIO" ? 24 : 70) &&
          rect.bottom > 0 &&
          rect.top < innerHeight,
      );
    if (!visible.some((v) => v.element === active))
      active =
        visible.sort(
          (a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height,
        )[0]?.element || null;
    if (active) createOverlay();
  }
  function scan(selected = false) {
    const items = [],
      seen = new Set(),
      selection = getSelection();
    let blob = 0,
      protectedCount = 0,
      examined = 0;
    function add(value, name, mime, source) {
      const url = clean(value);
      if (!url || seen.has(url) || items.length >= 200) return;
      seen.add(url);
      items.push({
        url,
        name: String(name || "").slice(0, 180),
        mime: mime || "",
        source,
      });
    }
    function chosen(node) {
      if (!selected) return true;
      if (!selection?.rangeCount || selection.isCollapsed) return false;
      for (let i = 0; i < selection.rangeCount; i++) {
        try {
          if (selection.getRangeAt(i).intersectsNode(node)) return true;
        } catch {}
      }
      return false;
    }
    if (!selected && youtubePage())
      add(youtubePage(), document.title, "", "YouTube page");
    for (const element of document.querySelectorAll(
      "a[href],video,audio,img",
    )) {
      if (++examined > 10000 || items.length >= 200) break;
      if (!chosen(element)) continue;
      if (element.matches("a"))
        add(
          element.href,
          element.download || element.textContent.trim(),
          "",
          element.download ? "download link" : "page link",
        );
      else if (element.matches("img")) {
        if (element.closest("a[download]"))
          add(
            element.currentSrc || element.src,
            element.alt,
            "image/*",
            "image",
          );
      } else {
        if (element.mediaKeys) {
          protectedCount++;
          continue;
        }
        for (const value of mediaSources(element)) {
          if (value.startsWith("blob:")) blob++;
          else
            add(
              value,
              element.title || document.title,
              element.getAttribute("type") ||
                element.querySelector("source[type]")?.type ||
                "",
              element.tagName.toLowerCase(),
            );
        }
      }
    }
    return { items, blob, protected: protectedCount };
  }
  function createOverlay() {
    if (host) return;
    host = document.createElement("div");
    host.dataset.currentOverlay = "";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;display:none;max-width:300px;";
    const shadow = host.attachShadow({ mode: "closed" }),
      style = document.createElement("style");
    style.textContent =
      "[hidden]{display:none!important}.menu{display:grid;background:#fbfbf8;border:1px solid #d6dfd5;border-radius:8px;padding:5px;margin-top:5px;box-shadow:0 8px 24px #0003;width:270px;max-height:390px;overflow:auto}.menu button{border:0;background:transparent;color:#123e33;text-align:left;padding:9px 10px;max-width:none;border-radius:4px;display:block;width:100%;font-weight:500}.menu button:hover,.menu button:focus-visible{background:#e5eee3}.menu .audio{border-top:1px solid #d6dfd5;margin-top:4px;padding-top:12px;font-weight:650}.menu p{font:11px/1.45 Segoe UI,Arial,sans-serif;color:#667567;margin:8px 10px}.controls{display:flex;align-items:stretch;gap:3px}.close{padding:4px 9px;font-size:18px;line-height:1;min-width:30px;background:#123e33}.close:hover{background:#235646}button:focus-visible{outline:2px solid #a9f3bd;outline-offset:2px}:host{font-family:Segoe UI,Arial,sans-serif}button{font:600 12px/1.4 Segoe UI,Arial,sans-serif;color:#fff;background:#356744;border:1px solid #d6dfd5;border-radius:5px;padding:8px 12px;cursor:pointer;max-width:280px}button:hover{background:#285336}button:disabled{background:#555b55;cursor:default}span{display:block;background:#fbfbf8;color:#303a32;padding:8px;font:12px/1.4 Segoe UI,Arial,sans-serif;border-radius:4px;margin-top:4px;overflow-wrap:anywhere}span:empty{display:none}";
    const controls = document.createElement("div");
    controls.className = "controls";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.textContent = "\u00d7";
    close.setAttribute("aria-label", "Hide Current for this video");
    close.title = "Hide for this video. Refresh the page to show it again.";
    close.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissedMedia = active && (requestUrl(active) || active);
      host.style.display = "none";
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      message.textContent = "";
    });
    button = document.createElement("button");
    button.type = "button";
    button.textContent = "Download with Current";
    message = document.createElement("span");
    message.setAttribute("role", "status");
    menu = document.createElement("div");
    menu.className = "menu";
    menu.id = "current-download-options";
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.setAttribute(
      "aria-label",
      "Choose download format and maximum video quality",
    );
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-controls", menu.id);
    button.setAttribute("aria-expanded", "false");
    const hideMenu = () => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    async function send(media) {
      if (sending) return;
      const element = active;
      if (!element || element.mediaKeys) return;
      const url = requestUrl(element);
      if (!url) return;
      hideMenu();
      sending = true;
      button.disabled = true;
      message.textContent = "Sending to Current...";
      try {
        const response = await chrome.runtime.sendMessage({
          type: "send",
          candidate: {
            url,
            name: element.title || document.title,
            media: youtubePage() ? media : undefined,
          },
        });
        if (!response?.ok)
          throw new Error(response?.error || "No connection to Current.");
        message.textContent = response.data?.launchWarning
          ? "Download added. " + response.data.launchWarning
          : "Added to Current.";
      } catch (e) {
        message.textContent = String(e.message || e).slice(0, 220);
      } finally {
        sending = false;
        button.disabled = false;
      }
    }
    const addChoice = (label, media, className = "") => {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.className = className;
      item.setAttribute("role", "menuitem");
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.disabled) {
          button.focus();
          void send(media);
        }
      });
      menu.append(item);
    };
    async function loadMenu() {
      const url = youtubePage();
      menuMedia = requestUrl(active);
      menu.replaceChildren();
      const loading = document.createElement("p");
      loading.textContent = "Checking this video's available qualities...";
      loading.setAttribute("role", "status");
      menu.append(loading);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "video-formats",
          url,
        });
        if (!response?.ok)
          throw new Error(response?.error || "Could not read video qualities.");
        if (youtubePage() !== url || menuMedia !== url) return;
        const info = response.data;
        if (!Array.isArray(info?.heights))
          throw new Error(
            "Reopen the updated Current engine to detect video qualities.",
          );
        menu.replaceChildren();
        const heights = [
          ...new Set(
            info.heights.filter(
              (h) => Number.isInteger(h) && h >= 32 && h <= 8640,
            ),
          ),
        ].sort((a, b) => b - a);
        for (const height of heights) {
          const tag = height >= 2160 ? " UHD" : height >= 720 ? " HD" : "";
          addChoice(`MP4 - ${height}p${tag}`, {
            mode: "video",
            max_height: height,
          });
        }
        if (info.audio_available) {
          addChoice(
            "MP3 - audio only",
            { mode: "mp3", max_height: 1080 },
            "audio",
          );
          addChoice("M4A - audio only", { mode: "audio", max_height: 1080 });
        }
        const note = document.createElement("p");
        note.textContent =
          "Only qualities detected for this video are shown. MP3 converts its audio.";
        menu.append(note);
        if (!menu.hidden) menu.querySelector("button")?.focus();
      } catch (error) {
        if (youtubePage() !== url || menuMedia !== url) return;
        menu.replaceChildren();
        const note = document.createElement("p");
        note.textContent = String(error.message || error).slice(0, 220);
        note.setAttribute("role", "alert");
        menu.append(note);
      }
      position();
    }
    menu.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll("button")];
      const index = items.indexOf(menu.getRootNode().activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        hideMenu();
        button.focus();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                items.length;
        items[next]?.focus();
      }
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!youtubePage()) {
        void send();
        return;
      }
      menuMedia = requestUrl(active);
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
      message.textContent = "";
      position();
      if (!menu.hidden) void loadMenu();
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideMenu();
      if (event.key === "ArrowDown" && youtubePage() && !button.disabled) {
        event.preventDefault();
        menuMedia = requestUrl(active);
        menu.hidden = false;
        button.setAttribute("aria-expanded", "true");
        position();
        void loadMenu();
      }
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(host)) hideMenu();
      },
      true,
    );
    controls.append(button, close);
    shadow.append(style, controls, menu, message);
    (document.body || document.documentElement).append(host);
  }
  function position() {
    pickMedia();
    if (
      !host ||
      !active ||
      !active.isConnected ||
      !enabled ||
      !overlay ||
      (dismissedMedia && dismissedMedia === (requestUrl(active) || active)) ||
      document.fullscreenElement
    ) {
      if (host) host.style.display = "none";
      return;
    }
    const rect = active.getBoundingClientRect();
    if (
      rect.width < 140 ||
      rect.height < (active.tagName === "AUDIO" ? 24 : 70) ||
      rect.bottom < 0 ||
      rect.top > innerHeight
    ) {
      host.style.display = "none";
      return;
    }
    host.style.display = "block";
    host.style.top = Math.max(4, rect.top + 8) + "px";
    host.style.left =
      Math.max(4, Math.min(innerWidth - 285, rect.right - 285)) + "px";
    const direct = requestUrl(active);
    if (menuMedia !== direct && !menu.hidden) {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    menu.style.maxHeight =
      Math.max(
        130,
        Math.min(390, innerHeight - Math.max(4, rect.top + 8) - 60),
      ) + "px";
    button.disabled = sending || Boolean(active.mediaKeys) || !direct;
    button.textContent = active.mediaKeys
      ? "Protected media"
      : direct
        ? "Download with Current"
        : "Current: stream not supported yet";
    button.title = active.mediaKeys
      ? "Protected playback cannot be downloaded."
      : youtubePage()
        ? "Choose video quality or MP3 audio before starting the download."
        : direct
          ? "Start a download in Current."
          : "This player exposes no supported direct media URL.";
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(report, 500);
  }
  async function report() {
    try {
      const result = scan(),
        signature = JSON.stringify(result);
      if (signature === lastSignature) return;
      lastSignature = signature;
      const response = await chrome.runtime.sendMessage({
        type: "report",
        items: result.items,
      });
      enabled = Boolean(response?.ok);
      overlay = response?.data?.overlay !== false;
      youtubeMode = response?.data?.youtubeMode || "video";
      youtubeHeight = response?.data?.youtubeHeight || 1080;
      position();
    } catch {
      enabled = false;
      position();
    }
  }
  chrome.runtime.onMessage.addListener((request, _sender, reply) => {
    if (request.type === "scan") {
      reply(scan(Boolean(request.selected)));
      return;
    }
    if (request.type === "preferences") {
      enabled = request.enabled;
      if (!overlay && request.overlay) dismissedMedia = null;
      overlay = request.overlay;
      position();
    }
  });
  document.addEventListener(
    "pointerover",
    (event) => {
      const media = event.target.closest?.("video,audio");
      if (media) {
        active = media;
        createOverlay();
        message.textContent = "";
        position();
      }
    },
    true,
  );
  for (const event of [
    "loadedmetadata",
    "play",
    "durationchange",
    "encrypted",
    "yt-navigate-finish",
  ])
    document.addEventListener(event, schedule, true);
  let positionFrame = 0;
  const reposition = () => {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(() => {
      positionFrame = 0;
      position();
    });
  };
  window.addEventListener("scroll", reposition, { passive: true });
  window.addEventListener("resize", reposition, { passive: true });
  document.addEventListener("fullscreenchange", reposition);
  new MutationObserver((records) => {
    if (records.some((record) => !host || !host.contains(record.target)))
      schedule();
  }).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "href"],
  });
  chrome.runtime
    .sendMessage({ type: "content-config" })
    .then((response) => {
      enabled = Boolean(response?.ok);
      overlay = response?.data?.overlay !== false;
      youtubeMode = response?.data?.youtubeMode || "video";
      youtubeHeight = response?.data?.youtubeHeight || 1080;
      position();
    })
    .catch(() => {
      enabled = false;
    });
  schedule();
})();

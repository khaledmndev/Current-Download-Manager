import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowSquareOut,
  ArrowsClockwise,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Copy,
  DownloadSimple,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FilmStrip,
  Folder,
  Folders,
  GearSix,
  Globe,
  Info,
  Lightning,
  List,
  MagnifyingGlass,
  Moon,
  Pause,
  Play,
  Plus,
  PuzzlePiece,
  Queue,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash,
  X,
} from "@phosphor-icons/react";
import "./style.css";

type Job = {
  media?: { mode: "video" | "audio" | "mp3"; max_height: number } | null;
  id: string;
  url: string;
  filename: string;
  folder: string;
  category: string;
  queue: string;
  status: string;
  total: number | null;
  downloaded: number;
  speed: number;
  connections: number;
  resumable: boolean;
  created_at: string;
  error: string | null;
  sha256: string | null;
  description: string;
  start_at: string | null;
};
type Settings = {
  download_folder: string;
  max_active: number;
  connections: number;
  speed_limit: number;
  language: string;
  theme: string;
  show_completed: boolean;
};
type Snapshot = {
  jobs: Job[];
  settings: Settings;
  plan: {
    name: string;
    development: boolean;
    max_active: number;
    max_connections: number;
    paid_features: boolean;
    billing_available: boolean;
  };
  version: string;
  engine: string;
};
type AddForm = {
  media_mode: "video" | "audio" | "mp3";
  media_height: number;
  url: string;
  filename: string;
  folder: string;
  later: boolean;
  queue: string;
  description: string;
  expected_sha256: string;
  start_at: string;
};
const defaultSettings: Settings = {
  download_folder: "",
  max_active: 2,
  connections: 2,
  speed_limit: 0,
  language: "en",
  theme: "light",
  show_completed: true,
};
const activeStatuses = [
  "probing",
  "downloading",
  "pausing",
  "assembling",
  "verifying",
];
const blank: AddForm = {
  media_mode: "video",
  media_height: 1080,
  url: "",
  filename: "",
  folder: "",
  later: false,
  queue: "Main queue",
  description: "",
  expected_sha256: "",
  start_at: "",
};
const categories = [
  "Video",
  "Music",
  "Documents",
  "Archives",
  "Programs",
  "Images",
  "Other",
];
function youtubeLink(value: string) {
  try {
    const url = new URL(value);
    return [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
      "www.youtu.be",
    ].includes(url.hostname);
  } catch {
    return false;
  }
}
const arabic: Record<string, string> = {
  Downloads: "التنزيلات",
  Queues: "قوائم الانتظار",
  Settings: "الإعدادات",
  Plans: "الخطط",
  Browsers: "المتصفحات",
  "All files": "كل الملفات",
  Active: "نشط",
  Paused: "متوقف",
  Completed: "مكتمل",
  "Add download": "إضافة تنزيل",
  Batch: "مجموعة",
  "Pause all": "إيقاف الكل",
  "Resume all": "استئناف الكل",
  "Search files…": "ابحث عن الملفات…",
  "File name": "اسم الملف",
  Status: "الحالة",
  Size: "الحجم",
  Speed: "السرعة",
  "Your download library": "مكتبة التنزيلات",
  "Files arrive here, organized and ready.": "تظهر ملفاتك هنا، منظمة وجاهزة.",
  "Add your first download": "أضف تنزيلك الأول",
  Video: "الفيديو",
  Music: "الموسيقى",
  Documents: "المستندات",
  Archives: "الأرشيف",
  Programs: "البرامج",
  Images: "الصور",
  Other: "أخرى",
  Transferred: "تم نقله",
  "Active transfers": "التنزيلات النشطة",
  "Transfer speed": "سرعة النقل",
  "Files completed": "ملفات مكتملة",
  "Background engine connected": "محرك التنزيل متصل",
  Pause: "إيقاف مؤقت",
  Resume: "استئناف",
  Restart: "إعادة البدء",
  Remove: "إزالة",
  Cancel: "إلغاء",
  Save: "حفظ",
  Close: "إغلاق",
  "Download link": "رابط التنزيل",
  "Save to": "الحفظ في",
  "File name (optional)": "اسم الملف (اختياري)",
  "Download now": "تنزيل الآن",
  "Add to queue": "إضافة إلى القائمة",
  "Start paused": "الإضافة متوقفة",
  "Advanced options": "خيارات إضافية",
  Description: "الوصف",
  "Expected SHA-256 (optional)": "بصمة SHA-256 المتوقعة (اختياري)",
  "Scheduled start (Pro)": "موعد البدء (برو)",
  "Main queue": "القائمة الرئيسية",
  "No files match": "لا توجد ملفات مطابقة",
  "Try another search or filter.": "جرّب بحثًا أو تصفية أخرى.",
  "Open folder": "فتح المجلد",
  "Copy link": "نسخ الرابط",
  "File details": "تفاصيل الملف",
  Destination: "الوجهة",
  Source: "المصدر",
  "Resume support": "دعم الاستئناف",
  Yes: "نعم",
  Unknown: "غير معروف",
  Connections: "الاتصالات",
  "Export library": "تصدير المكتبة",
  "Import library": "استيراد المكتبة",
  "Connection settings": "إعدادات الاتصال",
  "Concurrent files": "الملفات المتزامنة",
  "Connections per file": "الاتصالات لكل ملف",
  "Speed limit (KB/s)": "حد السرعة (ك.ب/ث)",
  "0 means unlimited": "0 يعني بلا حد",
  Appearance: "المظهر",
  Language: "اللغة",
  "Download folder": "مجلد التنزيلات",
  Light: "فاتح",
  Dark: "داكن",
  "Save settings": "حفظ الإعدادات",
  Queued: "في الانتظار",
  Downloading: "جارٍ التنزيل",
  Probing: "جارٍ الاتصال",
  Pausing: "جارٍ الإيقاف",
  Assembling: "جارٍ التجميع",
  Verifying: "جارٍ التحقق",
  Failed: "فشل",
  Cancelled: "ملغى",
  "Local-first downloads.": "تنزيلات محفوظة محليًا.",
  "No uploads. No bandwidth caps.": "دون رفع للملفات أو حدود لنقل البيانات.",
  "Working quietly in the background.": "يعمل بهدوء في الخلفية.",
  "Recent activity": "النشاط الأخير",
  "Select a file to see its details.": "اختر ملفًا لعرض تفاصيله.",
};
const formatBytes = (n: number | null) => {
  if (n == null) return "—";
  if (n === 0) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
};
const iconFor = (category: string) =>
  category === "Video"
    ? FilmStrip
    : category === "Music"
      ? FileAudio
      : category === "Documents"
        ? FileText
        : category === "Archives"
          ? FileArchive
          : category === "Images"
            ? FileImage
            : File;

async function rpc(operation: string, payload: unknown = null) {
  if ("__TAURI_INTERNALS__" in window)
    return invoke<any>("rpc", { operation, payload });
  const response = await fetch("/__rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, payload }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "The local engine is unavailable.");
  return data;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [view, setView] = useState("Downloads"),
    [filter, setFilter] = useState("All files"),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [modal, setModal] = useState<"add" | "batch" | "settings" | null>(null),
    [form, setForm] = useState<AddForm>(blank),
    [batch, setBatch] = useState(""),
    [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [connectionError, setConnectionError] = useState(""),
    [settings, setSettings] = useState(defaultSettings),
    [sort, setSort] = useState<"newest" | "name" | "size">("newest");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isArabic = snapshot?.settings.language === "ar";
  const t = (key: string) => (isArabic ? arabic[key] || key : key);
  const notify = useCallback((text: string, error = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(
      () => setNotice(null),
      error ? 10000 : 4000,
    );
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc("snapshot");
      setSnapshot(next);
      setConnectionError("");
    } catch (e) {
      setConnectionError(
        "The background engine is unavailable. Reconnect or restart Current.",
      );
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const selector =
      "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary";
    dialog?.querySelector<HTMLElement>("input,textarea,button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(selector),
      ).filter((e) => e.offsetParent !== null);
      const first = elements[0],
        last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal]);
  useEffect(() => {
    document.documentElement.lang = isArabic ? "ar" : "en";
    document.documentElement.dir = isArabic ? "rtl" : "ltr";
    document.documentElement.dataset.theme =
      snapshot?.settings.theme || "light";
  }, [isArabic, snapshot?.settings.theme]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        openAdd();
      }
      if (e.key === "Escape") {
        if (busy) return;
        setModal(null);
        setSelected(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  const openAdd = () => {
    setForm({ ...blank, folder: snapshot?.settings.download_folder || "" });
    setModal("add");
  };
  const action = async (id: string, action: string) => {
    try {
      await rpc("action", { id, action });
      await refresh();
    } catch (e) {
      notify(String(e), true);
    }
  };
  const bulk = async (operation: string) => {
    try {
      await rpc(operation);
      await refresh();
    } catch (e) {
      notify(String(e), true);
    }
  };
  const pickFolder = async (target: "add" | "settings") => {
    try {
      const folder = await invoke<string | null>("choose_folder");
      if (folder) {
        if (target === "add") setForm((f) => ({ ...f, folder }));
        else setSettings((s) => ({ ...s, download_folder: folder }));
      }
    } catch (e) {
      notify(String(e), true);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await rpc("add", {
        ...form,
        filename: form.filename || null,
        folder: form.folder || null,
        expected_sha256: form.expected_sha256 || null,
        start_at: form.start_at ? new Date(form.start_at).toISOString() : null,
        media: youtubeLink(form.url)
          ? { mode: form.media_mode, max_height: form.media_height }
          : null,
      });
      setModal(null);
      notify(form.later ? "Added to paused downloads." : "Download added.");
      await refresh();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const submitBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const urls = batch
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!urls.length) throw new Error("Paste at least one URL.");
      const result = await rpc(
        "add_many",
        urls.map((url) => ({ url })),
      );
      setModal(null);
      notify(
        `${result.added.length} downloads added.${result.errors.length ? ` ${result.errors.length} links were rejected.` : ""}`,
        result.errors.length > 0,
      );
      await refresh();
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await rpc("settings", settings);
      setModal(null);
      await refresh();
      notify("Settings saved. New connection limits apply to new downloads.");
    } catch (e) {
      notify(String(e), true);
    }
  };
  const jobs = snapshot?.jobs || [];
  const active = jobs.filter((j) => activeStatuses.includes(j.status)),
    complete = jobs.filter((j) => j.status === "completed");
  const speed = active.reduce((a, j) => a + j.speed, 0),
    transferred = jobs.reduce((a, j) => a + j.downloaded, 0);
  const filtered = jobs
    .filter(
      (j) =>
        (!category || j.category === category) &&
        (!search ||
          `${j.filename} ${j.description} ${j.url}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (filter === "All files" ||
          (filter === "Active" && activeStatuses.includes(j.status)) ||
          (filter === "Paused" &&
            ["paused", "failed", "cancelled"].includes(j.status)) ||
          (filter === "Completed" && j.status === "completed")),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.filename.localeCompare(b.filename)
        : sort === "size"
          ? (b.total || 0) - (a.total || 0)
          : b.created_at.localeCompare(a.created_at),
    );
  const detail = jobs.find((j) => j.id === selected);
  const statusLabel = (status: string) =>
    t(status.charAt(0).toUpperCase() + status.slice(1));
  const row = (j: Job) => {
    const Icon = iconFor(j.category);
    const progress = j.total
      ? Math.min(100, (j.downloaded / j.total) * 100)
      : 0;
    return (
      <tr
        key={j.id}
        className={selected === j.id ? "selected" : ""}
        onClick={() => setSelected(selected === j.id ? null : j.id)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") setSelected(j.id);
        }}
        aria-label={j.filename}
      >
        <td>
          <div className="file-cell">
            <span className={`file-icon ${j.category.toLowerCase()}`}>
              <Icon size={23} weight="duotone" />
            </span>
            <div className="file-copy">
              <strong title={j.filename}>{j.filename}</strong>
              <span>{j.description || new URL(j.url).hostname}</span>
              {activeStatuses.includes(j.status) && (
                <div className="progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
              )}
            </div>
          </div>
        </td>
        <td>
          <span className={`status ${j.status}`}>
            {j.status === "completed" ? (
              <Check size={12} weight="bold" />
            ) : j.status === "paused" ? (
              <Pause size={11} weight="fill" />
            ) : null}
            {statusLabel(j.status)}
          </span>
          {j.error && (
            <span className="row-error" title={j.error}>
              {j.error}
            </span>
          )}
        </td>
        <td className="numeric">
          {formatBytes(j.total)}
          {activeStatuses.includes(j.status) && j.total ? (
            <small>{progress.toFixed(0)}%</small>
          ) : null}
        </td>
        <td className="numeric rate">
          {j.speed ? `${formatBytes(j.speed)}/s` : "—"}
        </td>
        <td>
          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
            {activeStatuses.includes(j.status) ? (
              <button
                className="icon-button"
                title={t("Pause")}
                onClick={() => void action(j.id, "pause")}
              >
                <Pause size={17} />
              </button>
            ) : j.status !== "completed" ? (
              <button
                className="icon-button"
                title={t("Resume")}
                onClick={() => void action(j.id, "resume")}
              >
                <Play size={17} />
              </button>
            ) : (
              <button
                className="icon-button"
                title={t("Open folder")}
                onClick={() =>
                  void rpc("open_folder", { id: j.id }).catch((e) =>
                    notify(String(e), true),
                  )
                }
              >
                <Folder size={17} />
              </button>
            )}
            <button
              className="icon-button"
              title={t("File details")}
              onClick={() => setSelected(j.id)}
            >
              <CaretRight size={17} />
            </button>
          </div>
        </td>
      </tr>
    );
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img
            className="brand-mark"
            src="/current-icon.svg"
            alt="Current"
            width="40"
            height="40"
          />
          <div>
            <strong>current</strong>
            <small>DOWNLOAD MANAGER</small>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          {[
            { label: "Downloads", icon: DownloadSimple },
            { label: "Queues", icon: Queue },
            { label: "Browsers", icon: PuzzlePiece },
          ].map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={`nav-item ${view === label && !category ? "current" : ""}`}
              onClick={() => {
                setView(label);
                setCategory("");
                setSelected(null);
              }}
            >
              <Icon size={19} />
              <span>{t(label)}</span>
              {label === "Downloads" && <em>{jobs.length}</em>}
            </button>
          ))}
        </nav>
        <div className="workspace-label category-label">LIBRARY</div>
        <nav>
          {categories.map((c) => (
            <button
              key={c}
              className={`nav-item category-nav ${category === c ? "current" : ""}`}
              onClick={() => {
                setCategory(c);
                setView("Downloads");
              }}
            >
              {React.createElement(iconFor(c), { size: 18 })}
              <span>{t(c)}</span>
              <em>{jobs.filter((j) => j.category === c).length || ""}</em>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={18} />
            <span>
              {t("Local-first downloads.")}
              <small>{t("No uploads. No bandwidth caps.")}</small>
            </span>
          </div>
          <button
            className="plan-link"
            onClick={() => {
              setView("Plans");
              setCategory("");
            }}
          >
            <span className="plan-icon">
              <Lightning size={18} weight="fill" />
            </span>
            <span>
              <strong>{snapshot?.plan.name || "Free"}</strong>
              <small>
                {snapshot?.plan.development
                  ? "Development build"
                  : "View available plans"}
              </small>
            </span>
            <CaretRight size={15} />
          </button>
          <button
            className="nav-item"
            onClick={() => {
              setSettings(snapshot?.settings || defaultSettings);
              setModal("settings");
            }}
          >
            <GearSix size={19} />
            <span>{t("Settings")}</span>
            <span className="version">v{snapshot?.version || "0.1.0"}</span>
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <CaretRight size={13} />
            <strong>{t(category || view)}</strong>
          </div>
          <div className="topbar-right">
            <span
              className={`engine-dot ${connectionError ? "offline" : ""}`}
            />
            <span>
              {connectionError
                ? "Connecting to engine…"
                : t("Background engine connected")}
            </span>
            <button
              className="icon-button"
              title="Toggle appearance"
              onClick={() =>
                snapshot &&
                void rpc("settings", {
                  ...snapshot.settings,
                  theme: snapshot.settings.theme === "dark" ? "light" : "dark",
                })
                  .then(refresh)
                  .catch((e) => notify(String(e), true))
              }
            >
              {snapshot?.settings.theme === "dark" ? (
                <Sun size={19} />
              ) : (
                <Moon size={19} />
              )}
            </button>
          </div>
        </header>
        <main>
          {connectionError && (
            <div role="alert" className="connection-alert">
              <Info size={18} />
              <span>{connectionError}</span>
              <button
                onClick={() =>
                  void invoke("reconnect")
                    .then(refresh)
                    .catch((e) => notify(String(e), true))
                }
              >
                Reconnect
              </button>
            </div>
          )}
          {view === "Downloads" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">YOUR SPACE, IN ORDER</p>
                  <h1>
                    {t(category || "Downloads")}
                    <span className="count-badge">
                      {category
                        ? jobs.filter((j) => j.category === category).length
                        : jobs.length}
                    </span>
                  </h1>
                  <p>{t("Working quietly in the background.")}</p>
                </div>
                <button className="primary" onClick={openAdd}>
                  <Plus size={18} weight="bold" />
                  {t("Add download")}
                  <kbd>Ctrl N</kbd>
                </button>
              </div>
              <section className="metrics" aria-label="Transfer overview">
                <div>
                  <span>
                    <ArrowDownRight size={17} />
                    {t("Transfer speed")}
                  </span>
                  <strong>
                    {formatBytes(speed)}
                    <small>/s</small>
                  </strong>
                  <p>
                    {active.length
                      ? `${active.length} ${t("Active transfers").toLowerCase()}`
                      : "Ready when you are"}
                  </p>
                </div>
                <div>
                  <span>
                    <ArrowsClockwise size={17} />
                    {t("Active transfers")}
                  </span>
                  <strong>
                    {String(active.length).padStart(2, "0")}
                    <small>/ {snapshot?.settings.max_active || 2}</small>
                  </strong>
                  <p>
                    {jobs.filter((j) => j.status === "queued").length} waiting
                    in queue
                  </p>
                </div>
                <div>
                  <span>
                    <CheckCircle size={17} />
                    {t("Files completed")}
                  </span>
                  <strong>{String(complete.length).padStart(2, "0")}</strong>
                  <p>
                    {formatBytes(transferred)} {t("Transferred").toLowerCase()}
                  </p>
                </div>
              </section>
              <section className="library-section">
                <div className="library-toolbar">
                  <div className="tabs">
                    {["All files", "Active", "Paused", "Completed"].map((f) => (
                      <button
                        key={f}
                        className={filter === f ? "active" : ""}
                        onClick={() => setFilter(f)}
                      >
                        {t(f)}
                      </button>
                    ))}
                  </div>
                  <div className="utility-buttons">
                    <button
                      className="text-button"
                      onClick={() =>
                        void bulk(active.length ? "pause_all" : "resume_all")
                      }
                    >
                      {active.length ? <Pause size={15} /> : <Play size={15} />}
                      <span>
                        {t(active.length ? "Pause all" : "Resume all")}
                      </span>
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setBatch("");
                        setModal("batch");
                      }}
                    >
                      <List size={17} />
                      {t("Batch")}
                    </button>
                    <button
                      className="icon-button"
                      title={t("Export library")}
                      onClick={() =>
                        void invoke("export_library")
                          .then(
                            (path) =>
                              path && notify(`Library exported to ${path}`),
                          )
                          .catch((e) => notify(String(e), true))
                      }
                    >
                      <ArrowSquareOut size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title={t("Import library")}
                      onClick={() =>
                        void invoke("import_library")
                          .then(refresh)
                          .catch((e) => notify(String(e), true))
                      }
                    >
                      <Folders size={17} />
                    </button>
                  </div>
                </div>
                <div className="search-toolbar">
                  <label className="search">
                    <MagnifyingGlass size={17} />
                    <input
                      aria-label={t("Search files…")}
                      placeholder={t("Search files…")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        className="icon-button"
                        title="Clear search"
                        onClick={() => setSearch("")}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </label>
                  <label className="sort">
                    <SlidersHorizontal size={16} />
                    <select
                      aria-label="Sort files"
                      value={sort}
                      onChange={(e) => setSort(e.target.value as typeof sort)}
                    >
                      <option value="newest">Newest first</option>
                      <option value="name">File name</option>
                      <option value="size">Largest first</option>
                    </select>
                  </label>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("File name")}</th>
                        <th>{t("Status")}</th>
                        <th className="numeric">{t("Size")}</th>
                        <th className="numeric">{t("Speed")}</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>{filtered.map(row)}</tbody>
                  </table>
                  {!filtered.length && (
                    <div className="empty-state">
                      <div className="empty-art">
                        <div className="empty-line" />
                        <span>
                          <ArrowDown size={27} />
                        </span>
                        <div className="empty-line" />
                      </div>
                      <h2>
                        {t(
                          jobs.length
                            ? "No files match"
                            : "Your download library",
                        )}
                      </h2>
                      <p>
                        {t(
                          jobs.length
                            ? "Try another search or filter."
                            : "Files arrive here, organized and ready.",
                        )}
                      </p>
                      {!jobs.length && (
                        <button className="secondary" onClick={openAdd}>
                          <Plus size={16} />
                          {t("Add your first download")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <footer className="table-footer">
                  <span>
                    {filtered.length} files{category ? ` · ${t(category)}` : ""}
                  </span>
                  <span>
                    <ShieldCheck size={14} /> Stored on your device
                  </span>
                </footer>
              </section>
            </>
          )}
          {view === "Queues" && (
            <>
              <PageTitle
                title={t("Queues")}
                description="Keep downloads together. Start or pause a queue in one action."
              />
              <div className="queue-grid">
                {Array.from(
                  new Set(["Main queue", ...jobs.map((j) => j.queue)]),
                ).map((q) => {
                  const items = jobs.filter((j) => j.queue === q);
                  return (
                    <article className="queue-panel" key={q}>
                      <div className="queue-title">
                        <Queue size={22} />
                        <h2>{t(q)}</h2>
                        <span>{items.length} files</span>
                      </div>
                      <p>
                        {items.filter((j) => j.status === "completed").length}{" "}
                        complete ·{" "}
                        {
                          items.filter((j) => activeStatuses.includes(j.status))
                            .length
                        }{" "}
                        active
                      </p>
                      <div className="queue-actions">
                        <button
                          className="secondary"
                          onClick={() =>
                            void Promise.all(
                              items
                                .filter((j) =>
                                  ["paused", "failed"].includes(j.status),
                                )
                                .map((j) => action(j.id, "resume")),
                            )
                          }
                        >
                          <Play size={16} />
                          Start queue
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            void Promise.all(
                              items
                                .filter(
                                  (j) =>
                                    activeStatuses.includes(j.status) ||
                                    j.status === "queued",
                                )
                                .map((j) => action(j.id, "pause")),
                            )
                          }
                        >
                          <Pause size={16} />
                          Pause queue
                        </button>
                      </div>
                      <ul>
                        {items.slice(0, 6).map((j) => (
                          <li key={j.id}>
                            <File size={16} />
                            <span>{j.filename}</span>
                            <span className={`status ${j.status}`}>
                              {statusLabel(j.status)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {!items.length && (
                        <p className="muted">
                          Add a download to populate this queue.
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
              <div className="info-panel">
                <Clock size={22} />
                <div>
                  <strong>Scheduled starts</strong>
                  <p>
                    Choose a start time in Add download → Advanced options.
                    Recurring calendars and synchronization remain on the
                    implementation roadmap.
                  </p>
                </div>
              </div>
            </>
          )}
          {view === "Browsers" && (
            <>
              <PageTitle
                title="Connect your browser"
                description="Download files and YouTube video/audio through Current's Chrome extension."
              />
              <div className="browser-intro">
                <PuzzlePiece size={40} weight="duotone" />
                <h2>A small bridge to your browser.</h2>
                <p>
                  The original Chromium extension and Rust native host are
                  included in the source. Browser registration is manual in this
                  development release.
                </p>
              </div>
              <div className="setup-steps">
                <section>
                  <span>01</span>
                  <h3>Load the extension</h3>
                  <p>
                    Open Chrome or Edge extension settings, enable Developer
                    mode and load the <code>extensions/chromium</code> folder.
                  </p>
                </section>
                <section>
                  <span>02</span>
                  <h3>Register your extension ID</h3>
                  <p>
                    Run <code>scripts/register-browser.ps1</code> with the
                    extension ID and packaged native host path. The script
                    writes your own host manifest.
                  </p>
                </section>
                <section>
                  <span>03</span>
                  <h3>Download with Current</h3>
                  <p>
                    Reload the extension and the YouTube tab after an upgrade.
                    Use the player’s “Download with Current” button, or choose
                    video/audio and quality in the popup. Current opens and
                    downloads the file.
                  </p>
                </section>
              </div>
              <div className="info-panel">
                <ShieldCheck size={23} />
                <div>
                  <strong>Files, YouTube and browser handoff</strong>
                  <p>
                    YouTube downloads use yt-dlp and FFmpeg for video/audio
                    merging. Browser handoff is optional. Cookies, protected
                    playback and Firefox packaging are not supported.
                  </p>
                </div>
              </div>
            </>
          )}
          {view === "Plans" && (
            <>
              <PageTitle
                title="A plan for your workflow."
                description="Free for everyday files. Pro for more control. Teams for shared administration."
              />
              <div className="development-note">
                <Info size={19} />
                <p>
                  <strong>Development release.</strong> These are proposed
                  plans. Payments, accounts and online licenses are not
                  connected.{" "}
                  {snapshot?.plan.development
                    ? "This build enables Pro development features locally."
                    : "You are using the Free engine limits."}
                </p>
              </div>
              <div className="pricing-grid">
                {[
                  {
                    name: "Free",
                    price: "0",
                    period: "Always free",
                    features: [
                      "2 active downloads",
                      "2 connections per file",
                      "Browser link handoff",
                      "Pause, resume & verification",
                      "Local history and export",
                    ],
                  },
                  {
                    name: "Pro",
                    price: "3.99",
                    period: "$29.99 billed annually",
                    features: [
                      "8 active downloads",
                      "Up to 16 connections per file",
                      "Batches and scheduled starts",
                      "YouTube video/audio; crawler planned",
                      "2 personal devices planned",
                    ],
                  },
                  {
                    name: "Teams",
                    price: "5.99",
                    period: "Per seat / month · 3 seats minimum",
                    features: [
                      "Everything in Pro",
                      "Shared billing planned",
                      "Member and device controls planned",
                      "Organization policies planned",
                      "Business audit planned",
                    ],
                  },
                ].map((p) => (
                  <article
                    key={p.name}
                    className={`pricing-panel ${p.name === "Pro" ? "pro" : ""}`}
                  >
                    <span className="plan-name">{p.name}</span>
                    <div className="price">
                      ${p.price}
                      <small>{p.name === "Free" ? "" : "/mo"}</small>
                    </div>
                    <p>{p.period}</p>
                    <ul>
                      {p.features.map((f) => (
                        <li key={f}>
                          <Check size={15} />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <span className="plan-state">
                      {p.name === "Free"
                        ? "Available now"
                        : "Payments not connected"}
                    </span>
                  </article>
                ))}
              </div>
              <p className="pricing-footnote">
                Pricing is a proposal. The feature matrix tracks implemented,
                planned, and compatibility work separately. Existing files
                remain yours on every plan.
              </p>
            </>
          )}
        </main>
        <div className="app-statusbar">
          <span>
            <span
              className={`engine-dot ${connectionError ? "offline" : ""}`}
            />
            {connectionError ? "Engine unavailable" : "Engine running"}
          </span>
          <span>
            {active.length} active · {formatBytes(speed)}/s
          </span>
          <span>Current {snapshot?.version || "0.1.0"} · Local storage</span>
        </div>
      </div>
      {detail && view === "Downloads" && (
        <aside className="detail-panel">
          <div className="detail-heading">
            <h2>{t("File details")}</h2>
            <button
              className="icon-button"
              title={t("Close")}
              onClick={() => setSelected(null)}
            >
              <X size={20} />
            </button>
          </div>
          <div className={`detail-file-icon ${detail.category.toLowerCase()}`}>
            {React.createElement(iconFor(detail.category), {
              size: 42,
              weight: "duotone",
            })}
          </div>
          <h3>{detail.filename}</h3>
          <span className={`status ${detail.status}`}>
            {statusLabel(detail.status)}
          </span>
          <dl>
            <dt>{t("Size")}</dt>
            <dd>{formatBytes(detail.total)}</dd>
            <dt>{t("Transferred")}</dt>
            <dd>{formatBytes(detail.downloaded)}</dd>
            <dt>{t("Resume support")}</dt>
            <dd>{detail.resumable ? t("Yes") : t("Unknown")}</dd>
            <dt>{t("Connections")}</dt>
            <dd>{detail.connections}</dd>
            <dt>{t("Destination")}</dt>
            <dd dir="ltr">{detail.folder}</dd>
            <dt>{t("Source")}</dt>
            <dd dir="ltr">{detail.url}</dd>
            {detail.media && (
              <>
                <dt>YouTube output</dt>
                <dd>
                  {detail.media.mode === "mp3"
                    ? "Audio · MP3"
                    : detail.media.mode === "audio"
                      ? "Audio · M4A"
                      : `Video + audio · MP4 · up to ${detail.media.max_height}p`}
                </dd>
              </>
            )}
            {detail.sha256 && (
              <>
                <dt>SHA-256</dt>
                <dd className="hash" dir="ltr">
                  {detail.sha256}
                </dd>
              </>
            )}
            {detail.start_at && (
              <>
                <dt>Scheduled</dt>
                <dd>{new Date(detail.start_at).toLocaleString()}</dd>
              </>
            )}
          </dl>
          {detail.error && <div className="detail-error">{detail.error}</div>}
          <div className="detail-actions">
            {detail.status !== "completed" && (
              <button
                className="primary"
                onClick={() =>
                  void action(
                    detail.id,
                    activeStatuses.includes(detail.status) ? "pause" : "resume",
                  )
                }
              >
                {activeStatuses.includes(detail.status) ? (
                  <Pause size={16} />
                ) : (
                  <Play size={16} />
                )}
                {t(activeStatuses.includes(detail.status) ? "Pause" : "Resume")}
              </button>
            )}
            <button
              className="secondary"
              onClick={() =>
                void rpc("open_folder", { id: detail.id }).catch((e) =>
                  notify(String(e), true),
                )
              }
            >
              <Folder size={16} />
              {t("Open folder")}
            </button>
            <button
              className="text-button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(detail.url)
                  .then(() => notify("Link copied."))
                  .catch((e) => notify(String(e), true))
              }
            >
              <Copy size={16} />
              {t("Copy link")}
            </button>
            {!activeStatuses.includes(detail.status) &&
              detail.status !== "completed" && (
                <button
                  className="text-button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Restart from the beginning? Existing partial bytes for this download will be discarded.",
                      )
                    )
                      void action(detail.id, "restart");
                  }}
                >
                  <ArrowsClockwise size={16} />
                  {t("Restart")}
                </button>
              )}
            <button
              className="text-button danger"
              onClick={() => {
                if (
                  window.confirm(
                    "Remove this item and its partial download data? Completed files are kept.",
                  )
                )
                  void action(detail.id, "remove").then(() =>
                    setSelected(null),
                  );
              }}
            >
              <Trash size={16} />
              {t("Remove")}
            </button>
          </div>
        </aside>
      )}
      {notice && (
        <div role="status" className={`toast ${notice.error ? "error" : ""}`}>
          <span>
            {notice.error ? <Info size={19} /> : <CheckCircle size={19} />}
          </span>
          <p>{notice.text}</p>
          <button
            className="icon-button"
            title="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            className={`modal ${modal === "settings" ? "settings-modal" : ""}`}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">
                  CURRENT /{" "}
                  {modal === "settings" ? "PREFERENCES" : "NEW TRANSFER"}
                </span>
                <h2 id="modal-title">
                  {t(
                    modal === "add"
                      ? "Add download"
                      : modal === "batch"
                        ? "Batch"
                        : "Settings",
                  )}
                </h2>
              </div>
              <button
                className="icon-button"
                title={t("Close")}
                onClick={() => setModal(null)}
                disabled={busy}
              >
                <X size={21} />
              </button>
            </div>
            {modal === "add" && (
              <form onSubmit={submit}>
                <label>
                  {t("Download link")}
                  <input
                    type="url"
                    autoFocus
                    required
                    dir="ltr"
                    placeholder="https://example.com/file.zip"
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                  />
                </label>
                {youtubeLink(form.url) && (
                  <div className="form-grid">
                    <label>
                      YouTube output
                      <select
                        value={form.media_mode}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            media_mode: e.target.value as
                              "video" | "audio" | "mp3",
                          })
                        }
                      >
                        <option value="video">Video + audio · MP4</option>
                        <option value="mp3">Audio only · MP3</option>
                        <option value="audio">Audio only · M4A</option>
                      </select>
                    </label>
                    <label>
                      Maximum quality
                      <select
                        disabled={form.media_mode !== "video"}
                        value={form.media_height}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            media_height: Number(e.target.value),
                          })
                        }
                      >
                        {[360, 480, 720, 1080, 1440, 2160].map((height) => (
                          <option key={height} value={height}>
                            Up to {height}p
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                <label>
                  {t("Save to")}
                  <div className="input-button">
                    <input
                      required
                      dir="ltr"
                      value={form.folder}
                      onChange={(e) =>
                        setForm({ ...form, folder: e.target.value })
                      }
                    />
                    <button
                      type="button"
                      className="icon-button"
                      title="Choose folder"
                      onClick={() => void pickFolder("add")}
                    >
                      <Folder size={19} />
                    </button>
                  </div>
                </label>
                <label>
                  {t("File name (optional)")}
                  <input
                    dir="ltr"
                    placeholder="Use the name from the URL"
                    value={form.filename}
                    onChange={(e) =>
                      setForm({ ...form, filename: e.target.value })
                    }
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={form.later}
                    onChange={(e) =>
                      setForm({ ...form, later: e.target.checked })
                    }
                  />
                  {t("Start paused")}
                </label>
                <details>
                  <summary>{t("Advanced options")}</summary>
                  <label>
                    {t("Description")}
                    <input
                      value={form.description}
                      onChange={(e) =>
                        setForm({ ...form, description: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t("Expected SHA-256 (optional)")}
                    <input
                      dir="ltr"
                      value={form.expected_sha256}
                      onChange={(e) =>
                        setForm({ ...form, expected_sha256: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    {t("Scheduled start (Pro)")}
                    <input
                      type="datetime-local"
                      disabled={!snapshot?.plan.paid_features}
                      value={form.start_at}
                      onChange={(e) =>
                        setForm({ ...form, start_at: e.target.value })
                      }
                    />
                  </label>
                  {snapshot?.plan.paid_features && (
                    <label>
                      Queue
                      <input
                        value={form.queue}
                        onChange={(e) =>
                          setForm({ ...form, queue: e.target.value })
                        }
                      />
                    </label>
                  )}
                </details>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setModal(null)}
                  >
                    {t("Cancel")}
                  </button>
                  <button className="primary" disabled={busy}>
                    <DownloadSimple size={17} />
                    {busy
                      ? "Adding…"
                      : t(form.later ? "Add to queue" : "Download now")}
                  </button>
                </div>
              </form>
            )}
            {modal === "batch" && (
              <form onSubmit={submitBatch}>
                <p className="form-description">
                  Paste one HTTP or HTTPS link per line. Each link becomes a
                  separate download.
                </p>
                {!snapshot?.plan.paid_features && (
                  <div className="development-note">
                    Batch input requires Pro. Payments are not connected in this
                    build.
                  </div>
                )}
                <label>
                  Download links
                  <textarea
                    required
                    autoFocus
                    rows={9}
                    dir="ltr"
                    placeholder={
                      "https://example.com/file-1.zip\nhttps://example.com/file-2.zip"
                    }
                    value={batch}
                    onChange={(e) => setBatch(e.target.value)}
                  />
                </label>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setModal(null)}
                  >
                    {t("Cancel")}
                  </button>
                  <button
                    className="primary"
                    disabled={busy || !snapshot?.plan.paid_features}
                  >
                    <Plus size={17} />
                    {busy ? "Adding…" : "Add downloads"}
                  </button>
                </div>
              </form>
            )}
            {modal === "settings" && (
              <form onSubmit={saveSettings}>
                <label>
                  {t("Download folder")}
                  <div className="input-button">
                    <input
                      required
                      dir="ltr"
                      value={settings.download_folder}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          download_folder: e.target.value,
                        })
                      }
                    />
                    <button
                      className="icon-button"
                      type="button"
                      title="Choose folder"
                      onClick={() => void pickFolder("settings")}
                    >
                      <Folder size={18} />
                    </button>
                  </div>
                </label>
                <h3 className="form-section">{t("Connection settings")}</h3>
                <div className="form-grid">
                  <label>
                    {t("Concurrent files")}
                    <input
                      type="number"
                      min={1}
                      max={snapshot?.plan.max_active || 2}
                      value={settings.max_active}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          max_active: +e.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    {t("Connections per file")}
                    <input
                      type="number"
                      min={1}
                      max={snapshot?.plan.max_connections || 2}
                      value={settings.connections}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          connections: +e.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <label>
                  {t("Speed limit (KB/s)")}
                  <input
                    type="number"
                    min={0}
                    value={settings.speed_limit / 1024}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        speed_limit: Math.max(0, +e.target.value) * 1024,
                      })
                    }
                  />
                  <small>
                    {t("0 means unlimited")} · Limit applies per file in this
                    version.
                  </small>
                </label>
                <h3 className="form-section">{t("Appearance")}</h3>
                <div className="form-grid">
                  <label>
                    {t("Language")}
                    <select
                      value={settings.language}
                      onChange={(e) =>
                        setSettings({ ...settings, language: e.target.value })
                      }
                    >
                      <option value="en">English</option>
                      <option value="ar">العربية</option>
                    </select>
                  </label>
                  <label>
                    Theme
                    <select
                      value={settings.theme}
                      onChange={(e) =>
                        setSettings({ ...settings, theme: e.target.value })
                      }
                    >
                      <option value="light">{t("Light")}</option>
                      <option value="dark">{t("Dark")}</option>
                    </select>
                  </label>
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setModal(null)}
                  >
                    {t("Cancel")}
                  </button>
                  <button className="primary">
                    <Check size={17} />
                    {t("Save settings")}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function PageTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">CURRENT / YOUR WORKSPACE</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

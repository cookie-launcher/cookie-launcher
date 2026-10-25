/* ==============================================================================
   COOKIELAUNCHER - FRONTEND CLIENT CONTROLLER (FREESM / PRISM ARCHITECTURE)
   Zero-Lag, Non-Blocking, CORS-Safe, Tolerant Network, Canli MB Ilerlemesi
   ============================================================================== */

let API_BASE = "http://127.0.0.1:18420";

// ================== DURUMLAR ==================
const state = {
  username: localStorage.getItem("cl_username") || "Steve",
  selectedVersion: localStorage.getItem("cl_version") || "",
  loader: localStorage.getItem("cl_loader") || "fabric",
  cookieOptimize: localStorage.getItem("cl_optimize") !== "false",
  ram: parseInt(localStorage.getItem("cl_ram") || "4"),

  // Sürüm Verileri
  versions: [],
  installedVersions: [],
  versionSearchQuery: "",
  versionFilters: {
    optimized: false,
    release: true,
    snapshot: false,
    beta: false,
    alpha: false,
    experimental: false
  },

  // Profiller (Instances)
  instances: [],
  activeInstanceId: localStorage.getItem("cl_instance") || "",
  modrinthTargetId: localStorage.getItem("cl_modrinth_target") || "",

  // Modrinth Durumu
  modrinthType: "mod",
  modrinthLoader: "fabric",
  modrinthSort: "downloads",
  modrinthQuery: "",
  modrinthHits: [],
  modrinthOffset: 0,
  modrinthLimit: 20,
  modrinthHasMore: true,
  modrinthLoading: false,
  packPollTimer: null,
  hideInstalled: localStorage.getItem("cl_hide_installed") === "true",
  installedModSlugs: new Set(),
  installedModFiles: [],
  installedContent: { mod: [], shader: [], resourcepack: [] },
  installedContentMeta: { mod: {}, shader: {}, resourcepack: {} },
  installedContentInstanceId: "",
  installedCategory: "mod",
  installedPanelCollapsed: false,
  installedLoading: false,
  contentLoadFailed: false,
  coreModsWarned: false,


  // Başlatma / Polling
  isPollingStatus: false,
  statusTimer: null,
  pollInFlight: false,
  pollTick: 0,
  coreFailCount: 0,
  launchRequested: false,
  launchAcceptedAt: 0,
  progressOpen: false,
  progressDismissed: false,
  progressCloseTimer: null,
  lastErrorShown: null,

  // İstek yarışlarını önleyen monoton sayaçlar
  modrinthReqId: 0,
  creatingInstance: false,
  instanceQuery: "",
  instanceSort: localStorage.getItem("cl_instance_sort") || "created"
};

// Sosyal / Arkadaşlar UI durumu
const socialUI = {
  data: null,
  timer: null,
  loading: false,
  initialized: false,
  lastSeq: 0,
  selectedLanPort: 0,
  selectedLanName: "",
  joinBusy: false,
  shareBusy: false,
  dismissedInvites: new Set(),
  pendingClipboardInvite: "",
  lastClipboardInvite: "",
  relayStartAttempted: false,
  relayStarting: false
};

// Backend'e erişilemezse gösterilecek yerel sürüm listesi (uygulama asla boş kalmasın)
const FALLBACK_VERSIONS = [
  "26.3", "26.2", "26.1.2", "26.1.1", "26.1",
  "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21",
  "1.20.6", "1.20.4", "1.20.2", "1.20.1", "1.20",
  "1.19.4", "1.19.2", "1.18.2", "1.17.1", "1.16.5",
  "1.12.2", "1.8.9", "1.7.10"
].map(id => ({ id, type: "release", releaseTime: "", is_optimized: true }));

// ================== YARDIMCI FONKSİYONLAR ==================
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateApiStatusText() {
  const value = API_BASE.replace(/^https?:\/\//, "");
  const statusEl = document.getElementById("statusApiText");
  if (statusEl) statusEl.textContent = value;
  const settingsEl = document.getElementById("settingsApiText");
  if (settingsEl) settingsEl.textContent = value;
}

function lastPlayedKey(instanceId) {
  return `cl_last_played_${String(instanceId || "")}`;
}

function getLastPlayed(instanceId) {
  const raw = Number(localStorage.getItem(lastPlayedKey(instanceId)) || 0);
  return Number.isFinite(raw) ? raw : 0;
}

function setLastPlayed(instanceId) {
  if (!instanceId) return;
  try {
    localStorage.setItem(lastPlayedKey(instanceId), String(Date.now()));
  } catch (_) {}
}

function formatPlayed(ts) {
  if (!ts) return "hiç oynanmadı";
  const diff = Date.now() - ts;
  if (diff < 60000) return "az önce";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} dk önce`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} sa önce`;
  return new Date(ts).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
}

function safeExternalUrl(raw) {
  try {
    const url = new URL(String(raw || ""), window.location.href);
    return (url.protocol === "http:" || url.protocol === "https:") ? url.href : "";
  } catch (_) {
    return "";
  }
}

function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function showErrorOnce(message) {
  if (!message) return;
  if (state.lastErrorShown === message) return;
  state.lastErrorShown = message;
  showToast(message, "error");
}

// ================== MOD BAĞIMLILIK TERCİHİ (Faz 2) ==================
function getInstallDepsPref() {
  return localStorage.getItem("cl_install_deps") !== "false";
}

function syncInstallDepsToggles() {
  const pref = getInstallDepsPref();
  document.querySelectorAll(".install-deps-cb").forEach(cb => { cb.checked = pref; });
}

function setInstallDepsPref(value) {
  localStorage.setItem("cl_install_deps", value ? "true" : "false");
  syncInstallDepsToggles();
}

function bindInstallDepsToggle(el) {
  if (!el) return;
  el.checked = getInstallDepsPref();
  if (el.dataset.bound === "1") return;
  el.dataset.bound = "1";
  el.addEventListener("change", () => setInstallDepsPref(el.checked));
}

function modInstallToast(name, data) {
  const installed = (data && data.installed_dependencies) || [];
  const failed = (data && data.failed_dependencies) || [];
  const label = name || (data && data.filename) || "İçerik";
  if (failed.length > 0) {
    console.warn("Kurulamayan bağımlılıklar:", failed);
    showToast(` ${label} kuruldu ama ${failed.length} bağımlılık kurulamadı`, "error");
  } else if (installed.length > 0) {
    const names = installed.map(d => d.title || d.slug).filter(Boolean).join(", ");
    showToast(` ${label} kuruldu • ${installed.length} bağımlılık: ${names}`, "success");
  } else {
    showToast(` ${label} kuruldu.`, "success");
  }
}

// ================== ASLA HATA FIRLATMAYAN API KATMANI ==================
async function apiGet(path, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function apiPost(path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function detectApiBase() {
  // Gelistirme / iki istemci testi icin acik API adresi: ?api=http://127.0.0.1:18422
  const override = new URLSearchParams(window.location.search).get("api");
  if (override) {
    API_BASE = String(override).replace(/\/$/, "");
    updateApiStatusText();
    return true;
  }
  for (const port of [18420, 18421, 18422, 18423, 18424, 18425]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: controller.signal,
        cache: "no-store"
      });
      if (res.ok) {
        const data = await res.json();
        // Eski/stale backend süreçlerini atla: yalnızca güncel API sürümü kabul
        if (data && Number(data.api_version) >= 19) {
          API_BASE = `http://127.0.0.1:${port}`;
          updateApiStatusText();
          return true;
        }
      }
    } catch (_) {
      // sessizce sıradaki porta geç
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

// ================== BAŞLATMA (INIT) ==================
window.addEventListener("unhandledrejection", (event) => {
  console.error("Beklenmeyen istisna:", event.reason);
  showToast("Beklenmeyen bir hata oluştu; konsolu kontrol edin.", "error");
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await detectApiBase();
    initUI();
    setupEventListeners();
    loadVersions().catch(() => {});
    await loadInstances();
    loadRecentWorlds();
    startStatusPolling();
    startSocialPolling();
    setupTauriWindowControls();
    initProfileDetailScreen();
    initSocialUI();
  } catch (err) {
    console.error("Başlatma hatası:", err);
    showToast("Launcher başlatılırken bir hata oluştu.", "error");
  }
});

function initUI() {
  const uInput = document.getElementById("usernameInput");
  if (uInput) uInput.value = state.username;

  const vInput = document.getElementById("versionInput");
  if (vInput) vInput.value = state.selectedVersion;

  const validLoader = ["vanilla", "fabric", "forge", "neoforge", "quilt"].includes(String(state.loader).toLowerCase())
    ? String(state.loader).toLowerCase()
    : "fabric";
  const lRadio = document.querySelector(`input[name="loaderRadio"][value="${validLoader}"]`);
  if (lRadio) {
    lRadio.checked = true;
    document.querySelectorAll('input[name="loaderRadio"]').forEach(r => {
      const card = r.closest(".loader-card");
      if (card) card.classList.toggle("active", r.checked);
    });
  }

  const optToggle = document.getElementById("cookieOptimizeToggle");
  if (optToggle) optToggle.checked = state.cookieOptimize;

  const ramSlider = document.getElementById("ramSlider");
  if (ramSlider) ramSlider.value = state.ram;
  updateRamUI();

  // Hero + rail aktif profil özeti
  renderPlayHero();
}

// RAM göstergesi: rozet + görsel bellek çubuğu + özet metni
function updateRamUI() {
  const ram = state.ram;
  const ramText = document.getElementById("ramValueText");
  const fill = document.getElementById("ramBarFill");
  const summary = document.getElementById("ramSummary");
  if (ramText) ramText.textContent = `${ram} GB`;
  if (fill) {
    const pct = Math.round(((ram - 2) / (16 - 2)) * 100);
    fill.style.width = `${Math.max(8, Math.min(100, pct))}%`;
  }
  if (summary) {
    const advice = ram >= 8
      ? "Modlu paketler için rahat bir değer."
      : ram >= 4
        ? "Vanilla ve hafif modlar için yeterli."
        : "Yalnızca vanilla oyun için önerilir.";
    summary.textContent = `${ram} GB ayrıldı • ${advice}`;
  }
}

// ================== KONSOL ARAÇLARI ==================
function isConsoleAutoscrollEnabled() {
  const cb = document.getElementById("consoleAutoscroll");
  return !cb || cb.checked;
}

async function copyConsoleOutput() {
  const out = document.getElementById("consoleOutput");
  if (!out) return;
  const text = out.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    showToast("Konsol panoya kopyalandı.", "success");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast("Konsol panoya kopyalandı.", "success");
    } catch (err) {
      showToast("Konsol kopyalanamadı.", "error");
    }
    ta.remove();
  }
}

function exportConsoleOutput() {
  const out = document.getElementById("consoleOutput");
  if (!out) return;
  const blob = new Blob([out.textContent || ""], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cookie-launcher-konsol-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ================== KISAYOLLAR ==================
function openShortcutsModal() {
  const modal = document.getElementById("shortcutsModal");
  if (!modal) return;
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");
}

function closeShortcutsModal() {
  const modal = document.getElementById("shortcutsModal");
  if (!modal) return;
  modal.style.display = "none";
  modal.setAttribute("aria-hidden", "true");
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" ||
    el.isContentEditable === true;
}

function setupGlobalShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const typing = isTypingTarget(e.target);
    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.altKey) {
      const tabMap = { "1": "tab-play", "2": "tab-instances", "3": "tab-modrinth", "4": "tab-gallery", "5": "tab-console", "6": "tab-friends" };
      if (tabMap[e.key]) {
        e.preventDefault();
        switchTab(tabMap[e.key]);
        return;
      }
      if (String(e.key).toLowerCase() === "k") {
        e.preventDefault();
        switchTab("tab-modrinth");
        const input = document.getElementById("modrinthSearchInput");
        if (input) { input.focus(); input.select(); }
        return;
      }
    }

    if (typing) return;

    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      openShortcutsModal();
      return;
    }

    if (e.key === "Enter") {
      const activePane = document.querySelector(".tab-pane.active");
      const modalOpen = Array.from(document.querySelectorAll(".modal-backdrop"))
        .some(m => m && m.style.display === "flex");
      if (!modalOpen && activePane && activePane.id === "tab-play") {
        e.preventDefault();
        handleLaunchGame();
      }
    }
  });
}

function cleanupTimers() {
  if (state.statusTimer) {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }
  if (state.packPollTimer) {
    clearInterval(state.packPollTimer);
    state.packPollTimer = null;
  }
  if (state.progressCloseTimer) {
    clearTimeout(state.progressCloseTimer);
    state.progressCloseTimer = null;
  }
  if (pdsState.note.timer) {
    clearTimeout(pdsState.note.timer);
    pdsState.note.timer = null;
  }
}

// ================== OLAY BAĞLAMA ==================
function setupEventListeners() {
  // Sekme Değişimi
  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.addEventListener("click", () => switchTab(tab.getAttribute("data-tab")));
  });

  // Hızlı Klasörler Menüsü
  const btnQuick = document.getElementById("btnQuickFolders");
  const quickMenu = document.getElementById("quickFoldersMenu");
  if (btnQuick && quickMenu) {
    const syncQuickAria = () => btnQuick.setAttribute("aria-expanded", quickMenu.classList.contains("show") ? "true" : "false");
    btnQuick.addEventListener("click", (e) => {
      e.stopPropagation();
      quickMenu.classList.toggle("show");
      syncQuickAria();
    });
    window.addEventListener("click", () => {
      quickMenu.classList.remove("show");
      syncQuickAria();
    });
  }

  document.querySelectorAll(".dropdown-item[data-folder]").forEach(item => {
    item.addEventListener("click", () => openSystemFolder(item.getAttribute("data-folder")));
  });

  // Oyuncu Adı Değişimi
  const uInput = document.getElementById("usernameInput");
  if (uInput) {
    uInput.addEventListener("input", (e) => {
      state.username = e.target.value.trim() || "Steve";
      localStorage.setItem("cl_username", state.username);
    });
  }

  // Sürüm Doğrudan Girişi
  const vInput = document.getElementById("versionInput");
  if (vInput) {
    vInput.addEventListener("input", (e) => {
      state.selectedVersion = e.target.value.trim();
      localStorage.setItem("cl_version", state.selectedVersion);
    });
    vInput.addEventListener("change", (e) => {
      const val = e.target.value.trim();
      if (!val) return;
      state.selectedVersion = val;
      localStorage.setItem("cl_version", val);
      if (state.activeInstanceId) updateActiveInstance({ version: val });
    });
  }

  // Aktif Profil Seçici
  const activeSelect = document.getElementById("activeInstanceSelect");
  if (activeSelect) {
    activeSelect.addEventListener("change", (e) => setActiveInstance(e.target.value));
  }

  // Profil Oluşturma Modalı
  const btnCreateInstance = document.getElementById("btnCreateInstance");
  if (btnCreateInstance) btnCreateInstance.addEventListener("click", openCreateInstanceModal);

  const btnCloseCreateInstance = document.getElementById("btnCloseCreateInstanceModal");
  if (btnCloseCreateInstance) btnCloseCreateInstance.addEventListener("click", closeCreateInstanceModal);

  const btnCancelCreateInstance = document.getElementById("btnCancelCreateInstance");
  if (btnCancelCreateInstance) btnCancelCreateInstance.addEventListener("click", closeCreateInstanceModal);

  const btnConfirmCreateInstance = document.getElementById("btnConfirmCreateInstance");
  if (btnConfirmCreateInstance) btnConfirmCreateInstance.addEventListener("click", confirmCreateInstance);

  const instanceNameInput = document.getElementById("instanceNameInput");
  if (instanceNameInput) {
    instanceNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmCreateInstance();
    });
  }

  // Yeni Profil modalı (sekmeli arayüz)
  initNewProfileModal();
  initRipple();

  // Modrinth Kurulum Hedefi
  const modrinthTargetSelect = document.getElementById("modrinthInstanceSelect");
  if (modrinthTargetSelect) {
    modrinthTargetSelect.addEventListener("change", (e) => {
      const id = e.target.value || "";
      state.modrinthTargetId = getInstanceById(id) ? id : "";
      if (state.modrinthTargetId) {
        localStorage.setItem("cl_modrinth_target", state.modrinthTargetId);
      } else {
        localStorage.removeItem("cl_modrinth_target");
      }
      renderModrinthTargetBar();
      fetchModrinth(true);
    });
  }

  // Modrinth sonsuz kaydırma (infinite scroll) - keşfet alanı iç scroll
  const discoverScroll = document.getElementById("modrinthDiscoverScroll") || document.querySelector(".main-content");
  if (discoverScroll) {
    discoverScroll.addEventListener("scroll", () => {
      const modrinthPane = document.getElementById("tab-modrinth");
      if (!modrinthPane || !modrinthPane.classList.contains("active")) return;
      if (!state.modrinthHasMore || state.modrinthLoading) return;
      if (discoverScroll.scrollTop + discoverScroll.clientHeight >= discoverScroll.scrollHeight - 400) {
        fetchModrinth(false);
      }
    });
  }

  // Yüklü içerik paneli: kategori sekmeleri ve daralt/genişlet
  document.querySelectorAll(".installed-cat-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".installed-cat-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      state.installedCategory = tab.getAttribute("data-cat") || "mod";
      renderInstalledPanel();
    });
  });

  const btnToggleInstalled = document.getElementById("btnToggleInstalledPanel");
  if (btnToggleInstalled) {
    btnToggleInstalled.addEventListener("click", () => {
      state.installedPanelCollapsed = !state.installedPanelCollapsed;
      const panel = document.getElementById("installedPanel");
      if (panel) panel.classList.toggle("collapsed", state.installedPanelCollapsed);
      btnToggleInstalled.textContent = state.installedPanelCollapsed ? "▴" : "▾";
      btnToggleInstalled.setAttribute("aria-expanded", state.installedPanelCollapsed ? "false" : "true");
    });
  }

  // Sürüm Seçim Modalı
  const btnOpenVModal = document.getElementById("btnOpenVersionModal");
  if (btnOpenVModal) btnOpenVModal.addEventListener("click", openVersionSelectorModal);

  const btnCloseVModal = document.getElementById("btnCloseVersionSelectorModal");
  if (btnCloseVModal) btnCloseVModal.addEventListener("click", closeVersionSelectorModal);

  const btnCancelVModal = document.getElementById("btnCancelVersionSelectorModal");
  if (btnCancelVModal) btnCancelVModal.addEventListener("click", closeVersionSelectorModal);

  // Sürüm Tablosu Arama
  const vTableSearch = document.getElementById("versionTableSearchInput");
  const btnClearVSearch = document.getElementById("btnClearVersionSearch");
  if (vTableSearch) {
    vTableSearch.addEventListener("input", (e) => {
      state.versionSearchQuery = e.target.value;
      if (btnClearVSearch) btnClearVSearch.style.display = e.target.value ? "block" : "none";
      filterAndRenderVersionTable();
    });
  }
  if (btnClearVSearch && vTableSearch) {
    btnClearVSearch.addEventListener("click", () => {
      vTableSearch.value = "";
      state.versionSearchQuery = "";
      btnClearVSearch.style.display = "none";
      filterAndRenderVersionTable();
    });
  }

  // Sağ Düşey Filtre Paneli
  document.querySelectorAll(".version-filter-cb").forEach(cb => {
    cb.addEventListener("change", () => {
      state.versionFilters[cb.getAttribute("data-category")] = cb.checked;
      filterAndRenderVersionTable();
    });
  });

  // Yükleyici Seçimi
  document.querySelectorAll('input[name="loaderRadio"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      state.loader = e.target.value;
      localStorage.setItem("cl_loader", state.loader);
      document.querySelectorAll('input[name="loaderRadio"]').forEach(r => {
        const card = r.closest(".loader-card");
        if (card) card.classList.toggle("active", r.checked);
      });
      if (state.activeInstanceId) updateActiveInstance({ loader: state.loader });
    });
  });

  // Optimize Toggle
  const optToggle = document.getElementById("cookieOptimizeToggle");
  if (optToggle) {
    optToggle.addEventListener("change", (e) => {
      state.cookieOptimize = e.target.checked;
      localStorage.setItem("cl_optimize", state.cookieOptimize);
      showToast(state.cookieOptimize ? " Optimize motoru devrede!" : "Vanilla moduna geçildi.", "info");
    });
  }

  // RAM Slider
  const ramSlider = document.getElementById("ramSlider");
  if (ramSlider) {
    ramSlider.addEventListener("input", (e) => {
      state.ram = parseInt(e.target.value);
      localStorage.setItem("cl_ram", state.ram);
      updateRamUI();
    });
  }

  // Hero eylemleri
  const heroDetails = document.getElementById("heroDetailsBtn");
  if (heroDetails) {
    heroDetails.addEventListener("click", () => {
      const inst = getActiveInstance();
      if (inst) openProfileDetail(inst.id, "mods");
      else openCreateInstanceModal();
    });
  }
  const heroManage = document.getElementById("heroManageBtn");
  if (heroManage) heroManage.addEventListener("click", () => switchTab("tab-instances"));

  // OYUNU BAŞLAT
  const btnLaunch = document.getElementById("btnLaunchGame");
  if (btnLaunch) btnLaunch.addEventListener("click", handleLaunchGame);

  // Progress Modal Gizle
  const btnDismissProgress = document.getElementById("btnDismissProgressModal");
  if (btnDismissProgress) {
    btnDismissProgress.addEventListener("click", () => {
      closeProgressModal();
    });
  }

  // Modrinth Arama
  const btnSearch = document.getElementById("btnDoSearch");
  const sInput = document.getElementById("modrinthSearchInput");
  if (btnSearch && sInput) {
    btnSearch.addEventListener("click", () => {
      state.modrinthQuery = sInput.value;
      fetchModrinth(true);
    });
    sInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        state.modrinthQuery = sInput.value;
        fetchModrinth(true);
      }
    });
  }

  document.querySelectorAll(".cat-pill").forEach(pill => {
    pill.addEventListener("click", () => {
      document.querySelectorAll(".cat-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      state.modrinthType = pill.getAttribute("data-type");
      fetchModrinth(true);
    });
  });

  const mLoaderSelect = document.getElementById("modrinthLoaderSelect");
  if (mLoaderSelect) {
    mLoaderSelect.addEventListener("change", (e) => {
      state.modrinthLoader = e.target.value;
      fetchModrinth(true);
    });
  }

  const mSortSelect = document.getElementById("modrinthSortSelect");
  if (mSortSelect) {
    mSortSelect.addEventListener("change", (e) => {
      state.modrinthSort = e.target.value;
      fetchModrinth(true);
    });
  }

  // Yüklü modları gizleme anahtarı
  const hideInstalledToggle = document.getElementById("hideInstalledToggle");
  if (hideInstalledToggle) {
    hideInstalledToggle.checked = state.hideInstalled;
    hideInstalledToggle.addEventListener("change", async (e) => {
      state.hideInstalled = e.target.checked;
      localStorage.setItem("cl_hide_installed", state.hideInstalled);

      // Liste daha önce boş yüklendiyse önce yüklü modları tazele
      if (state.installedModSlugs.size === 0 && state.installedModFiles.length === 0) {
        await refreshInstalledContent();
      }
      applyInstalledStates();

      showToast(
        state.hideInstalled
          ? "Yüklü içerikler listeden gizlendi."
          : "Yüklü içerikler tekrar gösteriliyor.",
        "info"
      );
    });
  }

  // Gerekli bağımlılıkları da kur onay kutusu (tercih localStorage'da)
  bindInstallDepsToggle(document.getElementById("installDepsToggle"));

  // Ekran Görüntüsü Klasörü
  const btnOpenScreenshots = document.getElementById("btnOpenScreenshotsFolder");
  if (btnOpenScreenshots) {
    btnOpenScreenshots.addEventListener("click", () => openSystemFolder("screenshots"));
  }

  // Konsol araçları
  const btnClearConsole = document.getElementById("btnClearConsole");
  if (btnClearConsole) {
    btnClearConsole.addEventListener("click", () => {
      const cOut = document.getElementById("consoleOutput");
      if (cOut) cOut.textContent = "Konsol temizlendi.\n";
    });
  }
  const btnCopyConsole = document.getElementById("btnCopyConsole");
  if (btnCopyConsole) btnCopyConsole.addEventListener("click", copyConsoleOutput);
  const btnExportConsole = document.getElementById("btnExportConsole");
  if (btnExportConsole) btnExportConsole.addEventListener("click", exportConsoleOutput);

  // Galeri lightbox
  const lightboxClose = document.getElementById("galleryLightboxClose");
  if (lightboxClose) lightboxClose.addEventListener("click", closeGalleryLightbox);
  const galleryLightbox = document.getElementById("galleryLightbox");
  if (galleryLightbox) {
    galleryLightbox.addEventListener("click", (e) => {
      if (e.target === galleryLightbox) closeGalleryLightbox();
    });
  }

  // Kısayollar
  const btnShortcuts = document.getElementById("btnShowShortcuts");
  if (btnShortcuts) btnShortcuts.addEventListener("click", openShortcutsModal);
  const btnCloseShortcuts = document.getElementById("btnCloseShortcuts");
  if (btnCloseShortcuts) btnCloseShortcuts.addEventListener("click", closeShortcutsModal);
  const btnCloseShortcutsFooter = document.getElementById("btnCloseShortcutsFooter");
  if (btnCloseShortcutsFooter) btnCloseShortcutsFooter.addEventListener("click", closeShortcutsModal);

  // Profil arama / sıralama
  const instanceSearch = document.getElementById("instanceSearchInput");
  if (instanceSearch) {
    instanceSearch.value = state.instanceQuery;
    instanceSearch.addEventListener("input", (e) => {
      state.instanceQuery = e.target.value;
      renderInstances();
    });
  }
  const instanceSort = document.getElementById("instanceSortSelect");
  if (instanceSort) {
    instanceSort.value = state.instanceSort;
    instanceSort.addEventListener("change", (e) => {
      state.instanceSort = e.target.value;
      localStorage.setItem("cl_instance_sort", state.instanceSort);
      renderInstances();
    });
  }

  // Son dünyalar / hızlı eylemler
  const btnRefreshWorlds = document.getElementById("btnRefreshWorlds");
  if (btnRefreshWorlds) btnRefreshWorlds.addEventListener("click", loadRecentWorlds);
  const btnOpenModsFolder = document.getElementById("btnOpenModsFolder");
  if (btnOpenModsFolder) btnOpenModsFolder.addEventListener("click", () => openActiveInstanceFolder("mods"));
  const btnOpenInstanceFolder = document.getElementById("btnOpenInstanceFolder");
  if (btnOpenInstanceFolder) btnOpenInstanceFolder.addEventListener("click", () => openActiveInstanceFolder(""));
  const btnOpenInstanceScreenshots = document.getElementById("btnOpenInstanceScreenshots");
  if (btnOpenInstanceScreenshots) btnOpenInstanceScreenshots.addEventListener("click", () => openActiveInstanceFolder("screenshots"));

  setupGlobalShortcuts();
  window.addEventListener("beforeunload", cleanupTimers);

  // Sürüm Değiştir overlay'i
  initVersionSwitchModal();

  // Erişilebilirlik: rail klavye gezinmesi + modal odak tuzağı/ESC
  initRailA11y();
  initDialogA11y();
}

// Rail'de ok tuşlarıyla gezinme (rol=tablist, roving tabindex)
function initRailA11y() {
  const menu = document.querySelector(".rail-menu");
  if (!menu || menu.dataset.bound === "1") return;
  menu.dataset.bound = "1";

  const tabs = () => Array.from(menu.querySelectorAll(".nav-tab"));
  tabs().forEach(t => { t.tabIndex = t.classList.contains("active") ? 0 : -1; });

  menu.addEventListener("keydown", (e) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const items = tabs();
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);
    let next = 0;
    if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
    else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
    else if (e.key === "End") next = items.length - 1;
    items[next].focus();
    items[next].click();
  });
}

// Modallar: role=dialog, odak tuzağı (Tab döngüsü) ve ESC ile kapatma
function initDialogA11y() {
  if (initDialogA11y._bound) return;
  initDialogA11y._bound = true;

  const closers = {
    createInstanceModal: () => closeCreateInstanceModal(),
    confirmModal: () => { const b = document.getElementById("btnConfirmCancel"); if (b) b.click(); },
    versionSwitchModal: () => closeVersionSwitchOverlay(),
    versionSelectorModal: () => closeVersionSelectorModal(),
    launchProgressModal: () => closeProgressModal(),
    shortcutsModal: () => closeShortcutsModal()
  };

  const visibleModal = () => {
    const modals = Array.from(document.querySelectorAll(".modal-backdrop"))
      .filter(m => m && m.style.display === "flex");
    return modals.length ? modals[modals.length - 1] : null;
  };

  const focusables = (root) => Array.from(root.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter(el => !el.disabled && el.offsetParent !== null);

  document.addEventListener("keydown", (e) => {
    const modal = visibleModal();

    if (e.key === "Escape") {
      const gallery = document.getElementById("galleryLightbox");
      if (gallery && gallery.classList.contains("show")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeGalleryLightbox();
        return;
      }
      if (modal && closers[modal.id]) {
        e.preventDefault();
        // Alttaki profil detay ekranının da ESC almasını engelle.
        e.stopImmediatePropagation();
        closers[modal.id]();
      }
      return;
    }

    if (e.key !== "Tab") return;

    // Modal açıkken odak tuzağı; modal yoksa profil detay ekranında tut
    const screen = document.getElementById("profileDetailScreen");
    const profileOpen = screen && screen.style.display !== "none" && screen.getAttribute("aria-hidden") !== "true";
    const root = modal || (profileOpen ? screen : null);
    if (!root) return;

    const items = focusables(root);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (!root.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

function switchTab(tabId) {
  document.querySelectorAll(".nav-tab").forEach(t => {
    const active = t.getAttribute("data-tab") === tabId;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", active ? "true" : "false");
    if (active) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
    t.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

  const targetTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
  const targetPane = document.getElementById(tabId);

  if (targetTab) targetTab.classList.add("active");
  if (targetPane) targetPane.classList.add("active");

  if (tabId === "tab-play") {
    loadRecentWorlds();
  } else if (tabId === "tab-modrinth") {
    renderModrinthTargetBar();
    if (state.modrinthHits.length === 0) {
      fetchModrinth(true);
    } else {
      refreshInstalledContent().then(applyInstalledStates);
    }
  } else if (tabId === "tab-gallery") {
    loadScreenshots();
  } else if (tabId === "tab-instances") {
    loadInstances();
  } else if (tabId === "tab-friends") {
    loadSocialState(false);
  }
}

// ================== PROFİLLER (INSTANCES) ==================
function getInstanceById(id) {
  if (!id) return null;
  return state.instances.find(i => i.id === id) || null;
}

function getActiveInstance() {
  return getInstanceById(state.activeInstanceId);
}

function getModrinthTarget() {
  return getInstanceById(state.modrinthTargetId) || getActiveInstance();
}

async function loadInstances() {
  const data = await apiGet("/api/instances", 8000);
  const listOk = !!(data && Array.isArray(data.instances));

  // Geçici bir ağ hatası, mevcut profil listesini ve aktif seçimi SİLMEMELİ.
  if (!listOk) return false;

  state.instances = data.instances;

  if (state.activeInstanceId && !getInstanceById(state.activeInstanceId)) {
    state.activeInstanceId = "";
    localStorage.removeItem("cl_instance");
  }
  if (state.modrinthTargetId && !getInstanceById(state.modrinthTargetId)) {
    state.modrinthTargetId = "";
    localStorage.removeItem("cl_modrinth_target");
  }

  populateActiveInstanceSelect();
  renderInstances();
  renderModrinthTargetBar();
  applyActiveInstanceToUI();
  ensurePackPolling();
  refreshInstalledContent();
  return true;
}

function ensurePackPolling() {
  const hasInstalling = state.instances.some(i => i.install_status === "installing");
  if (hasInstalling && !state.packPollTimer) {
    state.packPollTimer = setInterval(async () => {
      const ok = await loadInstances();
      // Başarısız bir yoklama "kurulum bitti" sayılmamalı.
      if (!ok) return;
      if (!state.instances.some(i => i.install_status === "installing")) {
        clearInterval(state.packPollTimer);
        state.packPollTimer = null;
        refreshInstalledContent();
        showToast("Modpack kurulumu tamamlandı.", "success");
      }
    }, 3000);
  }
}

function populateActiveInstanceSelect() {
  const select = document.getElementById("activeInstanceSelect");
  if (!select) return;

  select.innerHTML = "";

  // Profilsiz oynama yolu YOK: "Genel .minecraft kullanılır" secenegi kaldirildi.
  // Profil yoksa liste bos birakilmaz; secilemeyen bir bilgi satiri gosterilir.
  if (state.instances.length === 0) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "Profil oluşturulmamış — önce yeni profil ekleyin";
    none.disabled = true;
    none.selected = true;
    select.appendChild(none);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  state.instances.forEach(inst => {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.name} — MC ${inst.version} (${inst.loader})`;
    select.appendChild(opt);
  });

  // Gecerli aktif profil yoksa ilk profili aktif kabul et; boylece hicbir
  // durumda "profilsiz" baslatma kalmaz.
  if (!state.instances.some(i => i.id === state.activeInstanceId)) {
    state.activeInstanceId = state.instances[0].id;
    localStorage.setItem("cl_instance", state.activeInstanceId);
  }
  select.value = state.activeInstanceId;
}

function renderInstances() {
  const wrap = document.getElementById("instancesGridWrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  if (state.instances.length === 0) {
    // Birleşik boş durum bileşeni (ikon + başlık + açıklama + eylem)
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-state-icon" aria-hidden="true">+</div>
      <h3 class="empty-state-title">Henüz profil oluşturulmamış</h3>
      <p class="empty-state-desc">Modların nereye kurulacağını belirlemek için ilk profilinizi oluşturun.</p>
      <button class="btn btn-primary" id="btnEmptyCreateInstance"> Yeni Profil Oluştur</button>
    `;
    wrap.appendChild(empty);
    const btn = document.getElementById("btnEmptyCreateInstance");
    if (btn) btn.addEventListener("click", () => openCreateInstanceModal());
    return;
  }

  const query = String(state.instanceQuery || "").trim().toLowerCase();
  const list = state.instances.filter(inst =>
    !query ||
    String(inst.name || "").toLowerCase().includes(query) ||
    String(inst.version || "").toLowerCase().includes(query) ||
    String(inst.loader || "").toLowerCase().includes(query)
  );
  const sort = state.instanceSort || "created";
  list.sort((a, b) => {
    if (sort === "name") return String(a.name || "").localeCompare(String(b.name || ""), "tr");
    if (sort === "mods") return (Number(b.mod_count) || 0) - (Number(a.mod_count) || 0);
    if (sort === "played") return getLastPlayed(b.id) - getLastPlayed(a.id);
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });

  if (list.length === 0) {
    wrap.innerHTML = `<div class="empty-state">
      <div class="empty-state-icon" aria-hidden="true">?</div>
      <h3 class="empty-state-title">Eşleşen profil yok</h3>
      <p class="empty-state-desc">"${escapeHtml(state.instanceQuery)}" aramasına uygun profil bulunamadı.</p>
    </div>`;
    return;
  }

  list.forEach((inst, idx) => {
    const isActive = inst.id === state.activeInstanceId;
    const installing = inst.install_status === "installing";
    const failed = inst.install_status === "failed";
    const card = document.createElement("div");
    card.className = "instance-card" + (isActive ? " active" : "") + (installing ? " installing" : "");
    card.style.animationDelay = `${Math.min(idx * 0.05, 0.4)}s`;

    const iconBox = document.createElement("div");
    iconBox.className = "inst-icon-box";
    if (inst.icon) {
      const img = document.createElement("img");
      img.src = inst.icon;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        iconBox.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
        iconBox.classList.add("inst-icon-letter");
      });
      iconBox.appendChild(img);
    } else {
      iconBox.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
      iconBox.classList.add("inst-icon-letter");
    }

    const metaText = installing
      ? `Kuruluyor: ${escapeHtml(inst.install_detail || "")} %${inst.install_progress || 0}`
      : failed
        ? `Kurulum hatası: ${escapeHtml(inst.install_detail || "")}`
        : `Son oynama: ${formatPlayed(getLastPlayed(inst.id))}`;

    const top = document.createElement("div");
    top.className = "inst-card-top";
    top.appendChild(iconBox);

    const info = document.createElement("div");
    info.className = "inst-info";
    const loaderKey = String(inst.loader || "vanilla").toLowerCase();
    info.innerHTML = `
      <h4 class="inst-name" title="${escapeHtml(inst.name)}">${escapeHtml(inst.name)}</h4>
      <div class="inst-chips">
        <span class="inst-chip">MC ${escapeHtml(inst.version || "?")}</span>
        <span class="inst-chip" title="Mod yükleyici">${escapeHtml(loaderKey)}</span>
        <span class="inst-chip" title="Yüklü mod sayısı">${Number(inst.mod_count) || 0} mod</span>
      </div>
      <span class="inst-meta">${metaText}</span>
    `;
    top.appendChild(info);

    if (isActive) {
      const badge = document.createElement("span");
      badge.className = "inst-badge-active";
      badge.textContent = "Aktif";
      top.appendChild(badge);
    }

    const actions = document.createElement("div");
    actions.className = "inst-card-actions";

    const btnActivate = document.createElement("button");
    btnActivate.className = "btn-inst btn-inst-primary";
    btnActivate.textContent = isActive ? "Seçili" : "Aktif yap";
    btnActivate.disabled = installing;
    btnActivate.addEventListener("click", () => setActiveInstance(inst.id));

    const btnMods = document.createElement("button");
    btnMods.className = "btn-inst";
    btnMods.textContent = "Detaylar";
    btnMods.addEventListener("click", () => openProfileDetail(inst.id, "mods"));

    const btnDelete = document.createElement("button");
    btnDelete.className = "btn-inst btn-inst-danger";
    btnDelete.textContent = "Sil";
    btnDelete.addEventListener("click", () => deleteInstance(inst.id, inst.name));

    actions.appendChild(btnActivate);
    actions.appendChild(btnMods);
    actions.appendChild(btnDelete);

    card.appendChild(top);
    card.appendChild(actions);
    wrap.appendChild(card);
  });
}

function setActiveInstance(id) {
  state.activeInstanceId = getInstanceById(id) ? id : "";

  if (state.activeInstanceId) {
    localStorage.setItem("cl_instance", state.activeInstanceId);
  } else {
    localStorage.removeItem("cl_instance");
  }

  // Modrinth kurulum hedefi aktif profile otomatik uyum sağlar
  state.modrinthTargetId = state.activeInstanceId;
  if (state.modrinthTargetId) {
    localStorage.setItem("cl_modrinth_target", state.modrinthTargetId);
  } else {
    localStorage.removeItem("cl_modrinth_target");
  }

  applyActiveInstanceToUI();
  renderInstances();
  renderModrinthTargetBar();
  loadRecentWorlds();
  fetchModrinth(true);

  const inst = getActiveInstance();
  if (inst) {
    const versionInput = document.getElementById("versionInput");
    if (versionInput) versionInput.value = inst.version;
    showToast(`Aktif profil: ${inst.name} (MC ${inst.version} • ${inst.loader})`, "info");
  }
}

function applyActiveInstanceToUI() {
  const select = document.getElementById("activeInstanceSelect");
  const inst = getActiveInstance();

  // Profil yoksa "OYUNU BASLAT" yerine "ONCE PROFIL OLUSTUR" gosterilir.
  // Motor mesgulse (kurulum / oyun calisiyor) buton durumuna dokunulmaz.
  if (!state.engineMode || state.engineMode === "idle") {
    setLaunchButton(inst ? "idle" : "noProfile");
  }

  if (select) select.value = inst ? inst.id : "";

  const vInput = document.getElementById("versionInput");
  const hint = document.getElementById("versionLabelHint");

  if (inst) {
    state.selectedVersion = inst.version;
    state.loader = inst.loader;
    localStorage.setItem("cl_version", state.selectedVersion);
    localStorage.setItem("cl_loader", state.loader);

    if (vInput) vInput.value = inst.version;
    if (hint) hint.textContent = `"${inst.name}" profiline bağlı — değişiklik profile kaydedilir`;

    const safeLoader = ["vanilla", "fabric", "forge", "neoforge", "quilt"].includes(String(inst.loader).toLowerCase())
      ? String(inst.loader).toLowerCase()
      : "fabric";
    const radio = document.querySelector(`input[name="loaderRadio"][value="${safeLoader}"]`);
    if (radio) {
      radio.checked = true;
      document.querySelectorAll('input[name="loaderRadio"]').forEach(r => {
        const card = r.closest(".loader-card");
        if (card) card.classList.toggle("active", r.checked);
      });
    }
  } else if (hint) {
    hint.textContent = "İstediğiniz sürümü doğrudan yazabilir veya listeden seçebilirsiniz";
  }

  renderPlayHero();
}

// Hero paneli + rail mini kartını aktif profile göre güncelle
function renderPlayHero() {
  const inst = getActiveInstance();
  const nameEl = document.getElementById("heroProfileName");
  const iconEl = document.getElementById("heroProfileIcon");
  const chipsEl = document.getElementById("heroProfileChips");
  const subEl = document.getElementById("heroProfileSub");
  const detailsBtn = document.getElementById("heroDetailsBtn");

  const railCard = document.getElementById("railProfileCard");
  const railIcon = document.getElementById("railProfileIcon");
  const railName = document.getElementById("railProfileName");
  const railMeta = document.getElementById("railProfileMeta");

  if (!inst) {
    if (nameEl) {
      nameEl.textContent = "Profil seçilmedi";
      nameEl.classList.remove("is-long");
      nameEl.removeAttribute("title");
    }
    if (chipsEl) chipsEl.innerHTML = "";
    if (subEl) subEl.textContent = "Başlamak için yeni bir profil oluşturun.";
    if (iconEl) { iconEl.textContent = "?"; }
    if (detailsBtn) detailsBtn.disabled = true;
    if (railCard) railCard.classList.add("is-empty");
    if (railIcon) railIcon.textContent = "?";
    if (railName) railName.textContent = "Profil yok";
    if (railMeta) railMeta.textContent = "MC • —";
    return;
  }

  const loaderLabel = pdsLoaderLabel(inst.loader);
  const loaderText = loaderLabel + (inst.loader_version ? ` ${inst.loader_version}` : "");

  if (nameEl) {
    nameEl.textContent = inst.name || "Profil";
    nameEl.classList.toggle("is-long", (inst.name || "").length > 18);
    nameEl.title = inst.name || "";
  }
  if (subEl) subEl.textContent = "Başlatmaya hazır.";
  if (detailsBtn) detailsBtn.disabled = false;

  if (chipsEl) {
    chipsEl.innerHTML = `
      <span class="chip">MC ${escapeHtml(inst.version || "?")}</span>
      <span class="chip">${escapeHtml(loaderText)}</span>
      <span class="chip">${Number(inst.mod_count) || 0} mod</span>
      <span class="chip">${formatPlayed(getLastPlayed(inst.id))}</span>
    `;
  }

  // Büyük hero avatarı (ikon yoksa baş harf)
  if (iconEl) {
    iconEl.innerHTML = "";
    if (inst.icon) {
      const img = document.createElement("img");
      img.src = inst.icon;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        iconEl.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
      });
      iconEl.appendChild(img);
    } else {
      iconEl.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
    }
  }

  // Rail mini kartı
  if (railCard) railCard.classList.remove("is-empty");
  if (railName) railName.textContent = inst.name || "Profil";
  if (railMeta) {
    railMeta.innerHTML = `
      <span class="mini-chip">MC ${escapeHtml(inst.version || "?")}</span>
      <span class="mini-chip">${escapeHtml(loaderLabel)}</span>
    `;
  }
  if (railIcon) {
    railIcon.innerHTML = "";
    if (inst.icon) {
      const img = document.createElement("img");
      img.src = inst.icon;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        railIcon.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
      });
      railIcon.appendChild(img);
    } else {
      railIcon.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
    }
  }
}

// ================== SON DÜNYALAR / HIZLI EYLEMLER ==================
async function loadRecentWorlds() {
  const list = document.getElementById("recentWorldsList");
  const sub = document.getElementById("recentWorldsSub");
  if (!list) return;

  const inst = getActiveInstance();
  if (!inst) {
    list.innerHTML = `<div class="recent-empty">Profil seçilmedi. Bir profil oluşturduğunuzda son dünyalar burada görünür.</div>`;
    if (sub) sub.textContent = "Profil seçilmedi";
    return;
  }

  const instanceId = String(inst.id || "");
  if (sub) sub.textContent = `${inst.name || "Profil"} • MC ${inst.version || "?"}`;
  list.innerHTML = `<div class="skeleton skeleton-row"></div><div class="skeleton skeleton-row"></div>`;

  const data = await apiGet(`/api/instances/worlds?instance=${encodeURIComponent(instanceId)}`, 15000);
  if (String((getActiveInstance() || {}).id || "") !== instanceId) return;

  const worlds = (data && Array.isArray(data.worlds)) ? data.worlds.slice() : [];
  worlds.sort((a, b) => String(b.last_played || "").localeCompare(String(a.last_played || "")));
  const recent = worlds.slice(0, 5);

  if (!data || data.success !== true) {
    list.innerHTML = `<div class="recent-empty">Dünya listesi alınamadı. Core bağlantısını kontrol edin.</div>`;
    return;
  }
  if (recent.length === 0) {
    list.innerHTML = `<div class="recent-empty">Bu profilde henüz kayıtlı dünya yok. Oyunda yeni bir dünya oluşturun.</div>`;
    return;
  }

  list.innerHTML = "";
  recent.forEach(world => {
    const row = document.createElement("div");
    row.className = "recent-row";

    const icon = document.createElement("div");
    icon.className = "recent-icon";
    icon.textContent = "W";
    if (world.has_icon) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = "";
      img.src = `${API_BASE}/api/instances/world/icon?instance=${encodeURIComponent(instanceId)}` +
        `&world=${encodeURIComponent(world.name)}&t=${encodeURIComponent(world.last_played || "")}`;
      img.addEventListener("error", () => { img.remove(); icon.textContent = "W"; });
      icon.textContent = "W";
      icon.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "recent-info";
    info.innerHTML = `
      <div class="recent-name">${escapeHtml(world.name)}</div>
      <div class="recent-meta">${escapeHtml(world.last_played || "—")}<span class="recent-meta-sep">/</span>${Number(world.size_mb) || 0} MB</div>
    `;

    const actions = document.createElement("div");
    actions.className = "recent-actions";
    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "recent-action";
    folderBtn.textContent = "Klasör";
    folderBtn.addEventListener("click", () => openSystemFolder(`instances/${instanceId}/saves`));
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "recent-action";
    copyBtn.textContent = "Kopyala";
    copyBtn.addEventListener("click", async () => {
      copyBtn.disabled = true;
      const result = await apiPost("/api/instances/world/copy", {
        instance: instanceId,
        world: world.name
      }, 120000);
      copyBtn.disabled = false;
      if (result && result.success) {
        showToast(result.message || "Dünya kopyalandı.", "success");
        loadRecentWorlds();
      } else {
        showToast((result && result.error) || "Dünya kopyalanamadı.", "error");
      }
    });
    actions.appendChild(folderBtn);
    actions.appendChild(copyBtn);

    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

function openActiveInstanceFolder(subdir) {
  const inst = getActiveInstance();
  if (!inst) {
    showToast("Önce bir profil seçin.", "info");
    return;
  }
  openSystemFolder(`instances/${inst.id}/${subdir}`);
}

async function updateActiveInstance(fields) {
  const inst = getActiveInstance();
  if (!inst) return;

  Object.assign(inst, fields);
  renderInstances();
  renderModrinthTargetBar();

  const data = await apiPost("/api/instances/update", {
    id: inst.id,
    version: inst.version,
    loader: inst.loader,
    name: inst.name
  }, 8000);

  if (data && data.success && data.instance) {
    const idx = state.instances.findIndex(i => i.id === inst.id);
    if (idx >= 0) state.instances[idx] = data.instance;
    renderInstances();
    renderModrinthTargetBar();
  }
}

// ==================== RIPPLE (mikro-etkileşim) ====================
function initRipple() {
  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest
      ? e.target.closest("button.btn-primary-action, button.btn-secondary, button.btn-mega-launch, button.nav-tab, button.cat-pill, button.np-loader-card, button.np-combo-item, button.np-pack-item, button.np-side-tab, button.np-adv-toggle, button.control-btn, button.btn-search-go, button.btn-browse-version, button.btn-close-modal, button.installed-cat-tab")
      : null;
    if (!btn || btn.disabled) return;
    const rect = btn.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement("span");
    ripple.className = "np-ripple";
    ripple.style.width = ripple.style.height = size + "px";
    ripple.style.left = (e.clientX - rect.left - size / 2) + "px";
    ripple.style.top = (e.clientY - rect.top - size / 2) + "px";
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 620);
  });
}

// ==================== YENİ PROFİL MODALI (SEKMELİ YENİ ARAYÜZ) ====================
const NP_LOADERS = [
  { id: "vanilla",  name: "Vanilla",  note: "Yükleyici kurulmaz; saf Minecraft deneyimi." },
  { id: "neoforge", name: "NeoForge", note: "NeoForge yalnızca 1.20.2 ve üzeri sürümlerde yayınlanır." },
  { id: "forge",    name: "Forge",    note: "Klasik modlar için en geniş uyumluluk." },
  { id: "fabric",   name: "Fabric",   note: "Hafif ve yüksek performanslı yükleyici." },
  { id: "quilt",    name: "Quilt",    note: "Fabric modlarıyla büyük ölçüde uyumludur." },
];

const npState = {
  tab: "custom",
  version: "",
  versionType: "release",
  versionOptimized: false,
  loader: "fabric",
  loaderInfo: null,
  loaderLoading: false,
  loaderError: "",
  manualLoaderVersion: "",
  packHits: [],
  selectedPack: null,
  packBusy: false,
  packRequestId: 0,
};

function npText(el, value) {
  if (el) el.textContent = value == null ? "" : String(value);
}

function npShow(el, show) {
  if (el) el.style.display = show ? "" : "none";
}

function npFmtNum(n) {
  const v = Number(n || 0);
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(".", ",") + " Mr";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(".", ",") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(".", ",") + "B";
  return String(v);
}

function initNewProfileModal() {
  document.querySelectorAll("[data-np-tab]").forEach((btn) => {
    btn.addEventListener("click", () => npSelectTab(btn.getAttribute("data-np-tab")));
  });

  const vInput = document.getElementById("instanceVersionInput");
  if (vInput) {
    vInput.addEventListener("focus", () => npRenderVersionList(vInput.value, true));
    vInput.addEventListener("input", () => npRenderVersionList(vInput.value, true));
    vInput.addEventListener("keydown", (e) => {
      const list = document.getElementById("npVersionList");
      const openList = !!(list && list.classList.contains("open"));
      if (e.key === "Enter") {
        e.preventDefault();
        if (openList) {
          const first = list.querySelector(".np-combo-item");
          if (first) npPickVersion(first.getAttribute("data-version"));
        } else {
          confirmCreateInstance();
        }
      } else if (e.key === "Escape") {
        npCloseVersionList();
      } else if (e.key === "ArrowDown" && openList) {
        const first = list.querySelector(".np-combo-item");
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
  }

  // Sürüm alanına tıklanınca ESKİ sürüm menüsü (tablo + filtreler) açılır
  const picker = document.getElementById("npVersionPicker");
  if (picker) picker.addEventListener("click", () => openVersionSelectorModal());

  // Eski sürüm kombosu kaldırıldı; yalnızca hâlâ varsa dinleyici ekle.
  if (document.getElementById("npVersionCombo")) {
    document.addEventListener("click", (e) => {
      const combo = document.getElementById("npVersionCombo");
      if (combo && !combo.contains(e.target)) npCloseVersionList();
    });
  }

  document.querySelectorAll("#npLoaderGrid .np-loader-card").forEach((card) => {
    card.addEventListener("click", () => npSelectLoader(card.getAttribute("data-loader")));
  });

  const advToggle = document.getElementById("npAdvToggle");
  if (advToggle) {
    advToggle.addEventListener("click", () => {
      const panel = document.getElementById("npAdvPanel");
      if (!panel) return;
      const willOpen = panel.hasAttribute("hidden");
      if (willOpen) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
      advToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
      advToggle.classList.toggle("active", willOpen);
    });
  }

  const lvSelect = document.getElementById("npLoaderVersionSelect");
  if (lvSelect) {
    lvSelect.addEventListener("change", () => {
      npState.manualLoaderVersion = lvSelect.value || "";
      npUpdateLoaderBox();
    });
  }

  const packBtn = document.getElementById("npPackSearchBtn");
  if (packBtn) packBtn.addEventListener("click", () => npSearchPacks());
  const packInput = document.getElementById("npPackSearchInput");
  if (packInput) packInput.addEventListener("keydown", (e) => { if (e.key === "Enter") npSearchPacks(); });
  const sortSel = document.getElementById("npPackSortSelect");
  if (sortSel) sortSel.addEventListener("change", () => npSearchPacks());
  const loaderFilter = document.getElementById("npPackLoaderFilter");
  if (loaderFilter) loaderFilter.addEventListener("change", () => npSearchPacks());
  const versionFilter = document.getElementById("npPackVersionFilter");
  if (versionFilter) versionFilter.addEventListener("change", () => npSearchPacks());
  const installBtn = document.getElementById("npPackInstallBtn");
  if (installBtn) installBtn.addEventListener("click", () => npInstallSelectedPack());
}

function npSelectTab(tab) {
  npState.tab = tab === "packs" ? "packs" : "custom";
  document.querySelectorAll("[data-np-tab]").forEach((b) => {
    const active = b.getAttribute("data-np-tab") === npState.tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  const custom = document.getElementById("npPaneCustom");
  const packs = document.getElementById("npPanePacks");
  if (custom) custom.classList.toggle("active", npState.tab === "custom");
  if (packs) packs.classList.toggle("active", npState.tab === "packs");
  const confirmBtn = document.getElementById("btnConfirmCreateInstance");
  if (confirmBtn) confirmBtn.style.display = npState.tab === "custom" ? "" : "none";
  const tip = document.getElementById("npModalTip");
  if (tip) {
    tip.textContent = npState.tab === "custom"
      ? " Profil oluşturulunca otomatik olarak aktif edilir."
      : " Mod paketi kendi Minecraft sürümü ve yükleyicisiyle ayrı bir profil olarak kurulur.";
  }
  if (npState.tab === "packs" && npState.packHits.length === 0 && !npState.packBusy) {
    npRenderPackVersionFilter();
    npSearchPacks();
  }
}

// ---------- Minecraft sürümü: aranabilir açılır liste ----------
function npRenderVersionList(query, open) {
  const list = document.getElementById("npVersionList");
  const input = document.getElementById("instanceVersionInput");
  if (!list) return;
  const q = String(query || "").trim().toLowerCase();
  const all = Array.isArray(state.versions) ? state.versions : [];
  let items = all.filter((v) => !q || String(v.id).toLowerCase().includes(q));
  if (q) {
    items = items.slice().sort((a, b) => {
      const rank = (x) => {
        const id = String(x.id).toLowerCase();
        return id === q ? 0 : id.startsWith(q) ? 1 : 2;
      };
      return rank(a) - rank(b);
    });
  }
  const shown = items.slice(0, 80);
  list.innerHTML = "";
  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "np-combo-empty";
    empty.textContent = all.length ? "Eşleşen sürüm yok." : "Sürüm listesi yükleniyor...";
    list.appendChild(empty);
  } else {
    shown.forEach((v) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "np-combo-item" + (v.id === npState.version ? " selected" : "");
      item.setAttribute("data-version", v.id);
      item.setAttribute("role", "option");
      item.innerHTML =
        `<span class="np-combo-id">${v.is_optimized ? '<span class="np-combo-opt" aria-hidden="true"></span>' : ""}${escapeHtml(v.id)}</span>` +
        `<span class="np-combo-type">${escapeHtml(v.type || "")}</span>`;
      item.addEventListener("click", () => npPickVersion(v.id, v));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); npPickVersion(v.id, v); }
      });
      list.appendChild(item);
    });
    if (items.length > shown.length) {
      const more = document.createElement("div");
      more.className = "np-combo-more";
      more.textContent = `+${items.length - shown.length} sürüm daha... (aramayı daraltın)`;
      list.appendChild(more);
    }
  }
  if (open) {
    list.classList.add("open");
    if (input) input.setAttribute("aria-expanded", "true");
  }
}

function npCloseVersionList() {
  const list = document.getElementById("npVersionList");
  const input = document.getElementById("instanceVersionInput");
  if (list) list.classList.remove("open");
  if (input) input.setAttribute("aria-expanded", "false");
}

function npApplyVersion(version) {
  npState.version = version;
  const info = Array.isArray(state.versions) ? state.versions.find((v) => v.id === version) : null;
  npState.versionType = info && info.type ? info.type : "release";
  npState.versionOptimized = !!(info && info.is_optimized);
  const input = document.getElementById("instanceVersionInput");
  if (input) input.value = version;

  // Buton icerigi: surum adi (yumusak fade ile) + tip rozeti + optimize rozeti
  const vEl = document.getElementById("npVersionPickerValue");
  if (vEl) {
    vEl.textContent = version;
    vEl.classList.remove("nvp-updated");
    void vEl.offsetWidth;           // animasyonu yeniden tetikle
    vEl.classList.add("nvp-updated");
  }
  const badge = document.getElementById("npVersionPickerBadge");
  if (badge) {
    badge.textContent = VERSION_TYPE_LABELS[npState.versionType] || npState.versionType || "Release";
    badge.setAttribute("data-type", npState.versionType || "release");
  }
  npShow(document.getElementById("npVersionPickerOpt"), npState.versionOptimized);
  npText(document.getElementById("npVersionHint"), "Seçildi: " + version);
}

function npPickVersion(version, meta) {
  if (!version) return;
  npApplyVersion(version);
  npCloseVersionList();
  npFetchLoaderInfo();
}

// ---------- Mod yükleyici seçimi + otomatik sürüm ataması ----------
function npSelectLoader(loader) {
  npState.loader = loader || "fabric";
  npState.manualLoaderVersion = "";
  npState.loaderInfo = null;
  npState.loaderError = "";
  document.querySelectorAll("#npLoaderGrid .np-loader-card").forEach((c) => {
    c.classList.toggle("active", c.getAttribute("data-loader") === npState.loader);
  });
  const sel = document.getElementById("npLoaderVersionSelect");
  if (sel) sel.innerHTML = '<option value="">Otomatik (önerilen)</option>';
  const meta = NP_LOADERS.find((l) => l.id === npState.loader);
  npText(document.getElementById("npLoaderNote"), meta ? meta.note : "");
  npFetchLoaderInfo();
}

async function npFetchLoaderInfo() {
  if (!npState.version) return;
  if (npState.loader === "vanilla") {
    npState.loaderInfo = null;
    npState.loaderLoading = false;
    npState.loaderError = "";
    npUpdateLoaderBox();
    return;
  }
  npState.loaderLoading = true;
  npState.loaderError = "";
  npUpdateLoaderBox();
  const reqId = ++npState.packRequestId;
  const data = await apiGet(
    `/api/loaders/versions?loader=${encodeURIComponent(npState.loader)}&version=${encodeURIComponent(npState.version)}`,
    25000
  );
  if (reqId !== npState.packRequestId) return;
  npState.loaderLoading = false;
  if (!data || !data.success) {
    npState.loaderInfo = null;
    npState.loaderError = (data && data.error) || "Yükleyici sürüm bilgisi alınamadı.";
  } else {
    npState.loaderInfo = data;
  }
  const sel = document.getElementById("npLoaderVersionSelect");
  if (sel) {
    sel.innerHTML = '<option value="">Otomatik (önerilen)</option>';
    const info = npState.loaderInfo;
    // TAM liste kullanilir (stable_only degil): kullanici gecmis surumlerin
    // tamamini gorebilmeli. Kararli surumler isaretlenir.
    const all = (info && info.versions) || [];
    const stableSet = new Set((info && info.stable_only) || []);
    all.forEach((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = stableSet.has(v) ? `${v}   • kararlı` : v;
      sel.appendChild(o);
    });
    sel.value = all.indexOf(npState.manualLoaderVersion) !== -1 ? npState.manualLoaderVersion : "";
  }
  npUpdateLoaderBox();
}

function npUpdateLoaderBox() {
  const valueEl = document.getElementById("npLoaderRecommended");
  const reasonEl = document.getElementById("npLoaderReason");
  const hintEl = document.getElementById("npLoaderVersionHint");
  if (!valueEl) return;

  if (npState.loader === "vanilla") {
    valueEl.innerHTML = '<span class="np-lv-none">Yükleyici yok</span>';
    npText(reasonEl, "Vanilla profilde mod yükleyici kurulmaz.");
    if (hintEl) hintEl.textContent = "Vanilla seçiliyken loader sürümü gerekmez.";
    return;
  }
  if (npState.loaderLoading) {
    valueEl.innerHTML = '<span class="np-lv-spinner" aria-hidden="true"></span> hesaplanıyor...';
    npText(reasonEl, `${npState.version} için ${npState.loader} sürümleri sorgulanıyor...`);
    return;
  }
  if (npState.loaderError) {
    valueEl.innerHTML = '<span class="np-lv-error">alınamadı</span>';
    npText(reasonEl, npState.loaderError);
    return;
  }
  const info = npState.loaderInfo;
  if (!info || info.supported === false) {
    valueEl.innerHTML = '<span class="np-lv-warn">desteklenmiyor</span>';
    npText(reasonEl, `${npState.loader} ${npState.version} sürümü için yayınlanmıyor. Farklı bir sürüm ya da yükleyici seçin.`);
    return;
  }
  const rec = info.recommended || "";
  // Durust bilgilendirme: yukleyici bu MC surumunu farkli adlandirabilir ve
  // bazi yeni surumler icin henuz kararli yapi olmayabilir.
  const aliasNote = info.mc_alias ? ` Yükleyici bu sürümü "${info.mc_alias}" olarak adlandırır.` : "";
  const betaNote = /beta|alpha|rc/i.test(rec) ? "  Bu Minecraft sürümü için kararlı yapı yok, en yeni ön sürüm öneriliyor." : "";
  if (npState.manualLoaderVersion) {
    valueEl.innerHTML = `<span class="np-lv-manual">${escapeHtml(npState.manualLoaderVersion)}</span> <span class="np-lv-tag">elle seçildi</span>`;
    npText(reasonEl, `Otomatik öneri: ${rec || "—"} • Gelişmiş menüden değiştirildi.`);
  } else {
    valueEl.innerHTML = `<span class="np-lv-ok">${escapeHtml(rec || "—")}</span> <span class="np-lv-tag">otomatik</span>`;
    npText(reasonEl, (rec
      ? `${npState.version} + ${npState.loader} için önerilen sürüm otomatik atandı.`
      : "Önerilen sürüm bulunamadı, kütüphane varsayılanı kullanılacak.") + aliasNote + betaNote);
  }
  if (hintEl) hintEl.textContent = info.total_versions
    ? `${info.total_versions} sürümün tamamı listelendi${info.stable_count ? ` (${info.stable_count} tanesi kararlı olarak işaretli)` : ""}.`
    : "";
}

// ---------- Modal aç / kapa ----------
function openCreateInstanceModal() {
  const modal = document.getElementById("createInstanceModal");
  if (!modal) return;
  const nameInput = document.getElementById("instanceNameInput");
  const iconInput = document.getElementById("instanceIconInput");
  if (nameInput) nameInput.value = "";
  if (iconInput) iconInput.value = "";

  const fallbackVersion = npState.version || state.selectedVersion || (state.versions[0] && state.versions[0].id) || "1.20.4";
  npApplyVersion(fallbackVersion);
  npState.manualLoaderVersion = "";
  npSelectLoader(npState.loader || "fabric");
  npSelectTab("custom");
  npRenderPackVersionFilter();

  modal.style.display = "flex";
  if (nameInput) setTimeout(() => nameInput.focus(), 140);
}

function closeCreateInstanceModal() {
  const modal = document.getElementById("createInstanceModal");
  if (modal) modal.style.display = "none";
  npCloseVersionList();
}

async function confirmCreateInstance() {
  const nameInput = document.getElementById("instanceNameInput");
  const iconInput = document.getElementById("instanceIconInput");
  const name = ((nameInput && nameInput.value) || "").trim();
  const icon = ((iconInput && iconInput.value) || "").trim();
  const version = npState.version || state.selectedVersion || "1.20.4";
  const loader = npState.loader || "fabric";
  const loaderVersion = npState.manualLoaderVersion || "";

  if (!name) {
    showToast("Lütfen bir profil adı girin.", "info");
    if (nameInput) nameInput.focus();
    return;
  }
  if (npState.loaderLoading) {
    showToast("Yükleyici sürümü hâlâ hesaplanıyor, bir saniye...", "info");
    return;
  }
  const info = npState.loaderInfo;
  if (loader !== "vanilla" && info && info.supported === false) {
    showToast(`${loader} ${version} için desteklenmiyor. Farklı sürüm/yükleyici seçin.`, "error");
    return;
  }
  if (state.creatingInstance) return;
  state.creatingInstance = true;

  const confirmBtn = document.getElementById("btnConfirmCreateInstance");
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Oluşturuluyor..."; }

  const data = await apiPost(
    "/api/instances/create",
    { name, version, loader, loader_version: loaderVersion, icon },
    15000
  );

  state.creatingInstance = false;
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Oluştur ve aktif yap"; }

  if (data && data.success && data.instance) {
    closeCreateInstanceModal();
    state.modrinthTargetId = data.instance.id;
    localStorage.setItem("cl_modrinth_target", data.instance.id);
    await loadInstances();
    setActiveInstance(data.instance.id);
    const lvText = loader === "vanilla" ? "" : (loaderVersion ? ` • ${loaderVersion}` : " • oto loader");
    showToast(`"${data.instance.name}" oluşturuldu (${loader}${lvText}).`, "success");
    fetchModrinth(true);
  } else {
    showToast(`${(data && data.error) || "Profil oluşturulamadı."}`, "error");
  }
}

// ==================== SEKME 2: MOD PAKETLERİ (yalnızca Modrinth) ====================
function npRenderPackVersionFilter() {
  const sel = document.getElementById("npPackVersionFilter");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Tüm sürümler</option>';
  const all = Array.isArray(state.versions) ? state.versions : [];
  all.slice(0, 120).forEach((v) => {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.id;
    sel.appendChild(o);
  });
  if (current) sel.value = current;
}

async function npSearchPacks() {
  // Yeni arama eskisini geçersiz kılar; eski yanıt geldiğinde yok sayılır.
  const reqId = ++npState.packRequestId;
  npState.packBusy = true;
  const list = document.getElementById("npPackList");
  if (list) {
    list.innerHTML = '<div class="np-pack-loading"><span class="np-spinner"></span><span>Mod paketleri taranıyor...</span></div>';
  }
  const searchEl = document.getElementById("npPackSearchInput");
  const versionEl = document.getElementById("npPackVersionFilter");
  const loaderEl = document.getElementById("npPackLoaderFilter");
  const sortEl = document.getElementById("npPackSortSelect");
  const params = new URLSearchParams({
    q: (searchEl && searchEl.value) || "",
    type: "modpack",
    version: (versionEl && versionEl.value) || "",
    loader: (loaderEl && loaderEl.value) || "",
    sort: (sortEl && sortEl.value) || "relevance",
    limit: 20,
    offset: 0,
  });
  const data = await apiGet(`/api/modrinth/search?${params.toString()}`, 20000);
  if (reqId !== npState.packRequestId) return;
  npState.packBusy = false;

  if (data && data.error) {
    npState.packHits = [];
    const listEl = document.getElementById("npPackList");
    if (listEl) {
      listEl.innerHTML = `
        <div class="np-pack-loading">
          <span class="np-net-error"> ${escapeHtml(data.error)}</span>
          <span class="np-net-hint">Ağ testi için: <code>http://127.0.0.1:18420/api/net-test</code></span>
        </div>`;
    }
    npRenderPackDetail(null);
    showNetErrorOnce(data.error);
    return;
  }

  npState.packHits = data && Array.isArray(data.hits) ? data.hits : [];
  npRenderPackList();
  if (npState.packHits.length > 0) npSelectPack(npState.packHits[0]);
  else npRenderPackDetail(null);
}

// Ag hatasini kullaniciya BIR KEZ toast olarak goster (spam yapmaz)
function showNetErrorOnce(message) {
  const key = String(message || "").slice(0, 120);
  if (state.lastNetErrorShown === key) return;
  state.lastNetErrorShown = key;
  showToast(" Bağlantı hatası: " + message, "error");
}

function npRenderPackList() {
  const list = document.getElementById("npPackList");
  if (!list) return;
  list.innerHTML = "";
  if (npState.packHits.length === 0) {
    list.innerHTML = '<div class="np-pack-loading"><span>Sonuç bulunamadı.</span></div>';
    return;
  }
  npState.packHits.forEach((hit, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "np-pack-item" + (npState.selectedPack && npState.selectedPack.slug === hit.slug ? " active" : "");
    item.style.animationDelay = Math.min(i * 35, 420) + "ms";
    item.innerHTML = `
      <img class="np-pack-icon" src="${escapeHtml(hit.icon_url || "")}" alt="" loading="lazy">
      <span class="np-pack-text">
        <strong>${escapeHtml(hit.title || hit.slug)}</strong>
        <span class="np-pack-meta">${npFmtNum(hit.downloads)} indirme${hit.categories && hit.categories.length ? " • " + escapeHtml(hit.categories.slice(0, 2).join(", ")) : ""}</span>
      </span>
      <span class="np-pack-arrow" aria-hidden="true">→</span>`;
    const packImg = item.querySelector(".np-pack-icon");
    if (packImg) packImg.addEventListener("error", () => packImg.remove());
    item.addEventListener("click", () => npSelectPack(hit));
    list.appendChild(item);
  });
}

function npRenderPackDetail(hit) {
  const box = document.getElementById("npPackDetail");
  if (!box) return;
  if (!hit) {
    box.innerHTML = `
      <div class="np-pack-empty">
        <span class="np-pack-empty-icon" aria-hidden="true"></span>
        <span>Detayları görmek için soldan bir mod paketi seçin.</span>
      </div>`;
    return;
  }
  box.innerHTML = `
    <div class="np-pack-det-head">
      <img class="np-pack-det-icon" src="${escapeHtml(hit.icon_url || "")}" alt="">
      <div class="np-pack-det-title">
        <h4>${escapeHtml(hit.title || hit.slug)}</h4>
        <p class="np-pack-det-author">${escapeHtml(hit.author || "Modrinth")}</p>
        <div class="np-pack-det-badges">
          <span class="np-chip">${npFmtNum(hit.downloads)} indirme</span>
          <span class="np-chip">${npFmtNum(hit.follows)} takipçi</span>
          <span class="np-chip" id="npPackDetLoaders">—</span>
        </div>
      </div>
    </div>
    <p class="np-pack-det-desc">${escapeHtml(hit.description || "")}</p>
    <div class="np-pack-det-cats">
      ${(hit.categories || []).map((c) => `<span class="np-chip">${escapeHtml(c)}</span>`).join("")}
    </div>
    <div class="np-pack-det-hint">
      Bu paket kendi Minecraft sürümü ve yükleyicisiyle <strong>yeni bir profil</strong> olarak kurulur.
    </div>`;
  const detImg = box.querySelector(".np-pack-det-icon");
  if (detImg) detImg.addEventListener("error", () => detImg.remove());
}

async function npSelectPack(hit) {
  npState.selectedPack = hit;
  npState.selectedPackVersion = "";
  const items = document.querySelectorAll("#npPackList .np-pack-item");
  npState.packHits.forEach((h, i) => {
    if (items[i]) items[i].classList.toggle("active", h.slug === hit.slug);
  });
  npRenderPackDetail(hit);

  const gvSel = document.getElementById("npPackGameVersionSelect");
  const installBtn = document.getElementById("npPackInstallBtn");
  if (gvSel) gvSel.innerHTML = '<option value="">yükleniyor...</option>';
  if (installBtn) installBtn.disabled = true;

  const data = await apiGet(`/api/modrinth/pack/versions?slug=${encodeURIComponent(hit.slug)}`, 20000);
  if (!npState.selectedPack || npState.selectedPack.slug !== hit.slug) return;

  const packOk = !!(data && data.success && Array.isArray(data.game_versions) && data.game_versions.length > 0);
  const gameVersions = packOk ? data.game_versions : [];
  const loaders = packOk && Array.isArray(data.loaders) ? data.loaders : [];
  const target = getModrinthTarget();
  const preferred = (target && target.version) || state.selectedVersion || "";

  npText(document.getElementById("npPackDetLoaders"), loaders.length ? loaders.join(" • ") : "—");

  if (gvSel) {
    gvSel.innerHTML = "";
    if (gameVersions.length === 0) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "sürüm bilgisi yok";
      gvSel.appendChild(o);
    } else {
      gameVersions.forEach((g) => {
        const o = document.createElement("option");
        o.value = g;
        o.textContent = g;
        gvSel.appendChild(o);
      });
      if (preferred && gameVersions.indexOf(preferred) !== -1) gvSel.value = preferred;
    }
  }
  if (installBtn) {
    installBtn.disabled = !packOk;
    if (!packOk) showToast((data && data.error) || "Bu paket için uyumlu sürüm bulunamadı.", "error");
  }
}

async function npInstallSelectedPack() {
  const hit = npState.selectedPack;
  if (!hit) return;
  const gvSel = document.getElementById("npPackGameVersionSelect");
  const gameVersion = (gvSel && gvSel.value) || "";
  const btn = document.getElementById("npPackInstallBtn");
  if (btn) { btn.disabled = true; btn.textContent = " Profil oluşturuluyor..."; }
  showToast(` ${hit.title || hit.slug} yeni profil olarak ekleniyor...`, "info");

  const data = await apiPost("/api/modrinth/modpack/install", {
    slug: hit.slug,
    game_version: gameVersion,
  }, 60000);

  if (btn) { btn.disabled = false; btn.textContent = "Profil olarak kur"; }

  if (data && data.success && data.instance) {
    closeCreateInstanceModal();
    await loadInstances();
    ensurePackPolling();
    switchTab("tab-instances");
    showToast(` "${data.instance.name}" profili oluşturuldu, kurulum arka planda sürüyor.`, "success");
  } else {
    showToast(` ${(data && data.error) || "Modpack profili oluşturulamadı."}`, "error");
  }
}

async function deleteInstance(id, name) {
  const inst = getInstanceById(id);
  if (!inst) return;

  if (!window.confirm(`"${name}" profili ve içindeki tüm modlar kalıcı olarak silinecek. Emin misiniz?`)) {
    return;
  }

  const data = await apiPost("/api/instances/delete", { id }, 10000);

  if (data && data.success) {
    if (state.activeInstanceId === id) {
      state.activeInstanceId = "";
      localStorage.removeItem("cl_instance");
    }
    if (state.modrinthTargetId === id) {
      state.modrinthTargetId = "";
      localStorage.removeItem("cl_modrinth_target");
    }
    await loadInstances();
    showToast(` "${name}" profili silindi.`, "info");
  } else {
    showToast(` ${(data && data.error) || "Profil silinemedi."}`, "error");
  }
}

function renderModrinthTargetBar() {
  const select = document.getElementById("modrinthInstanceSelect");
  const hint = document.getElementById("modrinthTargetHint");
  const loaderSelect = document.getElementById("modrinthLoaderSelect");
  if (!select) return;

  select.innerHTML = "";

  if (state.instances.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Profil oluşturulmamış — önce yeni profil ekleyin";
    select.appendChild(opt);
    select.disabled = true;
    if (loaderSelect) {
      loaderSelect.disabled = false;
      const group = loaderSelect.closest(".m-filter-group");
      if (group) group.hidden = false;
    }
    if (hint) hint.textContent = "İçerik kurmak için önce bir profil oluşturun; modlar/shaderlar/doku paketleri o profilin klasörüne kurulur.";
    return;
  }

  state.instances.forEach(inst => {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.name} — MC ${inst.version} (${inst.loader})`;
    select.appendChild(opt);
  });

  const target = getModrinthTarget();
  select.value = target ? target.id : state.instances[0].id;
  select.disabled = false;

  const effective = target || state.instances[0];

  if (loaderSelect) {
    // Profil hedefi seçiliyken yükleyici profilden gelir; kullanıcıya
    // değiştirilemez bir filtre göstermek yerine gizle.
    loaderSelect.disabled = true;
    loaderSelect.value = ["fabric", "forge"].includes(effective.loader) ? effective.loader : "Tümü";
    const group = loaderSelect.closest(".m-filter-group");
    if (group) group.hidden = true;
  }

  if (hint) {
    const vanillaWarning = (effective.loader === "vanilla" && state.modrinthType === "mod") ? " • Vanilla profillere mod kurulmaz." : "";
    hint.textContent = `"${effective.name}" profiline kurulacak • MC ${effective.version} • ${effective.loader} • ${effective.mod_count || 0} mevcut mod${vanillaWarning}`;
  }
}

// ================== SÜRÜM YÖNETİMİ & KOMBİNE FİLTRELEME ==================
async function loadVersions() {
  const data = await apiGet("/api/versions", 12000);

  if (data && data.error && !state.lastVersionErrorShown) {
    state.lastVersionErrorShown = true;
    showToast(" " + data.error, "error");
  }
  if (data && Array.isArray(data.versions) && data.versions.length > 0) {
    state.versions = data.versions;
    state.installedVersions = Array.isArray(data.installed) ? data.installed : [];
  } else if (state.versions.length === 0) {
    // Core'a ulaşılamadı: uygulama asla boş kalmasın, yerel listeyle devam et
    state.versions = FALLBACK_VERSIONS.slice();
    state.installedVersions = [];
  }

  const datalist = document.getElementById("versionsDatalist");
  if (datalist) {
    datalist.innerHTML = "";
    state.versions.forEach(v => {
      const opt = document.createElement("option");
      opt.value = v.id;
      datalist.appendChild(opt);
    });
  }

  filterAndRenderVersionTable();
}

function openVersionSelectorModal() {
  const modal = document.getElementById("versionSelectorModal");
  if (!modal) return;
  modal.style.display = "flex";
  filterAndRenderVersionTable();
  const searchInp = document.getElementById("versionTableSearchInput");
  if (searchInp) setTimeout(() => searchInp.focus(), 60);
}

function closeVersionSelectorModal() {
  const modal = document.getElementById("versionSelectorModal");
  if (modal) modal.style.display = "none";
}

function selectVersion(vid) {
  state.selectedVersion = vid;
  localStorage.setItem("cl_version", vid);

  // Seçim artık YENİ PROFİL oluşturma ekranını besler: sürüm atanır,
  // önerilen loader sürümü yenilenir ve kullanıcı alttan loader seçer.
  npApplyVersion(vid);
  npFetchLoaderInfo();
  closeVersionSelectorModal();

  const ci = document.getElementById("createInstanceModal");
  if (ci && ci.style.display !== "none") {
    showToast(`Sürüm: ${vid} — şimdi mod yükleyicisini seçin`, "info");
  } else {
    showToast(`Sürüm seçildi: ${vid}`, "info");
  }
}

function formatVersionDate(rt) {
  if (!rt) return "—";
  const d = new Date(rt);
  if (isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric" });
  } catch (_) {
    return d.toISOString().slice(0, 10);
  }
}

const VERSION_TYPE_LABELS = {
  release: "Release",
  snapshot: "Snapshot",
  beta: "Beta",
  alpha: "Alpha",
  experimental: "Deneysel"
};

function filterAndRenderVersionTable() {
  const list = document.getElementById("versionCardList");
  const noResults = document.getElementById("versionNoResults");
  const countText = document.getElementById("versionFilteredCountText");
  if (!list) return;

  list.innerHTML = "";

  // Filtre pill'lerinin secili gorunumunu state ile senkronla
  document.querySelectorAll(".version-filter-cb").forEach((cb) => {
    const pill = cb.closest(".vpill");
    if (pill) pill.classList.toggle("on", cb.checked);
  });
  const query = (state.versionSearchQuery || "").toLowerCase().trim();

  const filtered = state.versions.filter(v => {
    if (state.versionFilters.optimized) {
      if (!v.is_optimized) return false;
    } else if (!state.versionFilters[v.type]) {
      return false;
    }
    if (query && !String(v.id).toLowerCase().includes(query)) return false;
    return true;
  });

  if (countText) countText.textContent = `${filtered.length} sürüm listeleniyor`;

  if (filtered.length === 0) {
    if (noResults) noResults.style.display = "block";
    return;
  }
  if (noResults) noResults.style.display = "none";

  filtered.forEach(v => {
    const isSelected = v.id === (npState.version || state.selectedVersion);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "vcard" + (isSelected ? " selected" : "");
    card.setAttribute("role", "option");
    card.setAttribute("aria-selected", isSelected ? "true" : "false");
    card.innerHTML = `
      <span class="vcard-accent" aria-hidden="true"></span>
      <span class="vcard-main">
        <span class="vcard-name">${escapeHtml(v.id)}</span>
        ${v.is_optimized ? '<span class="vcard-badge badge-opt" title="Cookie Launcher optimize profili hazır"> Optimize</span>' : ""}
        <span class="vcard-badge badge-${escapeHtml(v.type)}">${VERSION_TYPE_LABELS[v.type] || escapeHtml(v.type)}</span>
        ${isSelected ? '<span class="vcard-badge badge-current">Seçili</span>' : ""}
      </span>
      <span class="vcard-side">
        ${v.is_installed ? '<span class="vcard-installed">Yüklü</span>' : ""}
        <span class="vcard-date">${formatVersionDate(v.releaseTime)}</span>
      </span>`;
    card.addEventListener("click", () => selectVersion(v.id));
    list.appendChild(card);
  });
}

// ================== NON-BLOCKING OYUN BAŞLATMA AKIŞI ==================
function setLaunchButton(mode) {
  const btnLaunch = document.getElementById("btnLaunchGame");
  const btnText = document.getElementById("btnLaunchText");
  if (btnText) {
    const labels = {
      idle: "Oyna",
      busy: "Başlatılıyor…",
      installing: "Hazırlanıyor…",
      running: "Çalışıyor",
      noProfile: "Profil oluştur"
    };
    btnText.textContent = labels[mode] || labels.idle;
    const icon = btnLaunch ? btnLaunch.querySelector(".btn-icon") : null;
    if (icon) {
      icon.textContent = mode === "running" ? "■" : mode === "installing" ? "↓" : "▶";
    }
  }
  // noProfile modunda buton tiklanabilir kalir: tiklayinca profil olusturma acilir
  if (btnLaunch) {
    btnLaunch.disabled = (mode !== "idle" && mode !== "noProfile");
    btnLaunch.dataset.mode = mode;
  }
}

function openProgressModal() {
  const modal = document.getElementById("launchProgressModal");
  if (!modal) return;
  modal.style.display = "flex";
  state.progressOpen = true;
}

function ensureProgressModal() {
  if (state.progressDismissed) return;
  const modal = document.getElementById("launchProgressModal");
  if (!modal) return;
  if (modal.style.display === "none" || !state.progressOpen) {
    modal.style.display = "flex";
  }
  state.progressOpen = true;
}

function closeProgressModal(auto = false) {
  if (state.progressCloseTimer) {
    clearTimeout(state.progressCloseTimer);
    state.progressCloseTimer = null;
  }
  const modal = document.getElementById("launchProgressModal");
  if (modal) modal.style.display = "none";
  state.progressOpen = false;
  // Otomatik kapanma, kullanıcının "arka planda devam et" tercihini ezmemeli.
  if (!auto) state.progressDismissed = true;
}

function scheduleCloseProgressModal(delayMs) {
  if (state.progressCloseTimer) return;
  state.progressCloseTimer = setTimeout(() => {
    state.progressCloseTimer = null;
    closeProgressModal(true);
  }, delayMs);
}

function setProgressBar(percent) {
  const barFill = document.getElementById("launchProgressBarFill");
  const percentText = document.getElementById("launchProgressPercent");
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (barFill) barFill.style.width = `${value}%`;
  if (percentText) percentText.textContent = `${value}%`;
}

function setProgressTexts(status, detail, mb) {
  const statusMsg = document.getElementById("launchProgressStatusText");
  const detailMsg = document.getElementById("launchProgressDetailText");
  const mbText = document.getElementById("launchProgressMbText");

  if (statusMsg && status) statusMsg.textContent = status;
  if (detailMsg) detailMsg.textContent = detail || "";
  if (mbText) {
    const mbValue = Number(mb);
    mbText.textContent = `↓ ${(Number.isFinite(mbValue) ? mbValue : 0).toFixed(1)} MB`;
  }
}

async function handleLaunchGame(opts = {}) {
  if (state.launchRequested) return false;

  const btnLaunch = document.getElementById("btnLaunchGame");
  if (btnLaunch && btnLaunch.disabled) return false;

  const activeInst = getActiveInstance();

  // Profil yoksa hicbir surum indirilmez / oyun baslatilmaz. Kullanici once
  // profil olusturur (surum + yukleyici profile baglidir).
  if (!activeInst) {
    showToast("Başlatmak için önce bir profil oluşturun veya seçin.", "info");
    switchTab("tab-instances");
    setTimeout(() => openCreateInstanceModal(), 220);
    return false;
  }

  const versionToLaunch = activeInst.version;

  state.launchRequested = true;
  state.progressDismissed = false;
  state.progressCloseTimer = null;
  state.lastErrorShown = null;

  openProgressModal();
  setLaunchButton("busy");
  setProgressBar(2);
  setProgressTexts(
    "Oyun hazırlanıyor...",
    opts.quickPlayMultiplayer
      ? "Arkadaşının dünyasına bağlanılıyor..."
      : (activeInst ? `"${activeInst.name}" profili başlatılıyor...` : "Arka plan servisine bağlanılıyor..."),
    0
  );

  const payload = {
    username: state.username,
    version: versionToLaunch,
    loader: activeInst.loader,
    cookie_optimized: state.cookieOptimize,
    ram: state.ram,
    jvm_preset: "aikar"
  };
  payload.instance_id = activeInst.id;
  if (opts.quickPlayMultiplayer) {
    payload.quick_play_multiplayer = String(opts.quickPlayMultiplayer);
  }

  let accepted = false;
  let backendError = null;

  for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
    const data = await apiPost("/api/launch", payload, 15000);

    if (data && data.success) {
      accepted = true;
      break;
    }
    if (data && data.error) {
      backendError = data.error;
      break;
    }
    if (attempt === 1) {
      setProgressTexts("Oyun hazırlanıyor...", "Core servisi yanıt vermedi, yeniden deneniyor...", 0);
    }
    await sleep(700);
  }

  if (accepted) {
    state.launchAcceptedAt = Date.now();
    setLastPlayed(activeInst.id);
    setProgressTexts("Başlatma isteği kabul edildi", "İndirme akışı arka planda sürüyor...", 0);
    return true;
  }

  // İstek kabul edilmedi: modalı kapat, butonu eski haline getir, tek seferlik bilgi ver
  state.launchRequested = false;
  closeProgressModal(true);
  state.engineMode = "idle";
  setLaunchButton(getActiveInstance() ? "idle" : "noProfile");
  showErrorOnce(backendError || "Core servisine ulaşılamadı. Arka plan servisini yeniden başlatın.");
  return false;
}

// ================== CANLI DURUM & İLERLEME POLLING ==================
function startStatusPolling() {
  if (state.isPollingStatus) return;
  state.isPollingStatus = true;
  state.statusTimer = setInterval(pollStatus, 700);
}

async function pollStatus() {
  // 700 ms'lik interval, 5 s'lik isteğin üstüne binmemeli.
  if (state.pollInFlight) return;
  state.pollInFlight = true;
  state.pollTick++;

  try {
    const data = await apiGet("/api/status", 5000);

    if (!data) {
      state.coreFailCount++;
      if (state.coreFailCount >= 3) {
        const engineStatus = document.getElementById("engineStatusText");
        if (engineStatus) engineStatus.textContent = "Core bekleniyor...";
        const statusWrap = document.getElementById("railCoreStatus");
        if (statusWrap) statusWrap.dataset.state = "offline";
        const statusBar = document.getElementById("statusBar");
        if (statusBar) statusBar.dataset.state = "offline";
        const statusCore = document.getElementById("statusCoreText");
        if (statusCore) statusCore.textContent = "Core bekleniyor";
        const settingsCore = document.getElementById("settingsCoreText");
        if (settingsCore) settingsCore.textContent = "Bekleniyor";
      }
      // Her ~7 saniyede bir portu yeniden keşfetmeyi dene
      if (state.coreFailCount % 10 === 0) {
        await detectApiBase();
      }
      return;
    }

    state.coreFailCount = 0;
    updateProgressUI(data);

    // Konsol loglarını daha seyrek güncelle (gereksiz yükü önler)
    if (state.pollTick % 3 === 0) {
      const logData = await apiGet("/api/logs", 5000);
      const cOut = document.getElementById("consoleOutput");
      if (logData && Array.isArray(logData.logs) && cOut) {
        cOut.textContent = logData.logs.join("\n");
        if (isConsoleAutoscrollEnabled()) cOut.scrollTop = cOut.scrollHeight;
      }
    }
  } finally {
    state.pollInFlight = false;
  }
}

function updateEngineStatus(installing, running) {
  const engineStatus = document.getElementById("engineStatusText");
  const statusWrap = document.getElementById("railCoreStatus");
  const mode = running ? "running" : (installing ? "busy" : "ready");
  if (statusWrap) statusWrap.dataset.state = mode;
  const statusBar = document.getElementById("statusBar");
  if (statusBar) statusBar.dataset.state = mode;
  const label = running ? "Oyun çalışıyor" : (installing ? "Hazırlanıyor" : "Core hazır");
  if (engineStatus) engineStatus.textContent = label;
  const statusCore = document.getElementById("statusCoreText");
  if (statusCore) statusCore.textContent = label;
  const settingsCore = document.getElementById("settingsCoreText");
  if (settingsCore) settingsCore.textContent = running ? "Çalışıyor" : (installing ? "Meşgul" : "Hazır");
}

function updateProgressUI(data) {
  const installing = !!data.is_installing;
  const running = !!data.is_running;
  const error = data.error || null;

  updateEngineStatus(installing, running);

  // 1. İndirme / Hazırlama sürüyor
  if (installing) {
    state.launchRequested = true;
    state.progressCloseTimer = null;
    ensureProgressModal();
    setProgressBar(data.percent || 2);
    setProgressTexts(data.status || "Hazırlanıyor...", data.detail || "", data.downloaded_mb);
    state.engineMode = "installing";
    setLaunchButton("installing");
    return;
  }

  // 2. Oyun başarıyla açıldı
  if (running) {
    if (!state.progressDismissed) {
      ensureProgressModal();
      setProgressBar(100);
      setProgressTexts("Oyun başarıyla açıldı", "İyi oyunlar.", data.downloaded_mb);
      scheduleCloseProgressModal(1200);
    }
    state.launchRequested = false;
    state.engineMode = "running";
    setLaunchButton("running");
    return;
  }

  // 3. Boşta
  // Launch POST'undan hemen sonra gelen eski bir "idle" yanıtı, henüz
  // başlamamış kurulumu iptal etmiş gibi göstermemeli.
  if (state.launchRequested && (Date.now() - (state.launchAcceptedAt || 0)) < 2500) {
    return;
  }
  if (state.launchRequested) {
    state.launchRequested = false;
    closeProgressModal(true);
  }
  if (error) {
    showErrorOnce(error);
    closeProgressModal(true);
    apiPost("/api/clear-error", {}, 5000);
  }
  state.engineMode = "idle";
  setLaunchButton(getActiveInstance() ? "idle" : "noProfile");
}

// ================== MODRINTH İÇERİK MERKEZİ ==================
function contentCategoryFromType(type) {
  if (type === "shader") return "shader";
  if (type === "resourcepack") return "resourcepack";
  return "mod";
}

function isContentInstalled(hit, category) {
  if (!hit || category === "modpack") return false;
  const cat = category || contentCategoryFromType(hit.project_type || state.modrinthType);
  const slug = String(hit.slug || "").toLowerCase();
  if (!slug) return false;

  // Yüklü içerik verisi başka bir profile aitse "yüklü" damgası gösterme.
  const currentTargetId = String((getModrinthTarget() || {}).id || "");
  if (!currentTargetId || state.installedContentInstanceId !== currentTargetId) return false;

  const meta = state.installedContentMeta[cat] || {};
  if (meta[slug]) return true;

  const files = (state.installedContent[cat] || []).map(f => String(f.name || "").toLowerCase());
  const patterns = [slug, slug.replace(/-/g, "_"), slug.replace(/_/g, "-")];
  return files.some(name =>
    patterns.some(p =>
      name === `${p}.jar` ||
      name === `${p}.zip` ||
      name.startsWith(`${p}-`) ||
      name.startsWith(`${p}_`) ||
      name.includes(`-${p}-`) ||
      name.includes(`_${p}_`)
    )
  );
}

async function refreshInstalledContent() {
  state.installedModSlugs = new Set();
  state.installedModFiles = [];
  state.installedContent = { mod: [], shader: [], resourcepack: [] };
  state.installedContentMeta = { mod: {}, shader: {}, resourcepack: {} };

  const target = getModrinthTarget();
  const targetId = target ? String(target.id || "") : "";
  state.installedContentInstanceId = "";
  state.installedLoading = !!target;
  state.contentLoadFailed = false;
  renderInstalledPanel();
  if (!target) {
    state.installedLoading = false;
    return;
  }

  const data = await apiGet(`/api/instances/content?instance_id=${encodeURIComponent(targetId)}`, 8000);
  // Kullanıcı bu sırada profil değiştirdiyse eski yanıtı uygulamaya sokma.
  if (String((getModrinthTarget() || {}).id || "") !== targetId) return;
  state.installedLoading = false;
  if (!data || data.success !== true) {
    state.contentLoadFailed = true;
    renderInstalledPanel();
    if (!state.coreModsWarned) {
      state.coreModsWarned = true;
      showToast("Core güncel değil: yüklü içerik listesi için launcher'ı yeniden başlatın.", "info");
    }
    return;
  }
  state.contentLoadFailed = false;
  state.installedContentInstanceId = targetId;

  const categories = data.categories || {};
  ["mod", "shader", "resourcepack"].forEach(cat => {
    const files = (categories[cat] && categories[cat].files) || [];
    state.installedContent[cat] = Array.isArray(files) ? files : [];
    state.installedContent[cat].forEach(f => {
      if (f && f.slug) state.installedContentMeta[cat][String(f.slug).toLowerCase()] = f;
    });
  });

  state.installedModSlugs = new Set(Object.keys(state.installedContentMeta.mod));
  state.installedModFiles = state.installedContent.mod.map(f => f.name);
  renderInstalledPanel();
}

function ensureVersionButton(card, installed) {
  if (!card) return;
  const type = card.getAttribute("data-project-type") || "mod";
  const actions = card.querySelector(".mod-card-actions") || card.querySelector(".mod-bottom-row");
  let btn = card.querySelector(".btn-mod-ver");
  const wanted = installed && type !== "modpack";

  if (wanted && !btn && actions) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-mod-ver";
    btn.title = "Bu içeriğin başka bir sürümünü kur";
    btn.textContent = "Sürüm değiştir";
    btn.addEventListener("click", () => {
      openVersionSwitchOverlay({
        slug: card.getAttribute("data-slug") || "",
        title: card.getAttribute("data-title") || "",
        cat: card.getAttribute("data-project-type") || "mod",
        iconUrl: card.getAttribute("data-icon") || "",
        instance: getModrinthTarget()
      });
    });
    actions.appendChild(btn);
  } else if (!wanted && btn) {
    btn.remove();
  }
}

function applyInstalledStates() {
  document.querySelectorAll(".mod-card[data-slug]").forEach(card => {
    const slug = card.getAttribute("data-slug");
    const type = card.getAttribute("data-project-type") || "mod";
    const installed = type !== "modpack" &&
      isContentInstalled({ slug: slug, project_type: type }, contentCategoryFromType(type));

    if (installed) {
      card.classList.add("installed");
      const btn = card.querySelector(".btn-mod-dl");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Yüklü";
      }
      ensureVersionButton(card, true);
      if (state.hideInstalled) {
        card.style.display = "none";
        return;
      }
    } else {
      card.classList.remove("installed");
      const btn = card.querySelector(".btn-mod-dl");
      if (btn && btn.dataset.kind !== "modpack") {
        btn.disabled = false;
        btn.textContent = "Kur";
      }
      ensureVersionButton(card, false);
    }
    card.style.display = "";
  });
}

function renderInstalledPanel() {
  const wrap = document.getElementById("installedListWrap");
  if (!wrap) return;

  const target = getModrinthTarget();
  const profileEl = document.getElementById("installedPanelProfile");
  if (profileEl) profileEl.textContent = target ? `— ${target.name}` : "— profil seçilmedi";

  const counts = {
    mod: (state.installedContent.mod || []).length,
    shader: (state.installedContent.shader || []).length,
    resourcepack: (state.installedContent.resourcepack || []).length
  };
  const setCount = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setCount("installedCountMod", counts.mod);
  setCount("installedCountShader", counts.shader);
  setCount("installedCountResourcepack", counts.resourcepack);

  const cat = state.installedCategory || "mod";
  const files = state.installedContent[cat] || [];
  const icons = { mod: "M", shader: "S", resourcepack: "R" };
  wrap.innerHTML = "";

  if (!target) {
    wrap.innerHTML = `<div class="empty-state empty-state-compact">
      <div class="empty-state-icon" aria-hidden="true">—</div>
      <h3 class="empty-state-title">Kurulum hedefi seçilmedi</h3>
      <p class="empty-state-desc">Yönetmek için üstten bir profil seçin.</p>
    </div>`;
    return;
  }
  if (state.contentLoadFailed) {
    wrap.innerHTML = `<div class="empty-state empty-state-compact">
      <div class="empty-state-icon" aria-hidden="true">—</div>
      <h3 class="empty-state-title">İçerik listesi alınamadı</h3>
      <p class="empty-state-desc">Core eski sürümde olabilir; launcher'ı kapatıp yeniden başlatın.</p>
    </div>`;
    return;
  }
  if (state.installedLoading && files.length === 0) {
    wrap.innerHTML = `<div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>`;
    return;
  }
  if (files.length === 0) {
    const labels = { mod: "mod", shader: "shader", resourcepack: "doku paketi" };
    wrap.innerHTML = `<div class="empty-state empty-state-compact">
      <div class="empty-state-icon" aria-hidden="true">${icons[cat] || "M"}</div>
      <h3 class="empty-state-title">Bu profilde henüz ${labels[cat]} yok</h3>
      <p class="empty-state-desc">Modrinth sekmesinden içerik kurarak başlayın.</p>
    </div>`;
    return;
  }

  files.forEach(f => {
    const row = document.createElement("div");
    row.className = "installed-row ui-row";

    const sizeText = f.size >= 1048576
      ? `${(f.size / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round((f.size || 0) / 1024))} KB`;

    const displayName = (f.display_name && String(f.display_name).trim()) || cleanContentName(f.name);

    const metaParts = [];
    if (f.mod_id) metaParts.push(f.mod_id);
    if (f.version) metaParts.push(`v${f.version}`);
    metaParts.push(sizeText);

    const iconSpan = document.createElement("span");
    iconSpan.className = "installed-row-icon";
    iconSpan.textContent = icons[cat] || "M";
    if (f.has_icon) {
      const img = document.createElement("img");
      img.className = "installed-row-icon-img";
      img.alt = "";
      img.loading = "lazy";
      img.src = `${API_BASE}/api/instances/content/icon?instance_id=${encodeURIComponent(target.id)}` +
        `&category=${encodeURIComponent(cat)}&name=${encodeURIComponent(f.name)}&t=${Math.round(f.mtime || 0)}`;
      img.addEventListener("error", () => {
        img.remove();
        iconSpan.textContent = icons[cat] || "M";
      });
      iconSpan.textContent = "";
      iconSpan.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "installed-row-info";
    info.innerHTML = `
      <div class="installed-row-name" title="${escapeHtml(f.description || f.name)}">${escapeHtml(displayName)}</div>
      <div class="installed-row-meta">${escapeHtml(metaParts.join(" • "))}</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "btn-installed-delete btn btn-ghost btn-danger-ghost";
    delBtn.title = "Bu içeriği profilden kaldır";
    delBtn.setAttribute("aria-label", "Bu içeriği profilden kaldır");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", () => deleteInstalledContent(cat, f.name));

    row.appendChild(iconSpan);
    row.appendChild(info);
    row.appendChild(delBtn);
    wrap.appendChild(row);
  });
}

function cleanContentName(name) {
  let n = String(name || "").replace(/\.(jar|zip)$/i, "");
  n = n.replace(/[-_+ ]v?\d[\w.+\-]*$/i, "").trim();
  return n || String(name || "");
}

async function deleteInstalledContent(category, name) {
  const target = getModrinthTarget();
  if (!target) return;
  const targetId = String(target.id || "");

  const ok = await showConfirmDialog({
    icon: "!",
    title: "İçerik silinsin mi?",
    message: `"${name}" dosyası "${target.name}" profilinden kalıcı olarak silinecek. Bu işlem geri alınamaz.`,
    okText: "Sil",
    danger: true
  });
  if (!ok) return;

  // Onay beklenirken profil değiştiyse yanlış profilden silme.
  if (String((getModrinthTarget() || {}).id || "") !== targetId) {
    showToast("Profil değişti; silme işlemi iptal edildi.", "info");
    return;
  }

  const data = await apiPost("/api/instances/content/delete", {
    instance_id: targetId,
    category: category,
    name: name
  }, 15000);

  if (data && data.success) {
    showToast(`${name} silindi.`, "success");
    await refreshInstalledContent();
    applyInstalledStates();
    loadInstances();
  } else {
    showToast(` ${(data && data.error) || "Dosya silinemedi."}`, "error");
  }
}

function showConfirmDialog(options = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById("confirmModal");
    if (!modal) {
      resolve(window.confirm(options.message || ""));
      return;
    }

    const iconEl = document.getElementById("confirmModalIcon");
    const titleEl = document.getElementById("confirmModalTitle");
    const msgEl = document.getElementById("confirmModalMessage");
    const okBtn = document.getElementById("btnConfirmOk");
    const cancelBtn = document.getElementById("btnConfirmCancel");

    if (iconEl) iconEl.textContent = options.icon || "";
    if (titleEl) titleEl.textContent = options.title || "Emin misiniz?";
    if (msgEl) msgEl.textContent = options.message || "";
    if (okBtn) {
      okBtn.textContent = options.okText || "Onayla";
      okBtn.className = options.danger ? "btn-confirm-danger" : "btn-primary-action";
      okBtn.disabled = false;
    }

    let settled = false;
    const cleanup = (value) => {
      if (settled) return;
      settled = true;
      modal.style.display = "none";
      // onclick ataması önceki diyaloğun handler'ını da ezdiği için çift
      // tıklamada iki silme isteği gitmez.
      if (okBtn) okBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      resolve(value);
    };
    const onOk = () => {
      if (okBtn) okBtn.disabled = true;
      cleanup(true);
    };
    const onCancel = () => cleanup(false);

    if (okBtn) okBtn.onclick = onOk;
    if (cancelBtn) cancelBtn.onclick = onCancel;
    modal.style.display = "flex";
  });
}

function buildModCard(hit, index) {
  const target = getModrinthTarget();
  const isModpack = (hit.project_type === "modpack") || (state.modrinthType === "modpack");
  const category = contentCategoryFromType(hit.project_type || state.modrinthType);
  const installed = !isModpack && isContentInstalled(hit, category);

  const card = document.createElement("div");
  card.className = "mod-card" + (installed ? " installed" : "");
  card.dataset.slug = hit.slug || "";
  card.dataset.projectType = isModpack ? "modpack" : category;
  card.dataset.title = hit.title || hit.slug || "";
  card.dataset.icon = hit.icon_url || "";
  card.style.animationDelay = `${Math.min(index * 0.03, 0.5)}s`;

  const iconBox = document.createElement("div");
  iconBox.className = "mod-icon-box";
  if (hit.icon_url) {
    const img = document.createElement("img");
    img.src = hit.icon_url;
    img.alt = hit.title || "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove();
      iconBox.textContent = isModpack ? "P" : "M";
    });
    iconBox.appendChild(img);
  } else {
    iconBox.textContent = isModpack ? "P" : "M";
  }

  let buttonLabel = "Kur";
  if (isModpack) buttonLabel = "Profil olarak kur";
  else if (installed) buttonLabel = "Yüklü";

  const content = document.createElement("div");
  content.className = "mod-content";
  content.innerHTML = `
    <h4 class="mod-title" title="${escapeHtml(hit.title)}">${escapeHtml(hit.title)}</h4>
    <p class="mod-desc">${escapeHtml(hit.description || "Açıklama bulunmuyor.")}</p>
    <div class="mod-bottom-row">
      <span style="font-size: 11px; color: var(--text-muted);">↓ ${(hit.downloads || 0).toLocaleString()}</span>
      ${installed ? '<span class="mod-installed-chip">Bu profilde yüklü</span>' : ""}
      ${!installed && target ? `<span class="mod-target-chip" title="Kurulum hedefi: ${escapeHtml(target.name)}">${escapeHtml(target.name)}</span>` : ""}
      <span class="mod-card-actions">
        <button class="btn-mod-dl" data-kind="${isModpack ? "modpack" : category}">${buttonLabel}</button>
      </span>
    </div>
  `;

  const dlButton = content.querySelector(".btn-mod-dl");
  if (dlButton) {
    if (installed) {
      dlButton.disabled = true;
    } else {
      dlButton.addEventListener("click", () => installModrinthProject(hit, dlButton));
    }
  }

  if (installed && state.hideInstalled) {
    card.style.display = "none";
  }

  card.appendChild(iconBox);
  card.appendChild(content);
  ensureVersionButton(card, installed);
  return card;
}

function updateModrinthFooter(total = 0) {
  const wrap = document.getElementById("modrinthResultsWrap");
  if (!wrap) return;

  let footer = document.getElementById("modrinthLoadMore");
  if (!footer) {
    footer = document.createElement("div");
    footer.id = "modrinthLoadMore";
    footer.className = "loading-state modrinth-load-more";
    wrap.appendChild(footer);
  }

  if (state.modrinthLoading) {
    footer.innerHTML = `<div class="spinner"></div><span>Daha fazla içerik yükleniyor...</span>`;
  } else if (state.modrinthHasMore) {
    footer.innerHTML = `<span>↓ Kaydırdıkça daha fazla içerik otomatik yüklenecek...</span>`;
  } else if (state.modrinthHits.length > 0) {
    footer.innerHTML = `<span> Tüm sonuçlar yüklendi (${state.modrinthHits.length}${total ? "/" + total : ""}).</span>`;
  } else {
    footer.innerHTML = "";
  }
}

async function fetchModrinth(reset = true) {
  const wrap = document.getElementById("modrinthResultsWrap");
  if (!wrap) return;
  if (!reset && (!state.modrinthHasMore || state.modrinthLoading)) return;

  // Her yeni arama öncekini geçersiz kılar; geç gelen eski yanıt yok sayılır.
  const reqId = ++state.modrinthReqId;
  const isCurrent = () => reqId === state.modrinthReqId;

  state.modrinthLoading = true;

  if (reset) {
    state.modrinthOffset = 0;
    state.modrinthHits = [];
    state.modrinthHasMore = true;
    wrap.innerHTML = `<div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>`;
    // Yüklü içerik kontrolünü aramanın önüne koyma; paralel çalışsın.
    refreshInstalledContent().then(() => {
      if (isCurrent()) applyInstalledStates();
    });
  } else {
    updateModrinthFooter();
  }

  const target = getModrinthTarget();
  const effectiveVersion = target ? target.version : (state.selectedVersion || "");
  const effectiveLoader = target
    ? (target.loader === "vanilla" ? "Tümü" : target.loader)
    : (state.modrinthLoader || "fabric");

  const params = new URLSearchParams({
    q: state.modrinthQuery || "",
    type: state.modrinthType || "mod",
    version: effectiveVersion,
    loader: effectiveLoader,
    sort: state.modrinthSort || "downloads",
    limit: state.modrinthLimit,
    offset: state.modrinthOffset
  });

  const data = await apiGet(`/api/modrinth/search?${params.toString()}`, 15000);
  if (!isCurrent()) return;
  state.modrinthLoading = false;

  if (data && data.error) {
    if (reset) {
      wrap.innerHTML = `
        <div class="loading-state">
          <span class="np-net-error"> ${escapeHtml(data.error)}</span>
          <span class="np-net-hint">Ağ testi: <code>http://127.0.0.1:18420/api/net-test</code> adresini tarayıcıda açın.</span>
        </div>`;
      state.modrinthHasMore = false;
      updateModrinthFooter();
    }
    showNetErrorOnce(data.error);
    return;
  }

  if (!data) {
    state.modrinthHasMore = false;
    updateModrinthFooter();
    if (reset) {
      wrap.innerHTML = `<div class="loading-state"><span>Modrinth şu anda yanıt vermiyor. Daha sonra tekrar deneyin.</span></div>`;
    }
    return;
  }

  const hits = Array.isArray(data.hits) ? data.hits : [];
  const total = Number(data.total_hits) || 0;
  state.modrinthOffset += hits.length;
  state.modrinthHasMore = hits.length > 0 && (total === 0 || state.modrinthOffset < total);

  if (reset) {
    state.modrinthHits = hits;
    wrap.innerHTML = "";
  } else {
    state.modrinthHits = state.modrinthHits.concat(hits);
  }

  if (state.modrinthHits.length === 0) {
    wrap.innerHTML = `<div class="loading-state"><span>Aradığınız kriterlere uygun içerik bulunamadı.</span></div>`;
    state.modrinthHasMore = false;
    return;
  }

  const footer = document.getElementById("modrinthLoadMore");
  const startIndex = reset ? 0 : state.modrinthHits.length - hits.length;
  hits.forEach((hit, i) => {
    const card = buildModCard(hit, startIndex + i);
    if (footer) wrap.insertBefore(card, footer);
    else wrap.appendChild(card);
  });

  updateModrinthFooter(total);
}

async function installModrinthProject(hit, buttonEl) {
  const isModpack = (hit.project_type === "modpack") || (state.modrinthType === "modpack");
  if (isModpack) {
    await installModpackAsProfile(hit, buttonEl);
    return;
  }

  if (buttonEl && buttonEl.disabled) return;
  if (buttonEl) buttonEl.disabled = true;
  const release = () => { if (buttonEl) buttonEl.disabled = false; };

  const category = contentCategoryFromType(hit.project_type || state.modrinthType);
  const target = getModrinthTarget();

  // Hedef profil yoksa sessizce nereye kurulacağı belirsiz olmasın: profil oluşturmaya yönlendir
  if (!target) {
    release();
    showToast("İçerik kurmak için önce bir profil oluşturun.", "info");
    openCreateInstanceModal();
    return;
  }

  if (category === "mod" && target.loader === "vanilla") {
    release();
    showToast("Vanilla profil mod yüklemez. PROFİLLER sekmesinden Fabric/Forge profili seçin.", "info");
    return;
  }

  // Shader / doku paketlerinde sürüm tam eşleşmiyorsa kullanıcıdan onay al
  if (category !== "mod") {
    const params = new URLSearchParams({
      slug: hit.slug || "",
      version: target.version || "",
      type: category,
      loader: target.loader || ""
    });
    const check = await apiGet(`/api/modrinth/check?${params.toString()}`, 12000);

    if (check && check.has_file === false) {
      release();
      showToast("Bu paket için indirilebilir dosya bulunamadı.", "error");
      return;
    }

    if (check && check.has_file && !check.exact_match) {
      const ok = await showConfirmDialog({
        icon: "!",
        title: "Sürüm tam eşleşmiyor",
        message: `Bu paket oyun sürümünüzle (MC ${target.version}) tam eşleşmiyor (en yakın: ${check.matched_game_version || "bilinmiyor"}). Çoğu zaman sorunsuz çalışır. Yine de indirmek ister misiniz?`,
        okText: "Yine de indir"
      });
      if (!ok) { release(); return; }
    }
  }

  release();
  await downloadModrinthProject(hit, buttonEl, { category, force: category !== "mod", targetId: target.id });
}

async function installModpackAsProfile(hit, buttonEl) {
  const target = getModrinthTarget();
  const gameVersion = target ? target.version : (state.selectedVersion || "");
  const originalText = buttonEl ? buttonEl.textContent : null;

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = " Profil oluşturuluyor...";
  }

  showToast(` ${hit.title || hit.slug} yeni profil olarak ekleniyor...`, "info");

  const data = await apiPost("/api/modrinth/modpack/install", {
    slug: hit.slug,
    game_version: gameVersion
  }, 60000);

  if (buttonEl) {
    buttonEl.disabled = false;
    buttonEl.textContent = originalText || "Profil olarak kur";
  }

  if (data && data.success && data.instance) {
    await loadInstances();
    ensurePackPolling();
    switchTab("tab-instances");
    showToast(` "${data.instance.name}" profili oluşturuldu, kurulum arka planda sürüyor.`, "success");
  } else {
    showToast(` ${(data && data.error) || "Modpack profili oluşturulamadı."}`, "error");
  }
}

async function downloadModrinthProject(hit, buttonEl, opts = {}) {
  const slug = typeof hit === "string" ? hit : (hit && hit.slug);
  if (!slug) return;

  const category = opts.category || "mod";
  const force = opts.force === true;
  const expectedTargetId = opts.targetId ? String(opts.targetId) : "";
  const target = getModrinthTarget();

  if (!target) {
    showToast("İçerik kurmak için önce bir profil oluşturun.", "info");
    openCreateInstanceModal();
    return;
  }
  if (expectedTargetId && String(target.id) !== expectedTargetId) {
    showToast("Profil değişti; kurulum iptal edildi.", "info");
    return;
  }

  const originalText = buttonEl ? buttonEl.textContent : null;
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = "Kuruluyor...";
  }

  const typeLabels = { mod: "Mod", shader: "Shader", resourcepack: "Doku paketi" };
  showToast(` ${typeLabels[category] || "İçerik"} → "${target.name}" profiline indiriliyor...`, "info");

  const data = await apiPost("/api/modrinth/install", {
    slug: slug,
    version: target.version,
    loader: target.loader,
    instance_id: target.id,
    project_type: category,
    force: force,
    install_dependencies: getInstallDepsPref()
  }, 180000);

  // Backend tam uyum olmadigini bildirdiyse onay isteyip tekrar dene
  if (data && data.needs_confirm) {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = originalText || "Kur";
    }
    const ok = await showConfirmDialog({
      icon: "",
      title: "Sürüm Tam Eşleşmiyor",
      message: `${data.message || "Bu paket sürümünüzle tam eşleşmiyor olabilir."} Yine de indirmek ister misiniz?`,
      okText: "Yine de İndir"
    });
    if (ok) {
      await downloadModrinthProject(hit, buttonEl, { category, force: true, targetId: expectedTargetId });
    }
    return;
  }

  if (buttonEl) {
    buttonEl.disabled = false;
    buttonEl.textContent = originalText || "Kur";
  }

  if (data && data.success) {
    const warning = data.exact_match === false ? " (sürüm tam eşleşmiyor)" : "";
    if (data.installed_dependencies || data.failed_dependencies) {
      modInstallToast(String((hit && hit.title) || slug), data);
    } else {
      showToast(` ${data.filename || slug} → "${target.name}" profiline kuruldu${warning}.`, "success");
    }
    await refreshInstalledContent();
    applyInstalledStates();
    loadInstances();
  } else if (data && data.error) {
    showToast(` ${data.error}`, "error");
  } else {
    showToast(" İndirme isteği tamamlanamadı, tekrar deneyin.", "error");
  }
}

// ================== GALERİ (EKRAN GÖRÜNTÜLERİ) ==================
async function loadScreenshots() {
  const wrap = document.getElementById("screenshotsGridWrap");
  if (!wrap) return;

  const data = await apiGet("/api/screenshots", 10000);
  wrap.innerHTML = "";

  if (!data) {
    wrap.innerHTML = `<div class="loading-state" style="grid-column: 1/-1;"><span>Galeriye şu anda ulaşılamıyor.</span></div>`;
    return;
  }

  const shots = Array.isArray(data.screenshots) ? data.screenshots : [];
  if (shots.length === 0) {
    wrap.innerHTML = `<div class="loading-state" style="grid-column: 1/-1;"><span>Henüz ekran görüntüsü alınmamış (Oyunda F2 tuşuna basın).</span></div>`;
    return;
  }

  shots.forEach(sc => {
    const url = `${API_BASE}/api/screenshots/file?name=${encodeURIComponent(sc.name)}` +
      `&t=${Math.round(sc.mtime || 0)}`;
    const card = document.createElement("div");
    card.className = "gallery-card";
    card.innerHTML = `
      <div class="gallery-thumb">
        <img loading="lazy" src="${url}" alt="${escapeHtml(sc.name)}">
      </div>
      <div class="gallery-meta">
        <span>${escapeHtml(sc.name)}</span>
        <span>${Math.round((sc.size || 0) / 1024)} KB</span>
      </div>
    `;
    const img = card.querySelector("img");
    if (img) {
      img.addEventListener("error", () => {
        img.remove();
        const thumb = card.querySelector(".gallery-thumb");
        if (thumb) thumb.textContent = "—";
      });
    }
    card.addEventListener("click", () => openGalleryLightbox(url));
    wrap.appendChild(card);
  });
}

function openGalleryLightbox(url) {
  const box = document.getElementById("galleryLightbox");
  const img = document.getElementById("galleryLightboxImg");
  if (!box || !img || !url) return;
  img.src = url;
  box.classList.add("show");
  box.setAttribute("aria-hidden", "false");
}

function closeGalleryLightbox() {
  const box = document.getElementById("galleryLightbox");
  const img = document.getElementById("galleryLightboxImg");
  if (box) {
    box.classList.remove("show");
    box.setAttribute("aria-hidden", "true");
  }
  if (img) img.removeAttribute("src");
}

// ================== SİSTEM KLASÖRÜ AÇMA ==================
async function openSystemFolder(folderName) {
  await apiPost("/api/open-folder", { folder: folderName || "" }, 8000);
}

// ================== TAURI NATIVE PENCERE KONTROLLERİ ==================
function setupTauriWindowControls() {
  const btnMin = document.getElementById("btnWinMinimize");
  const btnMax = document.getElementById("btnWinMaximize");
  const btnClose = document.getElementById("btnWinClose");

  if (window.__TAURI__ && window.__TAURI__.window) {
    try {
      const appWin = window.__TAURI__.window.getCurrentWindow();
      let closeApproved = false;
      if (typeof appWin.onCloseRequested === "function") {
        appWin.onCloseRequested(async (event) => {
          if (closeApproved) return;
          const busy = state.engineMode === "installing" || state.engineMode === "running" || state.launchRequested;
          if (!busy) return;
          event.preventDefault();
          const ok = await showConfirmDialog({
            icon: "!",
            title: "Launcher kapatılsın mı?",
            message: "Bir kurulum veya oyun oturumu sürüyor. Kapatmak işlemi yarıda bırakabilir.",
            okText: "Yine de kapat",
            danger: true
          });
          if (ok) {
            closeApproved = true;
            cleanupTimers();
            appWin.close();
          }
        }).catch(() => {});
      }
      if (btnMin) btnMin.addEventListener("click", () => appWin.minimize());
      if (btnMax) btnMax.addEventListener("click", () => appWin.toggleMaximize());
      if (btnClose) btnClose.addEventListener("click", () => appWin.close());
      const dragRegion = document.querySelector(".titlebar-drag");
      if (dragRegion) {
        dragRegion.addEventListener("dblclick", () => appWin.toggleMaximize());
      }
      return;
    } catch (_) {}
  }

  if (btnMin) btnMin.addEventListener("click", () => window.blur());
  if (btnClose) btnClose.addEventListener("click", () => window.close());
}

/* ==============================================================================
   PROFİL DETAY EKRANI (FAZ 1)
   Tam ekran katman, 12 sekmeli dikey menü, içerik yönetimi, mod çekmecesi.
   ============================================================================== */

const PDS_CAT_INFO = {
  mod: { label: "Modlar", icon: "M", dir: "mods" },
  shader: { label: "Shader Paketleri", icon: "S", dir: "shaderpacks" },
  resourcepack: { label: "Kaynak Paketleri", icon: "R", dir: "resourcepacks" }
};

// Faz 2/3 sekmeleri: menüde görünür, içerik olarak "Yakında" kartı gösterilir.
const PDS_SOON_TABS = {
  notes: { label: "Notlar", icon: "N", folder: "notes", desc: "Profil notları sekmesi yakında: not defteri ve hızlı kayıtlar." },
  worlds: { label: "Dünyalar", icon: "W", folder: "saves", desc: "Dünya yönetimi yakında: listeleme, kopyalama ve yedekleme." },
  servers: { label: "Sunucular", icon: "", folder: "servers", desc: "Sunucu listesi yönetimi yakında: hızlı bağlantı ve favoriler." },
  screenshots: { label: "Ekran Görüntüleri", icon: "", folder: "screenshots", desc: "Profil bazlı ekran görüntüsü galerisi yakında." },
  others: { label: "Diğer Kayıtlar", icon: "", folder: "logs", desc: "Log ve crash kayıtları yönetimi yakında." }
};

const PDS_LOADER_LABELS = {
  vanilla: "Vanilla", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt"
};

const pdsState = {
  initialized: false,
  instanceId: "",
  instance: null,
  activeTab: "mods",
  content: { mod: null, shader: null, resourcepack: null },
  contentError: "",
  missingDeps: [],
  modrinth: { type: "mod", query: "", hits: [], loading: false, searched: false, reqId: 0 },
  drawerOpen: false,
  drawerKey: "",
  // Faz 3: shader mağazası durumu
  store: { open: false, query: "", sort: "downloads", hits: [], loading: false, searched: false, error: "", installed: new Set(), reqId: 0 },
  // Faz 4: profil varlıkları
  note: { loaded: false, saving: false, timer: null, lastSaved: "", pending: null, queued: null, instanceId: "" },
  worlds: null,
  servers: null,
  shots: null,
  otherLogs: null
};

function pdsEsc(value) {
  return escapeHtml(value === null || value === undefined ? "" : value);
}

function pdsLoaderLabel(loader) {
  const key = String(loader || "vanilla").toLowerCase();
  return PDS_LOADER_LABELS[key] || String(loader || "—");
}

function pdsTabForCat(cat) {
  return cat === "mod" ? "mods" : cat;
}

function initProfileDetailScreen() {
  if (pdsState.initialized) return;
  pdsState.initialized = true;

  const back = document.getElementById("pdsBackBtn");
  const close = document.getElementById("pdsCloseBtn");
  const drawerClose = document.getElementById("pdsDrawerClose");
  const backdrop = document.getElementById("pdsDrawerBackdrop");
  const storeBackdrop = document.getElementById("pdsStoreBackdrop");
  const storeClose = document.getElementById("pdsStoreClose");
  const storeSearch = document.getElementById("pdsStoreSearchBtn");
  const storeQuery = document.getElementById("pdsStoreQuery");
  const storeSort = document.getElementById("pdsStoreSort");
  const lightbox = document.getElementById("pdsLightbox");
  const lightboxClose = document.getElementById("pdsLightboxClose");

  if (back) back.addEventListener("click", closeProfileDetail);
  if (close) close.addEventListener("click", closeProfileDetail);
  if (drawerClose) drawerClose.addEventListener("click", pdsCloseDrawer);
  if (backdrop) backdrop.addEventListener("click", pdsCloseDrawer);
  if (storeBackdrop) storeBackdrop.addEventListener("click", pdsCloseShaderStore);
  if (storeClose) storeClose.addEventListener("click", pdsCloseShaderStore);
  if (storeSearch) storeSearch.addEventListener("click", pdsSearchShaderStore);
  if (storeQuery) {
    storeQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") pdsSearchShaderStore(); });
  }
  if (storeSort) {
    storeSort.addEventListener("change", () => {
      pdsState.store.sort = storeSort.value;
      pdsLoadShaderStore();
    });
  }
  if (lightboxClose) lightboxClose.addEventListener("click", pdsCloseLightbox);
  if (lightbox) {
    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox) pdsCloseLightbox();
    });
  }

  document.querySelectorAll(".pds-side-tab").forEach(btn => {
    btn.tabIndex = btn.classList.contains("active") ? 0 : -1;
    btn.addEventListener("click", () => pdsSwitchTab(btn.getAttribute("data-pds-tab")));
  });

  // Profil detayı sol menüsü: rail diliyle uyumlu ok tuşu gezinmesi
  const pdsSidebar = document.querySelector(".pds-sidebar");
  if (pdsSidebar) {
    pdsSidebar.addEventListener("keydown", (e) => {
      const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const items = Array.from(pdsSidebar.querySelectorAll(".pds-side-tab"));
      const idx = items.indexOf(document.activeElement);
      let next = 0;
      if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
      else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
      else if (e.key === "End") next = items.length - 1;
      items[next].focus();
      items[next].click();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const screen = document.getElementById("profileDetailScreen");
    if (!screen || screen.style.display === "none") return;
    // Üstte açık bir modal varsa ESC'yi ona bırak
    const modalOpen = Array.from(document.querySelectorAll(".modal-backdrop"))
      .some(m => m && m.style.display === "flex");
    if (modalOpen) return;
    const lb = document.getElementById("pdsLightbox");
    if (lb && lb.classList.contains("show")) { pdsCloseLightbox(); return; }
    if (pdsState.store.open) { pdsCloseShaderStore(); return; }
    if (pdsState.drawerOpen) { pdsCloseDrawer(); return; }
    closeProfileDetail();
  });
}

function pdsSyncInstance() {
  const fresh = getInstanceById(pdsState.instanceId);
  if (fresh) pdsState.instance = fresh;
  return pdsState.instance;
}

function openProfileDetail(instanceId, tabId) {
  const inst = getInstanceById(instanceId);
  if (!inst) {
    showToast("Profil bulunamadı.", "error");
    return;
  }

  // Önceki profilin bekleyen notunu kaydetmeye çalış (instanceId değişmeden).
  if (pdsState.note.timer) {
    clearTimeout(pdsState.note.timer);
    pdsState.note.timer = null;
  }
  if (pdsState.note.pending !== null && pdsState.note.pending !== pdsState.note.lastSaved) {
    pdsSaveNote(pdsState.note.pending, null);
  }

  pdsState.instanceId = instanceId;
  pdsState.instance = inst;
  pdsState.activeTab = tabId || "mods";
  pdsState.content = { mod: null, shader: null, resourcepack: null };
  pdsState.contentError = "";
  pdsState.missingDeps = [];
  pdsState.modrinth = { type: "mod", query: "", hits: [], loading: false, searched: false, reqId: 0 };
  pdsState.store = { open: false, query: "", sort: "downloads", hits: [], loading: false, searched: false, error: "", installed: new Set(), reqId: 0 };
  pdsState.note = { loaded: false, saving: false, timer: null, lastSaved: "", pending: null, queued: null, instanceId: instanceId };
  pdsState.worlds = null;
  pdsState.servers = null;
  pdsState.shots = null;
  pdsState.otherLogs = null;
  pdsCloseDrawer();
  pdsCloseShaderStore();
  pdsCloseLightbox();

  const screen = document.getElementById("profileDetailScreen");
  if (!screen) return;
  screen.style.display = "flex";
  screen.setAttribute("aria-hidden", "false");

  pdsRenderHeader();
  pdsSwitchTab(pdsState.activeTab);
}

function closeProfileDetail() {
  const screen = document.getElementById("profileDetailScreen");
  if (!screen) return;
  pdsCloseDrawer();
  pdsCloseShaderStore();
  pdsCloseLightbox();
  if (pdsState.note.timer) {
    clearTimeout(pdsState.note.timer);
    pdsState.note.timer = null;
    if (pdsState.note.pending !== null && pdsState.note.pending !== pdsState.note.lastSaved) {
      pdsSaveNote(pdsState.note.pending, null);
    }
  }
  screen.style.display = "none";
  screen.setAttribute("aria-hidden", "true");
}

function pdsRenderHeader() {
  const inst = pdsSyncInstance();
  if (!inst) return;

  const iconEl = document.getElementById("pdsHeadIcon");
  const nameEl = document.getElementById("pdsHeadName");
  const metaEl = document.getElementById("pdsHeadMeta");

  if (nameEl) {
    nameEl.textContent = inst.name || "Profil";
    nameEl.classList.toggle("is-long", (inst.name || "").length > 18);
    nameEl.title = inst.name || "";
  }
  if (metaEl) {
    const loaderText = pdsLoaderLabel(inst.loader) + (inst.loader_version ? ` ${inst.loader_version}` : "");
    metaEl.textContent = `MC ${inst.version || "?"} • ${loaderText} • ${inst.mod_count || 0} mod`;
  }
  if (iconEl) {
    iconEl.innerHTML = "";
    iconEl.classList.remove("pds-letter");
    if (inst.icon) {
      const img = document.createElement("img");
      img.src = inst.icon;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        iconEl.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
        iconEl.classList.add("pds-letter");
      });
      iconEl.appendChild(img);
    } else {
      iconEl.textContent = (inst.name || "?").trim().charAt(0).toUpperCase() || "?";
      iconEl.classList.add("pds-letter");
    }
  }
}

function pdsSwitchTab(tabId) {
  // Notlar sekmesinden çıkarken bekleyen otomatik kaydı hemen tamamla
  if (pdsState.activeTab === "notes" && pdsState.note.timer && pdsState.note.pending !== null) {
    clearTimeout(pdsState.note.timer);
    pdsState.note.timer = null;
    pdsSaveNote(pdsState.note.pending, null);
  }
  pdsState.activeTab = tabId;
  document.querySelectorAll(".pds-side-tab").forEach(btn => {
    const active = btn.getAttribute("data-pds-tab") === tabId;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
    btn.tabIndex = active ? 0 : -1;
  });

  const content = document.getElementById("pdsContent");
  if (!content) return;
  content.scrollTop = 0;
  content.innerHTML = "";

  const pane = document.createElement("div");
  pane.className = "pds-pane";
  content.appendChild(pane);

  if (tabId === "logs") return pdsRenderLogsTab(pane);
  if (tabId === "version") return pdsRenderVersionTab(pane);
  if (tabId === "modrinth") return pdsRenderModrinthTab(pane);
  if (tabId === "settings") return pdsRenderSettingsTab(pane);
  if (tabId === "mods") return pdsRenderContentTab(pane, "mod");
  if (tabId === "shader") return pdsRenderContentTab(pane, "shader");
  if (tabId === "resourcepack") return pdsRenderContentTab(pane, "resourcepack");
  if (tabId === "notes") return pdsRenderNotesTab(pane);
  if (tabId === "worlds") return pdsRenderWorldsTab(pane);
  if (tabId === "servers") return pdsRenderServersTab(pane);
  if (tabId === "screenshots") return pdsRenderProfileShotsTab(pane);
  if (tabId === "others") return pdsRenderOtherLogsTab(pane);
  return pdsRenderSoonTab(pane, tabId);
}

// ---------- İçerik sekmeleri (Modlar / Kaynak / Shader) ----------
function pdsRenderContentTab(pane, cat) {
  const info = PDS_CAT_INFO[cat];
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title">${info.label}</h3>
        <p class="pds-section-sub">Bu profildeki kurulu içerikler. Anahtarla aç/kapat, detaydan Modrinth bilgisine bak.</p>
      </div>
      <div class="pds-head-actions">
        ${cat === "shader" ? '<button type="button" class="btn-primary-action" id="pdsShaderStoreBtn"> Paket İndir</button>' : ""}
        <button type="button" class="btn-secondary" id="pdsRefreshBtn">↻ Yenile</button>
      </div>
    </div>
    ${cat === "mod" ? '<div class="pds-deps-warn" id="pdsDepsWarn" style="display:none;"></div>' : ""}
    <div class="pds-list" id="pdsListWrap">
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
    </div>
  `;
  const refresh = document.getElementById("pdsRefreshBtn");
  if (refresh) refresh.addEventListener("click", () => {
    pdsLoadContent(cat, true);
    if (cat === "mod") pdsLoadMissingDeps();
  });
  const storeBtn = document.getElementById("pdsShaderStoreBtn");
  if (storeBtn) storeBtn.addEventListener("click", pdsOpenShaderStore);
  pdsLoadContent(cat, false);
  if (cat === "mod") pdsLoadMissingDeps();
}

async function pdsLoadMissingDeps() {
  const warn = document.getElementById("pdsDepsWarn");
  if (!warn || pdsState.activeTab !== "mods") return;
  const instanceId = String(pdsState.instanceId || "");

  const data = await apiGet(
    `/api/instances/missing-deps?instance=${encodeURIComponent(instanceId)}`,
    20000
  );
  if (String(pdsState.instanceId || "") !== instanceId) return;
  if (pdsState.activeTab !== "mods" || !document.getElementById("pdsDepsWarn")) return;

  const missing = (data && data.missing) || [];
  pdsState.missingDeps = Array.isArray(missing) ? missing : [];

  if (!data || data.success !== true || pdsState.missingDeps.length === 0) {
    warn.style.display = "none";
    warn.innerHTML = "";
    return;
  }

  warn.style.display = "flex";
  warn.innerHTML = "";

  const text = document.createElement("span");
  text.textContent = ` ${pdsState.missingDeps.length} eksik bağımlılık`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pds-deps-warn-btn";
  btn.textContent = "Hepsini kur";
  btn.addEventListener("click", () => pdsInstallAllMissingDeps(btn));

  warn.appendChild(text);
  warn.appendChild(btn);
}

async function pdsInstallAllMissingDeps(buttonEl) {
  const inst = pdsSyncInstance();
  if (!inst) return;
  const instanceId = String(pdsState.instanceId || "");
  const missing = Array.isArray(pdsState.missingDeps) ? pdsState.missingDeps.slice() : [];
  if (missing.length === 0) return;

  if (String(inst.loader || "").toLowerCase() === "vanilla") {
    showToast("Vanilla profil mod yüklemez. Fabric/Forge profili kullanın.", "info");
    return;
  }

  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kuruluyor..."; }
  let okCount = 0;
  let failCount = 0;

  for (const dep of missing) {
    if (String(pdsState.instanceId || "") !== instanceId) break;
    const name = dep.title || dep.slug || dep.project_id || "Bağımlılık";
    showToast(`Bağımlılık kuruluyor: ${name}...`, "info");
    const data = await apiPost("/api/modrinth/install", {
      slug: dep.slug,
      version: inst.version,
      loader: inst.loader,
      instance_id: instanceId,
      project_type: "mod",
      install_dependencies: true
    }, 180000);

    if (data && data.success) {
      okCount++;
      const installed = (data.installed_dependencies || []).map(d => d.title || d.slug).join(", ");
      showToast(`${name} kuruldu${installed ? " • bağımlılıklar: " + installed : ""}`, "success");
    } else {
      failCount++;
      const reason = (data && data.error) || "bilinmeyen hata";
      console.warn("Bağımlılık kurulamadı:", dep, reason);
      showToast(`${name} kurulamadı: ${reason}`, "error");
    }
  }

  if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = "Hepsini kur"; }
  if (String(pdsState.instanceId || "") === instanceId) {
    await pdsLoadContent("mod", true);
    await pdsLoadMissingDeps();
  }
  loadInstances();
  if (okCount > 0 && failCount === 0) {
    showToast(`${okCount} eksik bağımlılık kuruldu.`, "success");
  }
}

async function pdsLoadContent(cat, force) {
  if (!pdsSyncInstance()) return;

  if (!force && pdsState.content[cat]) {
    if (pdsState.activeTab === pdsTabForCat(cat)) pdsRenderContentList(cat);
    return;
  }

  const instanceId = String(pdsState.instanceId || "");
  pdsState.contentError = "";
  const data = await apiGet(`/api/instances/content?instance_id=${encodeURIComponent(instanceId)}`, 10000);
  // Profil değiştiyse eski yanıtı yeni profilin listesine yazma.
  if (String(pdsState.instanceId || "") !== instanceId) return;
  if (!data || data.success !== true) {
    pdsState.contentError = "İçerik listesi alınamadı. Core bağlantısını kontrol edin.";
    if (pdsState.activeTab === pdsTabForCat(cat)) pdsRenderContentList(cat);
    return;
  }

  const categories = data.categories || {};
  const files = (categories[cat] && categories[cat].files) || [];
  pdsState.content[cat] = Array.isArray(files) ? files : [];
  if (pdsState.activeTab === pdsTabForCat(cat)) pdsRenderContentList(cat);
}

function pdsRenderContentList(cat) {
  const wrap = document.getElementById("pdsListWrap");
  if (!wrap) return;
  const info = PDS_CAT_INFO[cat];
  const files = pdsState.content[cat] || [];

  if (pdsState.contentError) {
    wrap.innerHTML = `<div class="pds-empty"> ${pdsEsc(pdsState.contentError)}</div>`;
    return;
  }
  if (files.length === 0) {
    wrap.innerHTML = `<div class="pds-empty">Bu profilde henüz ${info.label.toLowerCase()} yok.<br>Modrinth sekmesinden kurulum yapabilirsiniz.</div>`;
    return;
  }

  wrap.innerHTML = "";
  files.forEach(f => {
    const row = document.createElement("div");
    row.className = "pds-item" + (f.enabled === false ? " is-off" : "");

    const iconBox = document.createElement("div");
    iconBox.className = "pds-item-icon";
    iconBox.textContent = info.icon;
    if (f.has_icon) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = `${API_BASE}/api/instances/content/icon?instance_id=${encodeURIComponent(pdsState.instanceId)}` +
        `&category=${encodeURIComponent(cat)}&name=${encodeURIComponent(f.name)}&t=${Math.round(f.mtime || 0)}`;
      img.addEventListener("error", () => { img.remove(); iconBox.textContent = info.icon; });
      iconBox.textContent = "";
      iconBox.appendChild(img);
    }

    const displayName = (f.display_name && String(f.display_name).trim()) || cleanContentName(f.name);
    const sizeText = f.is_dir
      ? "klasör"
      : (f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((f.size || 0) / 1024))} KB`);

    const infoEl = document.createElement("div");
    infoEl.className = "pds-item-info";
    infoEl.innerHTML = `
      <div class="pds-item-name-line">
        <span class="pds-item-name" title="${pdsEsc(f.description || f.name)}">${pdsEsc(displayName)}</span>
        ${f.version ? `<span class="pds-ver-badge">v${pdsEsc(f.version)}</span>` : ""}
        ${f.enabled === false ? `<span class="pds-off-badge">DEVRE DIŞI</span>` : ""}
      </div>
      <div class="pds-item-meta" title="${pdsEsc(f.name)}">${pdsEsc(f.name)} • ${pdsEsc(sizeText)}</div>
    `;

    const toggle = document.createElement("label");
    toggle.className = "toggle-switch pds-toggle";
    toggle.title = f.enabled === false ? "Etkinleştir" : "Devre dışı bırak";
    toggle.innerHTML = `<input type="checkbox" ${f.enabled === false ? "" : "checked"}><span class="toggle-slider"></span>`;
    const cb = toggle.querySelector("input");
    if (cb) cb.addEventListener("change", () => pdsToggleContent(cat, f, cb));

    const actions = document.createElement("div");
    actions.className = "pds-item-actions";

    const detailBtn = document.createElement("button");
    detailBtn.type = "button";
    detailBtn.className = "pds-btn";
    detailBtn.textContent = "Detay";
    detailBtn.addEventListener("click", () => pdsOpenDrawer(f, cat));

    actions.appendChild(toggle);
    actions.appendChild(detailBtn);

    if (f.slug) {
      const verBtn = document.createElement("button");
      verBtn.type = "button";
      verBtn.className = "pds-btn pds-btn-ver";
      verBtn.title = "Bu içeriğin başka bir sürümünü kur";
      verBtn.textContent = "Sürüm";
      verBtn.addEventListener("click", () => openVersionSwitchOverlay({
        slug: f.slug,
        title: displayName,
        cat: cat,
        iconUrl: f.has_icon
          ? `${API_BASE}/api/instances/content/icon?instance_id=${encodeURIComponent(pdsState.instanceId)}` +
            `&category=${encodeURIComponent(cat)}&name=${encodeURIComponent(f.name)}&t=${Math.round(f.mtime || 0)}`
          : "",
        installedVersion: f.version || "",
        instance: pdsSyncInstance()
      }));
      actions.appendChild(verBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "pds-btn pds-btn-danger";
    delBtn.title = "Sil";
    delBtn.textContent = "Sil";
    delBtn.addEventListener("click", () => pdsDeleteContent(cat, f));
    actions.appendChild(delBtn);

    row.appendChild(iconBox);
    row.appendChild(infoEl);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
}

async function pdsToggleContent(cat, item, checkbox) {
  const instanceId = String(pdsState.instanceId || "");
  if (!instanceId) return;
  if (checkbox) checkbox.disabled = true;
  const data = await apiPost("/api/instances/content/toggle", {
    instance: instanceId,
    category: cat,
    name: item.name
  }, 15000);
  if (checkbox) checkbox.disabled = false;

  if (data && data.success) {
    showToast(data.enabled ? `Etkinleştirildi: ${data.name}` : `Devre dışı: ${data.name}`, "success");
    if (String(pdsState.instanceId || "") === instanceId) await pdsLoadContent(cat, true);
    loadInstances();
  } else {
    if (checkbox) checkbox.checked = item.enabled !== false;
    showToast(`${(data && data.error) || "İçerik güncellenemedi."}`, "error");
  }
}

async function pdsDeleteContent(cat, item) {
  const inst = pdsSyncInstance();
  const instanceId = String(pdsState.instanceId || "");
  if (!instanceId) return;
  const ok = await showConfirmDialog({
    icon: "!",
    title: "İçerik silinsin mi?",
    message: `"${item.name}" dosyası "${inst ? inst.name : "profil"}" profilinden kalıcı olarak silinecek. Bu işlem geri alınamaz.`,
    okText: "Sil",
    danger: true
  });
  if (!ok) return;
  if (String(pdsState.instanceId || "") !== instanceId) {
    showToast("Profil değişti; silme işlemi iptal edildi.", "info");
    return;
  }

  const data = await apiPost("/api/instances/content/delete", {
    instance_id: instanceId,
    category: cat,
    name: item.name
  }, 30000);

  if (data && data.success) {
    showToast(`${item.name} silindi.`, "success");
    if (pdsState.drawerOpen) pdsCloseDrawer();
    await pdsLoadContent(cat, true);
    loadInstances();
  } else {
    showToast(`${(data && data.error) || "Dosya silinemedi."}`, "error");
  }
}

// ---------- Mod detay çekmecesi ----------
function pdsOpenDrawer(item, cat) {
  const drawer = document.getElementById("pdsDrawer");
  const backdrop = document.getElementById("pdsDrawerBackdrop");
  const titleEl = document.getElementById("pdsDrawerTitle");
  const bodyEl = document.getElementById("pdsDrawerBody");
  if (!drawer || !bodyEl) return;

  pdsState.drawerOpen = true;
  const drawerKey = `${cat}:${item.name}`;
  pdsState.drawerKey = drawerKey;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  if (backdrop) backdrop.classList.add("show");

  const displayName = (item.display_name && String(item.display_name).trim()) || cleanContentName(item.name);
  if (titleEl) titleEl.textContent = displayName;
  bodyEl.innerHTML = `<div class="pds-loading"><div class="spinner"></div><span>Modrinth bilgisi yükleniyor...</span></div>`;

  const local = { item: item, cat: cat };
  if (item.slug) {
    apiGet(`/api/modrinth/project?slug=${encodeURIComponent(item.slug)}`, 15000).then(data => {
      if (!pdsState.drawerOpen || pdsState.drawerKey !== drawerKey) return;
      if (data && data.success) {
        pdsRenderProjectDrawer(data, local);
      } else {
        pdsRenderLocalDrawer(local, (data && data.error) || "Modrinth bilgisi alınamadı.");
      }
    });
  } else {
    pdsRenderLocalDrawer(local, "Bu içerik Modrinth kaydı olmadan (elle) kurulmuş.");
  }
}

function pdsCloseDrawer() {
  const drawer = document.getElementById("pdsDrawer");
  const backdrop = document.getElementById("pdsDrawerBackdrop");
  pdsState.drawerOpen = false;
  pdsState.drawerKey = "";
  if (drawer) {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }
  if (backdrop) backdrop.classList.remove("show");
}

function pdsDrawerActions(item, cat) {
  const dir = PDS_CAT_INFO[cat].dir;
  const wrap = document.createElement("div");
  wrap.className = "pds-drawer-actions";

  const sourceUrl = safeExternalUrl(item.source_url);
  if (sourceUrl) {
    const link = document.createElement("a");
    link.className = "pds-btn pds-btn-primary";
    link.href = sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Ana sayfa";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(sourceUrl, "_blank", "noopener,noreferrer");
    });
    wrap.appendChild(link);
  }

  // Mağazadan açılan (henüz kurulmamış) içerik: sil/klasör yerine kur butonu
  if (item.store_mode) {
    const hit = item.hit || {};
    const installed = pdsIsShaderInstalled(hit);
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "pds-btn pds-btn-primary";
    installBtn.textContent = installed ? "Kuruldu " : "Kur";
    if (installed) {
      installBtn.disabled = true;
      installBtn.classList.add("is-installed");
    } else {
      installBtn.addEventListener("click", () => pdsInstallShader(hit, installBtn));
    }
    wrap.appendChild(installBtn);

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "pds-btn";
    folderBtn.textContent = "Klasörü aç";
    folderBtn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/${dir}`));
    wrap.appendChild(folderBtn);
    return wrap;
  }

  const folderBtn = document.createElement("button");
  folderBtn.type = "button";
  folderBtn.className = "pds-btn";
  folderBtn.textContent = "Klasörü aç";
  folderBtn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/${dir}`));
  wrap.appendChild(folderBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "pds-btn pds-btn-danger";
  delBtn.textContent = " Kaldır";
  delBtn.addEventListener("click", () => pdsDeleteContent(cat, item));
  wrap.appendChild(delBtn);

  return wrap;
}

function pdsRenderProjectDrawer(data, local) {
  const body = document.getElementById("pdsDrawerBody");
  if (!body) return;
  const titleEl = document.getElementById("pdsDrawerTitle");
  if (titleEl) titleEl.textContent = data.title || local.item.name;

  body.innerHTML = "";

  const head = document.createElement("div");
  head.className = "pds-drawer-head-card";

  const iconBox = document.createElement("div");
  iconBox.className = "pds-drawer-icon";
  iconBox.textContent = PDS_CAT_INFO[local.cat].icon;
  if (data.icon_url) {
    const img = document.createElement("img");
    img.src = data.icon_url;
    img.alt = "";
    img.addEventListener("error", () => { img.remove(); iconBox.textContent = PDS_CAT_INFO[local.cat].icon; });
    iconBox.textContent = "";
    iconBox.appendChild(img);
  }

  const headInfo = document.createElement("div");
  headInfo.className = "pds-drawer-headinfo";
  headInfo.innerHTML = `
    <div class="pds-drawer-name">${pdsEsc(data.title)}</div>
    <div class="pds-chips">${(data.categories || []).map(c => `<span class="pds-chip">${pdsEsc(c)}</span>`).join("")}</div>
    <div class="pds-drawer-stats"> ${Number(data.downloads || 0).toLocaleString()} indirme •  ${Number(data.follows || 0).toLocaleString()} takipçi</div>
  `;
  head.appendChild(iconBox);
  head.appendChild(headInfo);
  body.appendChild(head);

  const descTitle = document.createElement("h4");
  descTitle.className = "pds-drawer-subtitle";
  descTitle.textContent = "Açıklama";
  body.appendChild(descTitle);

  const desc = document.createElement("p");
  desc.className = "pds-drawer-desc";
  desc.textContent = data.description || "Açıklama bulunmuyor.";
  body.appendChild(desc);

  // Faz 3: Modrinth galeri resimleri (yatay şerit; yüklenemeyen gizlenir)
  const gallery = Array.isArray(data.gallery) ? data.gallery.filter(Boolean) : [];
  if (gallery.length > 0) {
    const galTitle = document.createElement("h4");
    galTitle.className = "pds-drawer-subtitle";
    galTitle.textContent = `Galeri (${gallery.length})`;
    body.appendChild(galTitle);

    const strip = document.createElement("div");
    strip.className = "pds-drawer-gallery";
    gallery.forEach(url => {
      const cell = document.createElement("div");
      cell.className = "pds-drawer-gallery-item";
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => cell.remove());
      cell.addEventListener("click", () => pdsOpenLightbox(url));
      cell.appendChild(img);
      strip.appendChild(cell);
    });
    body.appendChild(strip);
  }

  const versionsTitle = document.createElement("h4");
  versionsTitle.className = "pds-drawer-subtitle";
  versionsTitle.textContent = `Sürüm Geçmişi (${(data.versions || []).length})`;
  body.appendChild(versionsTitle);

  const vList = document.createElement("div");
  vList.className = "pds-drawer-list";
  (data.versions || []).slice(0, 15).forEach(v => {
    const row = document.createElement("div");
    row.className = "pds-drawer-ver";
    const gvs = (v.game_versions || []).slice(0, 4).join(", ");
    const loaders = (v.loaders || []).slice(0, 3).join(", ");
    row.innerHTML = `
      <span class="pds-drawer-ver-name">${pdsEsc(v.version_number || "?")}</span>
      <span class="pds-drawer-ver-meta">${pdsEsc(gvs)}${loaders ? " • " + pdsEsc(loaders) : ""}</span>
      <span class="pds-drawer-ver-date">${pdsEsc(String(v.date || "").slice(0, 10))}</span>
    `;
    vList.appendChild(row);
  });
  if (!(data.versions || []).length) {
    vList.innerHTML = `<div class="pds-drawer-empty">Sürüm bilgisi yok.</div>`;
  }
  body.appendChild(vList);

  const DEP_LABELS = { required: "Zorunlu", optional: "Opsiyonel", incompatible: "Uyumsuz", embedded: "Gömülü" };
  const deps = data.dependencies || [];
  const depTitle = document.createElement("h4");
  depTitle.className = "pds-drawer-subtitle";
  depTitle.textContent = `Bağımlılıklar (${deps.length})`;
  body.appendChild(depTitle);

  const depList = document.createElement("div");
  depList.className = "pds-drawer-list";
  deps.forEach(d => {
    const row = document.createElement("div");
    row.className = "pds-drawer-dep";
    const dtype = d.dependency_type || "required";
    row.innerHTML = `
      <span class="pds-drawer-dep-name">${pdsEsc(d.name || d.project_id || "?")}</span>
      <span class="pds-dep-type dep-${pdsEsc(dtype)}">${pdsEsc(DEP_LABELS[dtype] || dtype)}</span>
    `;
    depList.appendChild(row);
  });
  if (!deps.length) {
    depList.innerHTML = `<div class="pds-drawer-empty">Bağımlılık yok.</div>`;
  }
  body.appendChild(depList);

  body.appendChild(pdsDrawerActions(Object.assign({}, local.item, {
    display_name: data.title,
    source_url: data.source_url || ""
  }), local.cat));
}

function pdsRenderLocalDrawer(local, note) {
  const body = document.getElementById("pdsDrawerBody");
  if (!body) return;
  const item = local.item;
  const info = PDS_CAT_INFO[local.cat];
  const displayName = (item.display_name && String(item.display_name).trim()) || cleanContentName(item.name);

  const sizeText = item.is_dir
    ? "klasör"
    : (item.size >= 1048576 ? `${(item.size / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((item.size || 0) / 1024))} KB`);

  body.innerHTML = "";
  const card = document.createElement("div");
  card.className = "pds-drawer-local";
  card.innerHTML = `
    <div class="pds-drawer-local-name">${info.icon} ${pdsEsc(displayName)}</div>
    <div class="pds-item-meta" style="margin-top:6px;">${pdsEsc(item.name)} • ${pdsEsc(sizeText)}${item.version ? " • v" + pdsEsc(item.version) : ""}</div>
    <p class="pds-drawer-desc" style="margin-top:10px;">${pdsEsc(item.description || "Açıklama bulunmuyor.")}</p>
    <p class="pds-soon-note">ℹ ${pdsEsc(note)}</p>
  `;
  body.appendChild(card);
  body.appendChild(pdsDrawerActions(item, local.cat));
}

// ---------- Modrinth sekmesi ----------
function pdsRenderModrinthTab(pane) {
  const inst = pdsSyncInstance();
  const loaderText = pdsLoaderLabel(inst ? inst.loader : "");
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Modrinth</h3>
        <p class="pds-section-sub">Arama bu profile göre filtrelenir: MC ${pdsEsc(inst ? inst.version : "?")} • ${pdsEsc(loaderText)}</p>
      </div>
    </div>
    <div class="pds-mr-bar">
      <select class="styled-select" id="pdsMrType" aria-label="İçerik türü">
        <option value="mod">Modlar</option>
        <option value="shader">Shaderlar</option>
        <option value="resourcepack">Doku paketleri</option>
      </select>
      <input type="text" class="styled-input" id="pdsMrQuery" placeholder="Ara... (örn: sodium)" autocomplete="off" spellcheck="false">
      <button type="button" class="btn-primary-action" id="pdsMrSearchBtn"> Ara</button>
      <label class="pds-deps-toggle" title="Seçili modun Modrinth'teki zorunlu bağımlılıklarını da otomatik kurar">
        <input type="checkbox" id="pdsInstallDepsToggle" class="install-deps-cb">
        <span> Gerekli bağımlılıkları da kur</span>
      </label>
    </div>
    <div class="pds-mr-grid" id="pdsMrResults"></div>
  `;

  const typeSel = document.getElementById("pdsMrType");
  const input = document.getElementById("pdsMrQuery");
  const btn = document.getElementById("pdsMrSearchBtn");
  bindInstallDepsToggle(document.getElementById("pdsInstallDepsToggle"));

  if (typeSel) {
    typeSel.value = pdsState.modrinth.type;
    typeSel.addEventListener("change", () => {
      pdsState.modrinth.type = typeSel.value;
      pdsState.modrinth.hits = [];
      pdsState.modrinth.searched = false;
      pdsRenderMrResults();
    });
  }
  if (btn) btn.addEventListener("click", pdsSearchModrinth);
  if (input) {
    input.value = pdsState.modrinth.query || "";
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") pdsSearchModrinth(); });
  }

  pdsRenderMrResults();
}

async function pdsSearchModrinth() {
  const inst = pdsSyncInstance();
  if (!inst) return;

  const input = document.getElementById("pdsMrQuery");
  const typeSel = document.getElementById("pdsMrType");
  const q = input ? input.value.trim() : "";
  const type = typeSel ? typeSel.value : "mod";
  pdsState.modrinth.type = type;
  pdsState.modrinth.query = q;
  pdsState.modrinth.loading = true;
  const reqId = ++pdsState.modrinth.reqId;

  const wrap = document.getElementById("pdsMrResults");
  if (wrap) wrap.innerHTML = `<div class="pds-loading"><div class="spinner"></div><span>Modrinth taranıyor...</span></div>`;

  const params = new URLSearchParams({
    q: q,
    type: type,
    version: inst.version || "",
    loader: String(inst.loader || "").toLowerCase() === "vanilla" ? "Tümü" : (inst.loader || ""),
    sort: "downloads",
    limit: 20,
    offset: 0
  });

  const data = await apiGet(`/api/modrinth/search?${params.toString()}`, 20000);
  if (reqId !== pdsState.modrinth.reqId) return;
  pdsState.modrinth.loading = false;

  if (!data || data.error || !Array.isArray(data.hits)) {
    pdsState.modrinth.hits = [];
    pdsState.modrinth.searched = true;
    pdsRenderMrResults((data && data.error) || "Modrinth yanıt vermedi.");
    return;
  }

  pdsState.modrinth.hits = data.hits;
  pdsState.modrinth.searched = true;
  pdsRenderMrResults();
}

function pdsRenderMrResults(errorMsg) {
  const wrap = document.getElementById("pdsMrResults");
  if (!wrap) return;

  if (pdsState.modrinth.loading) {
    wrap.innerHTML = `<div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>`;
    return;
  }
  if (errorMsg) {
    wrap.innerHTML = `<div class="pds-empty"> ${pdsEsc(errorMsg)}</div>`;
    return;
  }
  if (!pdsState.modrinth.searched) {
    wrap.innerHTML = `<div class="pds-empty">Aramak için bir şeyler yazın ve türü seçin.</div>`;
    return;
  }

  const hits = pdsState.modrinth.hits || [];
  if (hits.length === 0) {
    wrap.innerHTML = `<div class="pds-empty">Aradığınız kriterlere uygun içerik bulunamadı.</div>`;
    return;
  }

  const cat = contentCategoryFromType(pdsState.modrinth.type);
  const info = PDS_CAT_INFO[cat];
  wrap.innerHTML = "";

  hits.forEach(hit => {
    const card = document.createElement("div");
    card.className = "pds-mr-card";

    const icon = document.createElement("div");
    icon.className = "pds-mr-icon";
    icon.textContent = info.icon;
    if (hit.icon_url) {
      const img = document.createElement("img");
      img.src = hit.icon_url;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => { img.remove(); icon.textContent = info.icon; });
      icon.textContent = "W";
      icon.appendChild(img);
    }

    const bodyEl = document.createElement("div");
    bodyEl.className = "pds-mr-body";
    bodyEl.innerHTML = `
      <div class="pds-mr-title" title="${pdsEsc(hit.title)}">${pdsEsc(hit.title || hit.slug)}</div>
      <div class="pds-mr-desc">${pdsEsc(hit.description || "")}</div>
      <div class="pds-mr-meta"> ${Number(hit.downloads || 0).toLocaleString()}${hit.author ? " • " + pdsEsc(hit.author) : ""}</div>
    `;

    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "pds-btn pds-btn-primary";
    installBtn.textContent = " Kur";
    installBtn.addEventListener("click", () => pdsInstallSearchHit(hit, installBtn));

    card.appendChild(icon);
    card.appendChild(bodyEl);
    card.appendChild(installBtn);
    wrap.appendChild(card);
  });
}

async function pdsInstallSearchHit(hit, buttonEl) {
  const inst = pdsSyncInstance();
  if (!inst) return;

  const cat = contentCategoryFromType(pdsState.modrinth.type);
  if (cat === "mod" && String(inst.loader || "").toLowerCase() === "vanilla") {
    showToast("Vanilla profil mod yüklemez. Fabric/Forge profili kullanın.", "info");
    return;
  }

  const original = buttonEl ? buttonEl.textContent : "";
  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kuruluyor..."; }
  showToast(` ${hit.title || hit.slug} → "${inst.name}" profiline indiriliyor...`, "info");

  const payload = {
    slug: hit.slug,
    version: inst.version,
    loader: inst.loader,
    instance_id: pdsState.instanceId,
    project_type: cat,
    force: false,
    install_dependencies: getInstallDepsPref()
  };
  const data = await apiPost("/api/modrinth/install", payload, 180000);

  if (data && data.needs_confirm) {
    if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original || " Kur"; }
    const ok = await showConfirmDialog({
      icon: "",
      title: "Sürüm Tam Eşleşmiyor",
      message: `${data.message || "Bu paket sürümünüzle tam eşleşmiyor olabilir."} Yine de indirmek ister misiniz?`,
      okText: "Yine de İndir"
    });
    if (ok) {
      if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kuruluyor..."; }
      const forced = await apiPost("/api/modrinth/install", Object.assign({}, payload, { force: true }), 180000);
      pdsHandleInstallResult(forced, buttonEl, original, cat, hit);
    }
    return;
  }
  pdsHandleInstallResult(data, buttonEl, original, cat, hit);
}

async function pdsHandleInstallResult(data, buttonEl, original, cat, hit) {
  if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original || " Kur"; }

  if (data && data.success) {
    if (data.installed_dependencies || data.failed_dependencies) {
      modInstallToast(String((hit && (hit.title || hit.slug)) || data.filename || "İçerik"), data);
    } else {
      showToast(` ${data.filename || "İçerik"} profile kuruldu.`, "success");
    }
    if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Yüklü"; }
    await pdsLoadContent(cat, true);
    if (cat === "mod") pdsLoadMissingDeps();
    loadInstances();
  } else {
    showToast(` ${(data && data.error) || "Kurulum tamamlanamadı."}`, "error");
  }
}

// ==============================================================================
// SÜRÜM DEĞİŞTİR (VERSION SWITCH) — arama kartı ve profil detayı ortak overlay
// ==============================================================================
const vswState = {
  open: false,
  slug: "",
  cat: "mod",
  title: "",
  iconUrl: "",
  instance: null,
  installedVersion: "",
  versions: [],
  loading: false,
  error: "",
  query: "",
  truncated: false,
  reqId: 0
};

const VSW_SHOW_INCOMPAT_KEY = "cl_vsw_show_incompatible";

function vswShowIncompatiblePref() {
  try { return localStorage.getItem(VSW_SHOW_INCOMPAT_KEY) === "true"; } catch (e) { return false; }
}

function vswSetShowIncompatible(value, opts = {}) {
  const on = !!value;
  try { localStorage.setItem(VSW_SHOW_INCOMPAT_KEY, on ? "true" : "false"); } catch (e) { /* yoksay */ }
  const toggle = document.getElementById("vswShowIncompat");
  if (toggle) toggle.checked = on;
  if (vswState.open) vswRenderList({ preserveScroll: opts.preserveScroll !== false });
}

function vswNormalizeVersion(value) {
  let s = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
  s = s.replace(/^v[.\s]*/, "");
  return s.replace(/\s+/g, "");
}

function vswIsCompatible(v, cat, inst) {
  if (!inst) return false;
  const gvs = (v.game_versions || []).map(x => String(x));
  if (!gvs.includes(String(inst.version || ""))) return false;
  if (cat === "mod") {
    const loaders = (v.loaders || []).map(x => String(x).toLowerCase());
    if (!loaders.includes(String(inst.loader || "").toLowerCase())) return false;
  }
  return true;
}

function vswReason(v, cat, inst) {
  if (!inst) return "Bu sürüm profilinizle uyumlu değil.";
  const mc = inst.version || "?";
  const loader = pdsLoaderLabel(inst.loader);
  return `Bu sürüm profilin ${mc} ${loader} yapılandırmasıyla uyumlu değil.`;
}

function vswResolveInstalledVersion() {
  if (vswState.installedVersion) return vswState.installedVersion;
  const slug = String(vswState.slug || "").toLowerCase();
  const target = vswState.instance;
  const meta = (state.installedContentMeta[vswState.cat] || {})[slug];
  if (meta && meta.version) return meta.version;
  // Profil detayı ekranı aynı profili gösteriyorsa oradaki sürüm bilgisini kullan.
  if (target && pdsState.instanceId && pdsState.instanceId === target.id && pdsState.content[vswState.cat]) {
    const row = (pdsState.content[vswState.cat] || []).find(f => String(f.slug || "").toLowerCase() === slug);
    if (row && row.version) return row.version;
  }
  return "";
}

function vswInstalledItemLoader(item) {
  const raw = item && item.loader;
  if (Array.isArray(raw)) {
    const first = raw.map(x => String(x || "").toLowerCase()).find(Boolean);
    if (first) return first;
  } else if (raw) {
    return String(raw).toLowerCase();
  }
  return String((vswState.instance && vswState.instance.loader) || "").toLowerCase();
}

function vswInstalledContentItems() {
  const cat = vswState.cat;
  const slug = String(vswState.slug || "").toLowerCase();
  const target = vswState.instance;
  if (!slug || !target || !target.id) return [];

  const items = [];
  const seen = new Set();
  const addItem = (f) => {
    if (!f) return;
    const filename = String(f.name || f.filename || "").replace(/\.disabled$/i, "").toLowerCase();
    const key = filename || `v:${vswNormalizeVersion(f.version)}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(f);
  };
  const collect = (list) => {
    (Array.isArray(list) ? list : []).forEach(f => {
      if (String((f && f.slug) || "").toLowerCase() === slug) addItem(f);
    });
  };

  // Yalnızca ekrandaki profille eşleşen kurulu içerik listelerini kullan (uydurma yok).
  if (pdsState.instanceId === target.id) collect(pdsState.content[cat]);
  if (state.installedContentInstanceId === target.id) collect(state.installedContent[cat]);
  return items;
}

function vswVersionIsInstalled(version, installedItems) {
  if (!version || !Array.isArray(installedItems) || installedItems.length === 0) return false;
  const rowFilename = String(version.primary_filename || "").toLowerCase();
  const rowVersion = vswNormalizeVersion(version.version_number);
  const rowLoaders = new Set((version.loaders || []).map(l => String(l).toLowerCase()));
  const loaderRequired = vswState.cat === "mod";

  return installedItems.some(item => {
    const itemFilename = String(item.name || item.filename || "").replace(/\.disabled$/i, "").toLowerCase();
    // 1) Dosya adı eşleşmesi kesin kurulu sayılır.
    if (rowFilename && itemFilename && rowFilename === itemFilename) return true;
    // 2) Aksi hâlde sürüm numarası eşleşmeli.
    if (!rowVersion || vswNormalizeVersion(item.version) !== rowVersion) return false;
    // Shader / doku paketinde yükleyici aranmaz.
    if (!loaderRequired) return true;
    // 3) Loader kesişimi şart; kurulu öğenin loader'ı yoksa profilin loader'ı kullanılır.
    const itemLoader = vswInstalledItemLoader(item);
    if (!itemLoader) return false;
    return rowLoaders.has(itemLoader);
  });
}

async function openVersionSwitchOverlay(opts = {}, catArg) {
  // Geriye dönük kısayol: openVersionSwitchOverlay("sodium", "mod")
  if (typeof opts === "string") opts = { slug: opts, cat: catArg || "mod" };
  const slug = String(opts.slug || "").trim();
  if (!slug) {
    showToast("Bu içeriğin Modrinth kaydı bulunamadı.", "info");
    return;
  }

  const modal = document.getElementById("versionSwitchModal");
  if (!modal) return;

  vswState.open = true;
  vswState.reqId += 1;
  const reqId = vswState.reqId;
  vswState.slug = slug;
  vswState.cat = opts.cat || "mod";
  vswState.title = opts.title || slug;
  vswState.iconUrl = opts.iconUrl || "";
  vswState.instance = opts.instance || getModrinthTarget();
  vswState.installedVersion = opts.installedVersion || "";
  vswState.versions = [];
  vswState.error = "";
  vswState.query = "";
  vswState.truncated = false;

  const titleEl = document.getElementById("vswTitle");
  const subEl = document.getElementById("vswSub");
  const iconEl = document.getElementById("vswIcon");
  const searchEl = document.getElementById("vswSearchInput");

  if (titleEl) titleEl.textContent = `${vswState.title} — sürüm değiştir`;
  if (iconEl) {
    iconEl.innerHTML = "";
    iconEl.textContent = PDS_CAT_INFO[vswState.cat] ? PDS_CAT_INFO[vswState.cat].icon : "";
    if (vswState.iconUrl) {
      const img = document.createElement("img");
      img.src = vswState.iconUrl;
      img.alt = "";
      img.addEventListener("error", () => {
        img.remove();
        iconEl.textContent = PDS_CAT_INFO[vswState.cat] ? PDS_CAT_INFO[vswState.cat].icon : "";
      });
      iconEl.textContent = "";
      iconEl.appendChild(img);
    }
  }
  if (subEl) {
    const inst = vswState.instance;
    subEl.textContent = inst
      ? `Hedef: ${inst.name || inst.id} • MC ${inst.version || "?"} • ${pdsLoaderLabel(inst.loader)}`
      : "Profil seçilmedi";
  }
  if (searchEl) searchEl.value = "";
  const toggleEl = document.getElementById("vswShowIncompat");
  if (toggleEl) toggleEl.checked = vswShowIncompatiblePref();

  modal.style.display = "flex";
  vswRenderList();

  if (!vswState.instance) {
    vswState.loading = false;
    vswState.error = "Sürüm değiştirmek için önce bir profil seçin.";
    vswRenderList();
    return;
  }

  vswState.loading = true;
  vswRenderList();

  const params = new URLSearchParams({ slug: slug, instance: vswState.instance.id || "" });
  const data = await apiGet(`/api/modrinth/project?${params.toString()}`, 15000);
  if (!vswState.open || vswState.reqId !== reqId || vswState.slug !== slug) return;

  vswState.loading = false;
  if (data && data.success && Array.isArray(data.versions)) {
    vswState.versions = data.versions;
    vswState.truncated = data.versions_truncated === true;
    if (data.icon_url) vswState.iconUrl = data.icon_url;
    vswState.error = "";
  } else {
    vswState.versions = [];
    vswState.error = (data && data.error) || "Modrinth sürüm listesi alınamadı.";
  }
  vswRenderList();
}

function closeVersionSwitchOverlay() {
  const modal = document.getElementById("versionSwitchModal");
  if (modal) modal.style.display = "none";
  vswState.open = false;
}

function vswRenderIncompatEmptyState(emptyEl) {
  if (!emptyEl) return;
  const inst = vswState.instance || {};
  const mc = inst.version || "?";
  const loader = pdsLoaderLabel(inst.loader);
  emptyEl.style.display = "flex";
  emptyEl.innerHTML = `
    <div class="empty-state empty-state-compact">
      <div class="empty-state-icon" aria-hidden="true">—</div>
      <h3 class="empty-state-title">Bu profil için uygun sürüm yok</h3>
      <p class="empty-state-desc">${pdsEsc(mc)} • ${pdsEsc(loader)} yapılandırmasıyla uyumlu sürüm bulunamadı.</p>
      <button class="btn btn-primary" type="button" id="vswEmptyShowIncompat">Uyumsuzları göster</button>
    </div>
  `;
  const btn = document.getElementById("vswEmptyShowIncompat");
  if (btn) btn.addEventListener("click", () => vswSetShowIncompatible(true));
}

function vswRenderList(opts = {}) {
  const list = document.getElementById("vswList");
  const empty = document.getElementById("vswEmpty");
  const toggle = document.getElementById("vswShowIncompat");
  if (!list) return;

  if (vswState.loading) {
    if (empty) empty.style.display = "none";
    list.innerHTML = `<div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>
      <div class="skeleton skeleton-row"></div>`;
    return;
  }
  if (vswState.error) {
    if (empty) empty.style.display = "none";
    list.innerHTML = `<div class="pds-empty"> ${pdsEsc(vswState.error)}</div>`;
    return;
  }

  // Varsayılan: yalnızca profile uyumlu sürümler. Tercih localStorage'da saklanır.
  const showIncompat = vswShowIncompatiblePref();
  if (toggle) toggle.checked = showIncompat;
  if (empty) empty.innerHTML = "";
  const prevScroll = opts.preserveScroll ? list.scrollTop : null;

  const q = vswNormalizeVersion(vswState.query);
  const versions = vswState.versions.filter(v =>
    !q || vswNormalizeVersion(v.version_number).includes(q) || vswNormalizeVersion(v.version_id).includes(q)
  );
  const compatOf = (v) => typeof v.compatible === "boolean"
    ? v.compatible
    : vswIsCompatible(v, vswState.cat, vswState.instance);

  const compatible = versions.filter(v => compatOf(v));
  const incompatible = versions.filter(v => !compatOf(v));
  const visible = showIncompat ? versions : compatible;
  const totalCompatible = vswState.versions.filter(v => compatOf(v)).length;

  const filterRow = document.getElementById("vswFilterRow");
  if (filterRow) filterRow.style.display = vswState.versions.length > 0 ? "flex" : "none";
  const toggleLabel = document.getElementById("vswShowIncompatLabel");
  if (toggleLabel) toggleLabel.textContent = `Uyumsuzları da göster (${incompatible.length})`;
  const countEl = document.getElementById("vswCount");
  if (countEl) {
    let txt = `${compatible.length} uyumlu sürüm`;
    if (incompatible.length > 0) {
      txt += showIncompat
        ? ` • ${incompatible.length} uyumsuz gösteriliyor`
        : ` • ${incompatible.length} uyumsuz gizli`;
    }
    countEl.textContent = txt;
  }

  list.innerHTML = "";
  if (visible.length === 0) {
    if (empty) {
      if (vswState.versions.length === 0) {
        empty.style.display = "flex";
        empty.textContent = "Bu içerik için sürüm bulunamadı.";
      } else if (!showIncompat && totalCompatible === 0) {
        vswRenderIncompatEmptyState(empty);
      } else {
        empty.style.display = "flex";
        empty.textContent = "Aramanızla eşleşen sürüm yok.";
      }
    }
    return;
  }
  if (empty) empty.style.display = "none";

  const installedItems = vswInstalledContentItems();

  visible.forEach(v => {
    const compatible = compatOf(v);
    // Öncelik: uyumsuz > Kurulu. Uyumsuz satır asla "Kurulu" göstermez.
    const isInstalled = compatible && vswVersionIsInstalled(v, installedItems);

    const row = document.createElement("div");
    row.className = "vsw-row" +
      (isInstalled ? " is-installed" : "") +
      (!compatible ? " is-incompat" : "");

    const type = String(v.version_type || "release").toLowerCase();
    const typeLabel = type === "beta" ? "Beta" : (type === "alpha" ? "Alpha" : "Release");
    const gvs = (v.game_versions || []).slice(0, 4).join(", ");
    const loaders = (v.loaders || []).slice(0, 4).join(", ");
    const metaParts = [];
    if (gvs) metaParts.push(`MC: ${gvs}`);
    if (loaders) metaParts.push(loaders);
    if (v.date) metaParts.push(String(v.date).slice(0, 10));
    if (v.primary_filename) metaParts.push(v.primary_filename);

    const main = document.createElement("div");
    main.className = "vsw-row-main";
    main.innerHTML = `
      <div class="vsw-row-top">
        <span class="vsw-ver">${pdsEsc(v.version_number || v.version_id || "?")}</span>
        <span class="vsw-type vsw-type-${pdsEsc(type)}">${pdsEsc(typeLabel)}</span>
        ${isInstalled ? '<span class="vsw-installed-tag">Kurulu</span>' : ""}
      </div>
      <div class="vsw-row-meta" title="${pdsEsc(metaParts.join(" • "))}">${pdsEsc(metaParts.join(" • "))}</div>
    `;

    const action = document.createElement("div");
    action.className = "vsw-row-action";

    if (isInstalled) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vsw-btn is-installed";
      btn.disabled = true;
      btn.textContent = "Kurulu";
      action.appendChild(btn);
    } else if (compatible) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vsw-btn vsw-btn-install";
      btn.textContent = "Bu sürümü kur";
      btn.addEventListener("click", () => vswInstallVersion(v, btn));
      action.appendChild(btn);
    } else {
      const tag = document.createElement("span");
      tag.className = "vsw-incompat-tag";
      tag.textContent = "uyumsuz";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "vsw-btn";
      btn.disabled = true;
      btn.textContent = "Kur";
      const reason = vswReason(v, vswState.cat, vswState.instance);
      btn.title = reason || "Bu sürüm profilinizle uyumlu değil.";
      tag.title = btn.title;
      action.appendChild(tag);
      action.appendChild(btn);
    }

    row.appendChild(main);
    row.appendChild(action);
    list.appendChild(row);
  });

  // Kesilme bilgisi yalnizca TUM liste goruntulenirken anlamli. Uyumsuzlar
  // gizliyken (varsayilan) tek uyumlu surumun altinda "200 surum gosteriliyor"
  // demek kafa karistiriyordu (kullanici geri bildirimi).
  if (vswState.truncated && vswShowIncompatiblePref()) {
    const note = document.createElement("div");
    note.className = "vsw-truncated-note";
    note.textContent = `ℹ Çok fazla sürüm var; en yeni 200 sürüm gösteriliyor.`;
    list.appendChild(note);
  }

  if (prevScroll !== null) list.scrollTop = prevScroll;
}

async function vswInstallVersion(version, buttonEl, force = false) {
  const inst = vswState.instance;
  if (!inst || !version) return;

  const original = buttonEl ? buttonEl.textContent : "";
  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kuruluyor..."; }

  const data = await apiPost("/api/modrinth/install", {
    slug: vswState.slug,
    version: inst.version,
    loader: inst.loader,
    project_type: vswState.cat,
    instance_id: inst.id,
    version_id: version.version_id || "",
    version_number: version.version_number || "",
    force: force,
    install_dependencies: getInstallDepsPref()
  }, 180000);

  if (data && data.needs_confirm && !force) {
    if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original || "Bu sürümü kur"; }
    const ok = await showConfirmDialog({
      icon: "!",
      title: "Sürüm tam eşleşmiyor",
      message: `${data.message || "Bu sürüm profilinizle tam eşleşmiyor olabilir."} Yine de kurulsun mu?`,
      okText: "Yine de kur"
    });
    if (ok) await vswInstallVersion(version, buttonEl, true);
    return;
  }

  if (data && data.success) {
    const installed = data.installed || {};
    const oldName = String(data.replaced || "").replace(/\.disabled$/i, "");
    const newName = String(installed.filename || data.filename || version.primary_filename || "").replace(/\.disabled$/i, "");
    const transition = oldName && newName && oldName !== newName
      ? `${oldName} → ${newName}`
      : (newName || oldName);
    showToast(` ${vswState.title || vswState.slug} ${transition}`, "success");

    closeVersionSwitchOverlay();
    await refreshInstalledContent();
    applyInstalledStates();
    if (pdsState.instanceId) {
      await pdsLoadContent(vswState.cat, true);
      if (vswState.cat === "mod") pdsLoadMissingDeps();
    }
    loadInstances();
  } else {
    if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original || "Bu sürümü kur"; }
    showToast(` ${(data && data.error) || "Sürüm değiştirilemedi."}`, "error");
  }
}

function initVersionSwitchModal() {
  const modal = document.getElementById("versionSwitchModal");
  if (!modal || modal.dataset.bound === "1") return;
  modal.dataset.bound = "1";

  const close = () => closeVersionSwitchOverlay();
  const btnClose = document.getElementById("btnCloseVersionSwitch");
  const btnCancel = document.getElementById("btnCancelVersionSwitch");
  const search = document.getElementById("vswSearchInput");
  const toggle = document.getElementById("vswShowIncompat");

  if (btnClose) btnClose.addEventListener("click", close);
  if (btnCancel) btnCancel.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });

  if (toggle) {
    toggle.checked = vswShowIncompatiblePref();
    toggle.addEventListener("change", () => vswSetShowIncompatible(toggle.checked));
  }

  if (search) {
    search.addEventListener("input", () => {
      vswState.query = search.value || "";
      vswRenderList();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && vswState.open) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  });
}

// ---------- Sürüm sekmesi ----------
function pdsRenderVersionTab(pane) {
  const inst = pdsSyncInstance();
  if (!inst) return;

  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Sürüm Bilgisi</h3>
        <p class="pds-section-sub">Sürüm/yükleyici değiştirme Faz 2'de; şimdilik bilgileri görüntüleyin ve profili düzenleyin.</p>
      </div>
    </div>
    <div class="pds-info-grid">
      <div class="pds-info-card"><span class="pds-info-label">Minecraft Sürümü</span><span class="pds-info-value">${pdsEsc(inst.version || "?")}</span></div>
      <div class="pds-info-card"><span class="pds-info-label">Yükleyici</span><span class="pds-info-value">${pdsEsc(pdsLoaderLabel(inst.loader))}</span></div>
      <div class="pds-info-card"><span class="pds-info-label">Yükleyici Sürümü</span><span class="pds-info-value">${pdsEsc(inst.loader_version || "Otomatik / Bilinmiyor")}</span></div>
      <div class="pds-info-card"><span class="pds-info-label">Oluşturma Tarihi</span><span class="pds-info-value">${pdsEsc(inst.created_at || "—")}</span></div>
      <div class="pds-info-card"><span class="pds-info-label">Mod Sayısı</span><span class="pds-info-value">${inst.mod_count || 0}</span></div>
    </div>

    <h3 class="pds-section-title pds-sub-head"> Profili Düzenle</h3>
    <div class="pds-form">
      <div class="pds-field">
        <label>Profil Adı</label>
        <input type="text" class="styled-input" id="pdsVersionName" value="${pdsEsc(inst.name || "")}" autocomplete="off">
      </div>
      <div class="pds-field">
        <label>Profil İkonu (URL)</label>
        <input type="text" class="styled-input" id="pdsVersionIcon" placeholder="https://.../ikon.png" value="${pdsEsc(inst.icon || "")}" autocomplete="off" spellcheck="false">
      </div>
      <button type="button" class="btn-primary-action" id="pdsVersionSave"> Kaydet</button>
    </div>
  `;

  const save = document.getElementById("pdsVersionSave");
  if (save) save.addEventListener("click", () => pdsSaveProfileForm("pdsVersionName", "pdsVersionIcon", save));
}

// ---------- Ayarlar sekmesi ----------
function pdsRenderSettingsTab(pane) {
  const inst = pdsSyncInstance();
  if (!inst) return;

  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Ayarlar</h3>
        <p class="pds-section-sub">Profil kimliğini düzenleyin, klasörü açın veya profili silin.</p>
      </div>
    </div>
    <div class="pds-form">
      <div class="pds-field">
        <label>Profil Adı</label>
        <input type="text" class="styled-input" id="pdsSettingsName" value="${pdsEsc(inst.name || "")}" autocomplete="off">
      </div>
      <div class="pds-field">
        <label>Profil İkonu (URL)</label>
        <input type="text" class="styled-input" id="pdsSettingsIcon" placeholder="https://.../ikon.png" value="${pdsEsc(inst.icon || "")}" autocomplete="off" spellcheck="false">
      </div>
      <button type="button" class="btn-primary-action" id="pdsSettingsSave"> Kaydet</button>
    </div>

    <div class="pds-danger-zone">
      <div class="pds-danger-text">
        <strong>Profil klasörü</strong>
        <span>Modlar, dünyalar ve ayarlar bu klasörde saklanır.</span>
      </div>
      <button type="button" class="btn-secondary" id="pdsOpenFolderBtn"> Klasörü Aç</button>
    </div>

    <div class="pds-danger-zone pds-danger-red">
      <div class="pds-danger-text">
        <strong>Profili Sil</strong>
        <span>Profil ve tüm içeriği kalıcı olarak silinir. Bu işlem geri alınamaz.</span>
      </div>
      <button type="button" class="pds-btn pds-btn-danger pds-btn-lg" id="pdsDeleteProfileBtn"> Profili Sil</button>
    </div>
  `;

  const save = document.getElementById("pdsSettingsSave");
  if (save) save.addEventListener("click", () => pdsSaveProfileForm("pdsSettingsName", "pdsSettingsIcon", save));

  const folderBtn = document.getElementById("pdsOpenFolderBtn");
  if (folderBtn) folderBtn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}`));

  const deleteBtn = document.getElementById("pdsDeleteProfileBtn");
  if (deleteBtn) deleteBtn.addEventListener("click", pdsDeleteCurrentProfile);
}

async function pdsSaveProfileForm(nameId, iconId, buttonEl) {
  const inst = pdsSyncInstance();
  if (!inst) return;

  const nameEl = document.getElementById(nameId);
  const iconEl = document.getElementById(iconId);
  const name = nameEl ? nameEl.value.trim() : "";
  if (!name) {
    showToast("Profil adı boş olamaz.", "error");
    return;
  }

  const original = buttonEl ? buttonEl.textContent : "";
  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kaydediliyor..."; }

  const data = await apiPost("/api/instances/update", {
    id: pdsState.instanceId,
    name: name,
    icon: iconEl ? iconEl.value.trim() : ""
  }, 12000);

  if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original || " Kaydet"; }

  if (data && data.success) {
    showToast(" Profil güncellendi.", "success");
    await loadInstances();
    pdsSyncInstance();
    pdsRenderHeader();
  } else {
    showToast(` ${(data && data.error) || "Profil güncellenemedi."}`, "error");
  }
}

async function pdsDeleteCurrentProfile() {
  const inst = pdsSyncInstance();
  if (!inst) return;

  const ok = await showConfirmDialog({
    icon: "",
    title: "Profil Silinsin mi?",
    message: `"${inst.name}" profili ve içindeki tüm mod, dünya ve ayarlar kalıcı olarak silinecek. Emin misiniz?`,
    okText: "Profili Sil",
    danger: true
  });
  if (!ok) return;

  const data = await apiPost("/api/instances/delete", { id: pdsState.instanceId }, 30000);
  if (data && data.success) {
    showToast(` "${inst.name}" profili silindi.`, "success");
    closeProfileDetail();
    await loadInstances();
  } else {
    showToast(` ${(data && data.error) || "Profil silinemedi."}`, "error");
  }
}

// ---------- Minecraft Günlüğü sekmesi ----------
function pdsRenderLogsTab(pane) {
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Minecraft Günlüğü</h3>
        <p class="pds-section-sub">Launcher ve oyunun son günlük kayıtları.</p>
      </div>
      <div class="pds-head-actions">
        <button type="button" class="btn-secondary" id="pdsLogsRefresh">↻ Yenile</button>
        <button type="button" class="btn-secondary" id="pdsLogsClear">Temizle</button>
      </div>
    </div>
    <pre class="pds-log" id="pdsLogOut">Günlük yükleniyor...</pre>
  `;

  const out = document.getElementById("pdsLogOut");
  const load = async () => {
    if (!out) return;
    const data = await apiGet("/api/logs", 8000);
    const logs = (data && Array.isArray(data.logs)) ? data.logs : [];
    out.textContent = logs.length ? logs.join("\n") : "Günlük kaydı yok.";
    out.scrollTop = out.scrollHeight;
  };

  const refresh = document.getElementById("pdsLogsRefresh");
  if (refresh) refresh.addEventListener("click", load);

  const clear = document.getElementById("pdsLogsClear");
  if (clear) clear.addEventListener("click", () => { if (out) out.textContent = "Günlük görünümü temizlendi.\n"; });

  load();
}

// ---------- Faz 2/3 sekmeleri ("Yakında") ----------
function pdsRenderSoonTab(pane, tabId) {
  const info = PDS_SOON_TABS[tabId] || { label: "Yakında", icon: "", folder: "", desc: "" };
  pane.innerHTML = `
    <div class="pds-soon">
      <div class="pds-soon-icon">${info.icon}</div>
      <h3 class="pds-soon-title">${pdsEsc(info.label)} — Yakında</h3>
      <p class="pds-soon-desc">${pdsEsc(info.desc)}</p>
      <button type="button" class="btn-secondary" id="pdsSoonFolder"> Klasörü Aç</button>
    </div>
  `;
  const btn = document.getElementById("pdsSoonFolder");
  if (btn) {
    btn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/${info.folder}`));
  }
}

/* ==============================================================================
   FAZ 3: SHADER MAĞAZASI (profil detayı içinde overlay panel)
   ============================================================================== */

function pdsOpenShaderStore() {
  const storeEl = document.getElementById("pdsStore");
  const backdrop = document.getElementById("pdsStoreBackdrop");
  const input = document.getElementById("pdsStoreQuery");
  const sortSel = document.getElementById("pdsStoreSort");
  if (!storeEl) return;

  const inst = pdsSyncInstance();
  const sub = document.getElementById("pdsStoreSub");
  if (sub) {
    sub.textContent = `Modrinth araması profile göre filtrelenir: MC ${inst ? inst.version : "?"} • shader`;
  }
  if (input) input.value = pdsState.store.query || "";
  if (sortSel) sortSel.value = pdsState.store.sort || "downloads";

  pdsState.store.open = true;
  storeEl.classList.add("open");
  storeEl.setAttribute("aria-hidden", "false");
  if (backdrop) backdrop.classList.add("show");

  pdsRefreshInstalledShaderSlugs().then(() => pdsLoadShaderStore());
}

function pdsCloseShaderStore() {
  const storeEl = document.getElementById("pdsStore");
  const backdrop = document.getElementById("pdsStoreBackdrop");
  pdsState.store.open = false;
  if (storeEl) {
    storeEl.classList.remove("open");
    storeEl.setAttribute("aria-hidden", "true");
  }
  if (backdrop) backdrop.classList.remove("show");
}

function pdsSearchShaderStore() {
  const input = document.getElementById("pdsStoreQuery");
  pdsState.store.query = input ? input.value.trim() : "";
  pdsLoadShaderStore();
}

async function pdsRefreshInstalledShaderSlugs() {
  const installed = new Set();
  const addFile = (f) => {
    ["slug", "name", "display_name"].forEach(k => {
      const v = String((f && f[k]) || "").trim().toLowerCase();
      if (v) installed.add(v);
    });
    const base = String((f && f.name) || "").trim().toLowerCase().replace(/\.disabled$/, "");
    if (base) installed.add(base);
  };

  if (Array.isArray(pdsState.content.shader)) {
    pdsState.content.shader.forEach(addFile);
  } else {
    const data = await apiGet(
      `/api/instances/content?instance_id=${encodeURIComponent(pdsState.instanceId)}`,
      10000
    );
    const files = (data && data.success && data.categories && data.categories.shader &&
      data.categories.shader.files) || [];
    if (Array.isArray(files)) files.forEach(addFile);
  }
  pdsState.store.installed = installed;
}

function pdsIsShaderInstalled(hit) {
  const set = pdsState.store.installed instanceof Set ? pdsState.store.installed : new Set();
  const slug = String((hit && hit.slug) || "").trim().toLowerCase();
  const title = String((hit && hit.title) || "").trim().toLowerCase();
  return (slug && set.has(slug)) || (title && set.has(title));
}

async function pdsLoadShaderStore() {
  const inst = pdsSyncInstance();
  if (!inst) return;

  pdsState.store.loading = true;
  pdsState.store.searched = true;
  pdsState.store.error = "";
  const reqId = ++pdsState.store.reqId;
  pdsRenderShaderStore();

  const params = new URLSearchParams({
    q: pdsState.store.query || "",
    type: "shader",
    version: inst.version || "",
    sort: pdsState.store.sort || "downloads",
    limit: 20,
    offset: 0
  });

  const data = await apiGet(`/api/modrinth/search?${params.toString()}`, 20000);
  if (reqId !== pdsState.store.reqId) return;
  pdsState.store.loading = false;

  if (!data || data.error || !Array.isArray(data.hits)) {
    pdsState.store.hits = [];
    pdsState.store.error = (data && data.error) || "Modrinth yanıt vermedi.";
    pdsRenderShaderStore();
    return;
  }
  pdsState.store.hits = data.hits;
  pdsRenderShaderStore();
}

function pdsRenderShaderStore() {
  const wrap = document.getElementById("pdsStoreResults");
  if (!wrap) return;
  const st = pdsState.store;

  if (st.loading) {
    wrap.innerHTML = `<div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>`;
    return;
  }
  if (st.error) {
    wrap.innerHTML = `<div class="pds-empty"> ${pdsEsc(st.error)}</div>`;
    return;
  }
  if (!st.searched) {
    wrap.innerHTML = `<div class="pds-empty">Aramak için bir şeyler yazın veya aşağıdaki listeyi yükleyin.</div>`;
    return;
  }
  if (!st.hits || st.hits.length === 0) {
    wrap.innerHTML = `<div class="pds-empty">Aradığınız kriterlere uygun shader bulunamadı.</div>`;
    return;
  }

  wrap.innerHTML = "";
  st.hits.forEach((hit, idx) => {
    const installed = pdsIsShaderInstalled(hit);
    const card = document.createElement("div");
    card.className = "pds-store-card" + (installed ? " is-installed" : "");
    card.style.animationDelay = `${Math.min(idx * 0.03, 0.4)}s`;

    // Hero: Modrinth galerisi veya ikon
    const hero = document.createElement("div");
    hero.className = "pds-store-hero";
    const gallery = Array.isArray(hit.gallery) ? hit.gallery.filter(Boolean) : [];
    const heroUrl = gallery[0] || hit.icon_url || "";
    if (heroUrl) {
      const img = document.createElement("img");
      img.src = heroUrl;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        if (hit.icon_url && img.src !== hit.icon_url) {
          img.src = hit.icon_url;
        } else {
          img.remove();
          hero.textContent = "S";
        }
      });
      hero.appendChild(img);
    } else {
      hero.textContent = "S";
    }

    const hint = document.createElement("span");
    hint.className = "pds-store-hint";
    hint.textContent = "ℹ";
    hint.title = "Oyun içinde Iris/OptiFine menüsünden seçilir";
    hint.addEventListener("click", (e) => {
      e.stopPropagation();
      showToast("ℹ Shader'ı oyun içinde Iris/OptiFine menüsünden seçin.", "info");
    });
    hero.appendChild(hint);
    if (installed) {
      const badge = document.createElement("span");
      badge.className = "pds-store-badge";
      badge.textContent = "Kuruldu ";
      hero.appendChild(badge);
    }

    const cats = (hit.display_categories && hit.display_categories.length
      ? hit.display_categories
      : hit.categories) || [];

    const bodyEl = document.createElement("div");
    bodyEl.className = "pds-store-body";
    bodyEl.innerHTML = `
      <div class="pds-store-name" title="${pdsEsc(hit.title)}">${pdsEsc(hit.title || hit.slug)}</div>
      <div class="pds-store-desc">${pdsEsc(hit.description || "Açıklama bulunmuyor.")}</div>
      <div class="pds-store-meta">
        <span> ${Number(hit.downloads || 0).toLocaleString()}</span>
        ${hit.author ? `<span> ${pdsEsc(hit.author)}</span>` : ""}
      </div>
      <div class="pds-store-chips">${cats.slice(0, 3).map(c => `<span class="pds-chip">${pdsEsc(c)}</span>`).join("")}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "pds-store-actions";
    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "pds-btn pds-btn-primary pds-store-install";
    installBtn.textContent = installed ? "Kuruldu " : "Kur";
    if (installed) {
      installBtn.disabled = true;
      installBtn.classList.add("is-installed");
    } else {
      installBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        pdsInstallShader(hit, installBtn);
      });
    }
    actions.appendChild(installBtn);

    card.appendChild(hero);
    card.appendChild(bodyEl);
    card.appendChild(actions);
    card.addEventListener("click", () => pdsOpenStoreDrawer(hit));
    wrap.appendChild(card);
  });
}

function pdsOpenStoreDrawer(hit) {
  pdsOpenDrawer({
    slug: hit.slug,
    name: hit.slug,
    display_name: hit.title || hit.slug,
    description: hit.description || "",
    store_mode: true,
    hit: hit
  }, "shader");
}

async function pdsInstallShader(hit, buttonEl) {
  const inst = pdsSyncInstance();
  if (!inst) return;

  const original = buttonEl ? buttonEl.textContent : "";
  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kuruluyor..."; }
  showToast(` ${hit.title || hit.slug} → "${inst.name}" profiline indiriliyor...`, "info");

  const payload = {
    slug: hit.slug,
    version: inst.version,
    loader: inst.loader,
    instance_id: pdsState.instanceId,
    project_type: "shader",
    install_dependencies: false
  };
  const data = await apiPost("/api/modrinth/install", payload, 180000);

  if (data && data.needs_confirm) {
    if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original || "Kur"; }
    const ok = await showConfirmDialog({
      icon: "",
      title: "Sürüm Tam Eşleşmiyor",
      message: `${data.message || "Bu shader sürümünüzle tam eşleşmiyor olabilir."} Yine de indirmek ister misiniz?`,
      okText: "Yine de İndir"
    });
    if (ok) {
      if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kuruluyor..."; }
      const forced = await apiPost("/api/modrinth/install", Object.assign({}, payload, { force: true }), 180000);
      pdsHandleShaderInstallResult(forced, hit, buttonEl, original);
    }
    return;
  }
  pdsHandleShaderInstallResult(data, hit, buttonEl, original);
}

async function pdsHandleShaderInstallResult(data, hit, buttonEl, original) {
  if (data && data.success) {
    showToast(` ${data.filename || hit.slug} shaderpacks klasörüne kuruldu.`, "success");
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = "Kuruldu ";
      buttonEl.classList.add("is-installed");
    }
    pdsState.store.installed.add(String(hit.slug || "").trim().toLowerCase());
    await pdsLoadContent("shader", true);
    await pdsRefreshInstalledShaderSlugs();
    pdsRenderShaderStore();
    loadInstances();
  } else {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = original || "Kur";
    }
    showToast(` ${(data && data.error) || "Shader kurulamadı."}`, "error");
  }
}

/* ==============================================================================
   FAZ 4: PROFİL VARLIKLARI (Notlar / Dünyalar / Sunucular / Görüntüler / Kayıtlar)
   ============================================================================== */

async function pdsCopyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      showToast(` Kopyalandı: ${text}`, "success");
      return;
    }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    showToast(` Kopyalandı: ${text}`, "success");
  } catch (_) {
    showToast("Kopyalanamadı.", "error");
  }
}

// ---------- Notlar ----------
async function pdsRenderNotesTab(pane) {
  const inst = pdsSyncInstance();
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Notlar</h3>
        <p class="pds-section-sub">"${pdsEsc(inst ? inst.name : "Profil")}" için not defteri (note.txt). Yazarken otomatik kaydedilir.</p>
      </div>
      <div class="pds-head-actions">
        <span class="pds-note-status" id="pdsNoteStatus"></span>
        <button type="button" class="btn-secondary" id="pdsNoteFolder"> Klasörü Aç</button>
      </div>
    </div>
    <div class="pds-note-wrap">
      <textarea class="pds-note-area" id="pdsNoteArea" placeholder="Bu profile dair notlarınız..." spellcheck="false"></textarea>
      <div class="pds-note-foot">
        <span class="pds-note-count" id="pdsNoteCount">0 karakter</span>
        <button type="button" class="btn-primary-action" id="pdsNoteSave"> Kaydet</button>
      </div>
    </div>
  `;

  const area = document.getElementById("pdsNoteArea");
  const count = document.getElementById("pdsNoteCount");
  const status = document.getElementById("pdsNoteStatus");
  const updateCount = () => {
    if (count && area) count.textContent = `${(area.value || "").length.toLocaleString()} karakter`;
  };

  if (!pdsState.note.loaded) {
    if (area) area.disabled = true;
    const data = await apiGet(`/api/instances/note?instance=${encodeURIComponent(pdsState.instanceId)}`, 10000);
    if (area) area.disabled = false;
    if (data && data.success && area) {
      area.value = data.content || "";
      pdsState.note.loaded = true;
      pdsState.note.lastSaved = data.content || "";
      pdsState.note.pending = data.content || "";
      if (status) status.textContent = data.exists ? "Yüklendi" : "Yeni not";
    } else if (status) {
      status.textContent = " Not alınamadı";
    }
  } else if (area) {
    area.value = pdsState.note.lastSaved || "";
    pdsState.note.pending = area.value;
    if (status) status.textContent = "Kaydedildi";
  }
  updateCount();

  if (area) {
    area.addEventListener("input", () => {
      updateCount();
      pdsState.note.pending = area.value;
      if (status) status.textContent = "Yazıyor...";
      if (pdsState.note.timer) clearTimeout(pdsState.note.timer);
      pdsState.note.timer = setTimeout(() => {
        pdsState.note.timer = null;
        pdsSaveNote(area.value, status);
      }, 1500);
    });
  }

  const saveBtn = document.getElementById("pdsNoteSave");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      if (pdsState.note.timer) {
        clearTimeout(pdsState.note.timer);
        pdsState.note.timer = null;
      }
      pdsSaveNote(area ? area.value : "", status);
    });
  }

  const folderBtn = document.getElementById("pdsNoteFolder");
  if (folderBtn) folderBtn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}`));
}

async function pdsSaveNote(content, statusEl) {
  const instanceId = String(pdsState.instanceId || "");
  if (!instanceId) return;

  // Son içeriği kuyruğa al. Devam eden bir kayıt varsa, o kayıt bitince
  // en güncel metni tekrar yazar; böylece yazarken oluşan kayıp önlenir.
  pdsState.note.queued = content;
  if (pdsState.note.saving) return;

  pdsState.note.saving = true;
  if (statusEl) statusEl.textContent = "Kaydediliyor...";
  try {
    while (pdsState.note.queued !== null) {
      if (String(pdsState.instanceId || "") !== instanceId) break;
      const payload = pdsState.note.queued;
      pdsState.note.queued = null;
      const data = await apiPost("/api/instances/note", {
        instance: instanceId,
        content: payload
      }, 12000);
      if (String(pdsState.instanceId || "") !== instanceId) break;
      if (data && data.success) {
        pdsState.note.lastSaved = payload;
        pdsState.note.pending = payload;
        if (statusEl) statusEl.textContent = "Kaydedildi";
      } else {
        pdsState.note.queued = payload;
        if (statusEl) statusEl.textContent = `Hata: ${(data && data.error) || "Kaydedilemedi"}`;
        break;
      }
    }
  } finally {
    pdsState.note.saving = false;
  }
}

// ---------- Dünyalar ----------
function pdsWorldIconUrl(worldName) {
  return `${API_BASE}/api/instances/world/icon?instance=${encodeURIComponent(pdsState.instanceId)}` +
    `&world=${encodeURIComponent(worldName)}`;
}

async function pdsRenderWorldsTab(pane) {
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Dünyalar</h3>
        <p class="pds-section-sub">Bu profildeki kayıtlı dünyalar. Kopyalayın veya silin.</p>
      </div>
      <div class="pds-head-actions">
        <button type="button" class="btn-secondary" id="pdsWorldsRefresh">↻ Yenile</button>
        <button type="button" class="btn-secondary" id="pdsWorldsFolder"> Klasörü Aç</button>
      </div>
    </div>
    <div class="pds-asset-list" id="pdsWorldsList">
      <div class="pds-loading"><div class="spinner"></div><span>Dünyalar yükleniyor...</span></div>
    </div>
  `;

  const refresh = document.getElementById("pdsWorldsRefresh");
  if (refresh) refresh.addEventListener("click", () => pdsLoadWorlds(true));
  const folder = document.getElementById("pdsWorldsFolder");
  if (folder) folder.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/saves`));

  pdsLoadWorlds(false);
}

async function pdsLoadWorlds(force) {
  const wrap = document.getElementById("pdsWorldsList");
  if (!wrap) return;
  if (!force && pdsState.worlds !== null) return pdsRenderWorlds();

  const instanceId = String(pdsState.instanceId || "");
  const data = await apiGet(`/api/instances/worlds?instance=${encodeURIComponent(instanceId)}`, 20000);
  if (String(pdsState.instanceId || "") !== instanceId) return;
  if (!data || data.success !== true) {
    wrap.innerHTML = `<div class="pds-empty"> ${pdsEsc((data && data.error) || "Dünya listesi alınamadı.")}</div>`;
    return;
  }
  pdsState.worlds = Array.isArray(data.worlds) ? data.worlds : [];
  pdsRenderWorlds();
}

function pdsRenderWorlds() {
  const wrap = document.getElementById("pdsWorldsList");
  if (!wrap) return;
  const worlds = pdsState.worlds || [];
  if (worlds.length === 0) {
    wrap.innerHTML = `<div class="pds-empty"> Henüz dünya yok.<br>Oyun içinden yeni bir dünya oluşturabilirsiniz.</div>`;
    return;
  }

  wrap.innerHTML = "";
  worlds.forEach(w => {
    const row = document.createElement("div");
    row.className = "pds-asset";

    const icon = document.createElement("div");
    icon.className = "pds-asset-icon";
    icon.textContent = "W";
    if (w.has_icon) {
      const img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.src = pdsWorldIconUrl(w.name);
      img.addEventListener("error", () => { img.remove(); icon.textContent = "W"; });
      icon.textContent = "W";
      icon.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "pds-asset-info";
    info.innerHTML = `
      <div class="pds-asset-name" title="${pdsEsc(w.name)}">${pdsEsc(w.name)}</div>
      <div class="pds-asset-meta">${Number(w.size_mb || 0).toFixed(1)} MB${w.last_played ? " • Son oynanma: " + pdsEsc(w.last_played) : ""}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "pds-item-actions";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "pds-btn";
    openBtn.textContent = "Klasör";
    openBtn.title = "Klasörü Aç";
    openBtn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/saves/${w.name}`));

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "pds-btn";
    copyBtn.textContent = "Kopyala";
    copyBtn.title = "Dünyayı çoğalt";
    copyBtn.addEventListener("click", () => pdsCopyWorld(w, copyBtn));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "pds-btn pds-btn-danger";
    delBtn.textContent = "Sil";
    delBtn.title = "Sil";
    delBtn.addEventListener("click", () => pdsDeleteWorld(w));

    actions.appendChild(openBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(delBtn);
    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
}

async function pdsCopyWorld(world, buttonEl) {
  const original = buttonEl ? buttonEl.textContent : " Kopyala";
  if (buttonEl) { buttonEl.disabled = true; buttonEl.textContent = "Kopyalanıyor..."; }
  const data = await apiPost("/api/instances/world/copy", {
    instance: pdsState.instanceId,
    world: world.name
  }, 120000);
  if (buttonEl) { buttonEl.disabled = false; buttonEl.textContent = original; }

  if (data && data.success) {
    showToast(` Dünya kopyalandı: ${data.name}`, "success");
    await pdsLoadWorlds(true);
  } else {
    showToast(` ${(data && data.error) || "Dünya kopyalanamadı."}`, "error");
  }
}

async function pdsDeleteWorld(world) {
  const ok = await showConfirmDialog({
    icon: "",
    title: "Dünya Silinsin mi?",
    message: `"${world.name}" dünyası ve içindeki tüm kayıtlar kalıcı olarak silinecek. Bu işlem geri alınamaz.`,
    okText: "Sil",
    danger: true
  });
  if (!ok) return;

  const data = await apiPost("/api/instances/world/delete", {
    instance: pdsState.instanceId,
    world: world.name
  }, 30000);
  if (data && data.success) {
    showToast(` ${world.name} silindi.`, "success");
    await pdsLoadWorlds(true);
  } else {
    showToast(` ${(data && data.error) || "Dünya silinemedi."}`, "error");
  }
}

// ---------- Sunucular ----------
async function pdsRenderServersTab(pane) {
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Sunucular</h3>
        <p class="pds-section-sub">servers.dat içindeki kayıtlı sunucular (oyun içinden eklenir).</p>
      </div>
      <div class="pds-head-actions">
        <button type="button" class="btn-secondary" id="pdsServersRefresh">↻ Yenile</button>
        <button type="button" class="btn-secondary" id="pdsServersFolder"> Klasörü Aç</button>
      </div>
    </div>
    <div class="pds-asset-list" id="pdsServersList">
      <div class="pds-loading"><div class="spinner"></div><span>Sunucular yükleniyor...</span></div>
    </div>
  `;

  const refresh = document.getElementById("pdsServersRefresh");
  if (refresh) refresh.addEventListener("click", () => pdsLoadServers(true));
  const folder = document.getElementById("pdsServersFolder");
  if (folder) folder.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}`));

  pdsLoadServers(false);
}

async function pdsLoadServers(force) {
  const wrap = document.getElementById("pdsServersList");
  if (!wrap) return;
  if (!force && pdsState.servers !== null) return pdsRenderServers();

  const instanceId = String(pdsState.instanceId || "");
  const data = await apiGet(`/api/instances/servers?instance=${encodeURIComponent(instanceId)}`, 15000);
  if (String(pdsState.instanceId || "") !== instanceId) return;
  if (!data || data.success !== true) {
    wrap.innerHTML = `<div class="pds-empty"> ${pdsEsc((data && data.error) || "Sunucu listesi alınamadı.")}</div>`;
    return;
  }
  pdsState.servers = Array.isArray(data.servers) ? data.servers : [];
  pdsRenderServers();
}

function pdsRenderServers() {
  const wrap = document.getElementById("pdsServersList");
  if (!wrap) return;
  const servers = pdsState.servers || [];
  if (servers.length === 0) {
    wrap.innerHTML = `<div class="pds-empty"> Sunucu listesi boş (oyun içinden eklenir).</div>`;
    return;
  }

  wrap.innerHTML = "";
  servers.forEach(srv => {
    const row = document.createElement("div");
    row.className = "pds-asset";

    const icon = document.createElement("div");
    icon.className = "pds-asset-icon";
    icon.textContent = "W";

    const info = document.createElement("div");
    info.className = "pds-asset-info";
    info.innerHTML = `
      <div class="pds-asset-name" title="${pdsEsc(srv.name)}">${pdsEsc(srv.name || "İsimsiz sunucu")}</div>
      <div class="pds-asset-meta pds-asset-ip" title="${pdsEsc(srv.ip)}">${pdsEsc(srv.ip || "")}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "pds-item-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "pds-btn";
    copyBtn.textContent = " IP'yi Kopyala";
    copyBtn.addEventListener("click", () => pdsCopyText(srv.ip || ""));

    actions.appendChild(copyBtn);
    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
}

// ---------- Ekran Görüntüleri ----------
function pdsShotUrl(shot) {
  return `${API_BASE}/api/instances/screenshot/file?instance=${encodeURIComponent(pdsState.instanceId)}` +
    `&name=${encodeURIComponent(shot.name)}&t=${Math.round(shot.mtime || 0)}`;
}

async function pdsRenderProfileShotsTab(pane) {
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Ekran Görüntüleri</h3>
        <p class="pds-section-sub">Bu profilde alınan ekran görüntüleri (screenshots/).</p>
      </div>
      <div class="pds-head-actions">
        <button type="button" class="btn-secondary" id="pdsShotsRefresh">↻ Yenile</button>
        <button type="button" class="btn-secondary" id="pdsShotsFolder"> Klasörü Aç</button>
      </div>
    </div>
    <div class="pds-shot-grid" id="pdsShotsGrid">
      <div class="pds-loading" style="grid-column: 1/-1;"><div class="spinner"></div><span>Görüntüler yükleniyor...</span></div>
    </div>
  `;

  const refresh = document.getElementById("pdsShotsRefresh");
  if (refresh) refresh.addEventListener("click", () => pdsLoadProfileShots(true));
  const folder = document.getElementById("pdsShotsFolder");
  if (folder) folder.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/screenshots`));

  pdsLoadProfileShots(false);
}

async function pdsLoadProfileShots(force) {
  const wrap = document.getElementById("pdsShotsGrid");
  if (!wrap) return;
  if (!force && pdsState.shots !== null) return pdsRenderProfileShots();

  const instanceId = String(pdsState.instanceId || "");
  const data = await apiGet(`/api/instances/screenshots?instance=${encodeURIComponent(instanceId)}`, 15000);
  if (String(pdsState.instanceId || "") !== instanceId) return;
  if (!data || data.success !== true) {
    wrap.innerHTML = `<div class="pds-empty" style="grid-column: 1/-1;"> ${pdsEsc((data && data.error) || "Ekran görüntüleri alınamadı.")}</div>`;
    return;
  }
  pdsState.shots = Array.isArray(data.screenshots) ? data.screenshots : [];
  pdsRenderProfileShots();
}

function pdsRenderProfileShots() {
  const wrap = document.getElementById("pdsShotsGrid");
  if (!wrap) return;
  const shots = pdsState.shots || [];
  if (shots.length === 0) {
    wrap.innerHTML = `<div class="pds-empty" style="grid-column: 1/-1;"> Henüz ekran görüntüsü yok.<br>Oyunda F2 tuşuna basarak alabilirsiniz.</div>`;
    return;
  }

  wrap.innerHTML = "";
  shots.forEach(shot => {
    const card = document.createElement("div");
    card.className = "pds-shot-card";
    const url = pdsShotUrl(shot);
    card.innerHTML = `
      <div class="pds-shot-thumb"><img alt="" loading="lazy" src="${pdsEsc(url)}"></div>
      <div class="pds-shot-meta">
        <span title="${pdsEsc(shot.name)}">${pdsEsc(shot.name)}</span>
        <span>${Math.max(1, Math.round((shot.size || 0) / 1024))} KB</span>
      </div>
    `;
    const img = card.querySelector("img");
    if (img) img.addEventListener("error", () => { img.remove(); card.querySelector(".pds-shot-thumb").textContent = "S"; });
    card.addEventListener("click", () => pdsOpenLightbox(url));
    wrap.appendChild(card);
  });
}

function pdsOpenLightbox(url) {
  const lb = document.getElementById("pdsLightbox");
  const img = document.getElementById("pdsLightboxImg");
  if (!lb || !img) return;
  img.src = url;
  lb.classList.add("show");
  lb.setAttribute("aria-hidden", "false");
}

function pdsCloseLightbox() {
  const lb = document.getElementById("pdsLightbox");
  const img = document.getElementById("pdsLightboxImg");
  if (img) img.removeAttribute("src");
  if (lb) {
    lb.classList.remove("show");
    lb.setAttribute("aria-hidden", "true");
  }
}

// ---------- Diğer Kayıtlar ----------
async function pdsRenderOtherLogsTab(pane) {
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> Diğer Kayıtlar</h3>
        <p class="pds-section-sub">crash-reports ve logs klasöründeki kayıt dosyaları. Son 200 satır görüntülenebilir.</p>
      </div>
      <div class="pds-head-actions">
        <button type="button" class="btn-secondary" id="pdsOtherRefresh">↻ Yenile</button>
        <button type="button" class="btn-secondary" id="pdsOtherFolder"> Klasörü Aç</button>
      </div>
    </div>
    <div class="pds-asset-list" id="pdsOtherLogsList">
      <div class="pds-loading"><div class="spinner"></div><span>Kayıtlar yükleniyor...</span></div>
    </div>
  `;

  const refresh = document.getElementById("pdsOtherRefresh");
  if (refresh) refresh.addEventListener("click", () => pdsLoadOtherLogs(true));
  const folder = document.getElementById("pdsOtherFolder");
  if (folder) folder.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/logs`));

  pdsLoadOtherLogs(false);
}

async function pdsLoadOtherLogs(force) {
  const wrap = document.getElementById("pdsOtherLogsList");
  if (!wrap) return;
  if (!force && pdsState.otherLogs !== null) return pdsRenderOtherLogs();

  const instanceId = String(pdsState.instanceId || "");
  const data = await apiGet(`/api/instances/logs?instance=${encodeURIComponent(instanceId)}`, 15000);
  if (String(pdsState.instanceId || "") !== instanceId) return;
  if (!data || data.success !== true) {
    wrap.innerHTML = `<div class="pds-empty"> ${pdsEsc((data && data.error) || "Kayıt listesi alınamadı.")}</div>`;
    return;
  }
  pdsState.otherLogs = Array.isArray(data.files) ? data.files : [];
  pdsRenderOtherLogs();
}

function pdsRenderOtherLogs() {
  const wrap = document.getElementById("pdsOtherLogsList");
  if (!wrap) return;
  const files = pdsState.otherLogs || [];
  if (files.length === 0) {
    wrap.innerHTML = `<div class="pds-empty"> Kayıt dosyası yok.</div>`;
    return;
  }

  wrap.innerHTML = "";
  files.forEach(f => {
    const row = document.createElement("div");
    row.className = "pds-asset";

    const icon = document.createElement("div");
    icon.className = "pds-asset-icon";
    icon.textContent = f.dir === "crash-reports" ? "" : "";

    const info = document.createElement("div");
    info.className = "pds-asset-info";
    info.innerHTML = `
      <div class="pds-asset-name" title="${pdsEsc(f.name)}">${pdsEsc(f.name)}</div>
      <div class="pds-asset-meta">${pdsEsc(f.dir)}/ • ${Number(f.size_kb || 0).toFixed(1)} KB • ${pdsEsc(f.modified || "")}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "pds-item-actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "pds-btn";
    viewBtn.textContent = " Görüntüle";
    viewBtn.addEventListener("click", () => pdsOpenLogViewer(f));

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "pds-btn";
    folderBtn.textContent = "Klasör";
    folderBtn.title = "Klasörü Aç";
    folderBtn.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/${f.dir}`));

    actions.appendChild(viewBtn);
    actions.appendChild(folderBtn);
    row.appendChild(icon);
    row.appendChild(info);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
}

async function pdsOpenLogViewer(file) {
  const pane = document.querySelector(".pds-pane");
  if (!pane) return;
  pane.innerHTML = `
    <div class="pds-section-head">
      <div>
        <h3 class="pds-section-title"> ${pdsEsc(file.name)}</h3>
        <p class="pds-section-sub">${pdsEsc(file.dir)}/ • son 200 satır</p>
      </div>
      <div class="pds-head-actions">
        <button type="button" class="btn-secondary" id="pdsLogViewerBack">← Geri</button>
        <button type="button" class="btn-secondary" id="pdsLogViewerFolder"> Klasörü Aç</button>
      </div>
    </div>
    <pre class="pds-log" id="pdsLogViewerOut">Kayıt yükleniyor...</pre>
  `;

  const back = document.getElementById("pdsLogViewerBack");
  if (back) back.addEventListener("click", () => pdsRenderOtherLogsTab(pane));
  const folder = document.getElementById("pdsLogViewerFolder");
  if (folder) folder.addEventListener("click", () => openSystemFolder(`instances/${pdsState.instanceId}/${file.dir}`));

  const out = document.getElementById("pdsLogViewerOut");
  const data = await apiGet(
    `/api/instances/log/file?instance=${encodeURIComponent(pdsState.instanceId)}` +
    `&dir=${encodeURIComponent(file.dir)}&name=${encodeURIComponent(file.name)}`,
    20000
  );
  if (!out) return;
  if (data && data.success && Array.isArray(data.lines)) {
    out.textContent = data.lines.length ? data.lines.join("\n") : "Kayıt boş.";
    out.scrollTop = out.scrollHeight;
  } else {
    out.textContent = ` ${(data && data.error) || "Kayıt okunamadı."}`;
  }
}

/* ==============================================================================
   ARKADAŞLAR / SOSYAL
   ============================================================================== */

function socialEsc(value) {
  return escapeHtml(value === null || value === undefined ? "" : value);
}

function socialFormatCode(code) {
  const clean = String(code || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!clean) return "————";
  if (clean.length === 8) return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  return clean;
}

function socialFormatTimeLeft(expires) {
  const secs = Math.max(0, Number(expires || 0) - Date.now() / 1000);
  if (!secs) return "süresi doldu";
  const mins = Math.ceil(secs / 60);
  if (mins >= 60) return `${Math.ceil(mins / 60)} sa kaldı`;
  return `${mins} dk kaldı`;
}

function socialInitial(name) {
  const ch = String(name || "?").trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

function socialEmptyMarkup(title, desc, icon = "·") {
  return `<div class="social-empty">
    <div class="social-empty-icon">${socialEsc(icon)}</div>
    <div class="social-empty-title">${socialEsc(title)}</div>
    <div class="social-empty-desc">${socialEsc(desc)}</div>
  </div>`;
}

function startSocialPolling() {
  if (socialUI.timer) return;
  socialUI.timer = setInterval(() => {
    if (document.hidden) return;
    const pane = document.getElementById("tab-friends");
    if (pane && pane.classList.contains("active")) loadSocialState(false);
  }, 4000);
}

async function ensureSocialRelay(force = false) {
  if (socialUI.relayStarting) return;
  if (socialUI.data && socialUI.data.connected) return;
  if (socialUI.relayStartAttempted && !force) return;
  socialUI.relayStartAttempted = true;
  socialUI.relayStarting = true;
  socialUI.apiError = "";
  renderSocial();
  try {
    const data = await apiPost("/api/social/relay/start", {}, 160000);
    if (data && data.success !== false) {
      socialUI.data = data;
      socialUI.apiError = "";
      renderSocial();
      await loadSocialState(true);
    } else {
      socialUI.apiError = (data && data.error) || "Sosyal relay başlatılamadı. İnternet bağlantısını kontrol et.";
      renderSocial();
    }
  } catch (_) {
    socialUI.apiError = "Sosyal relay başlatılamadı. İnternet bağlantısını kontrol et.";
    renderSocial();
  } finally {
    socialUI.relayStarting = false;
    renderSocial();
  }
}

async function loadSocialState(initial = false) {
  if (socialUI.loading) return;
  socialUI.loading = true;
  try {
    const data = await apiGet("/api/social/state", 9000);
    if (!data) {
      socialUI.apiError = "Core servisine ulaşılamadı.";
      renderSocial();
      return;
    }
    if (data.success === false) {
      socialUI.apiError = data.error || "Sosyal servis hazır değil.";
      renderSocial();
      return;
    }
    socialUI.apiError = "";
    socialUI.data = data;
    const events = Array.isArray(data.events) ? data.events : [];
    if (!socialUI.initialized) {
      socialUI.initialized = true;
      socialUI.lastSeq = events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    } else {
      let newest = socialUI.lastSeq;
      events.forEach((ev) => {
        const seq = Number(ev.seq) || 0;
        if (seq <= socialUI.lastSeq) return;
        newest = Math.max(newest, seq);
        if (ev.message) {
          const kind = String(ev.kind || "");
          const type = kind.includes("failed") || kind.includes("error") ? "error"
            : kind === "world_invite" || kind === "friend_request" || kind === "friend_accepted" ? "info"
              : "success";
          showToast(String(ev.message), type);
        }
      });
      socialUI.lastSeq = newest;
    }
    renderSocial();
  } finally {
    socialUI.loading = false;
  }
}

function renderSocial() {
  const data = socialUI.data;
  const connected = !!(data && data.connected);
  const pill = document.getElementById("socialConnectionPill");
  if (pill) {
    pill.dataset.state = connected ? "online" : (data && data.error ? "offline" : "connecting");
    pill.textContent = connected ? "Relay bağlı" : (data && data.error ? "Bağlantı yok" : "Bağlanıyor…");
  }

  const banner = document.getElementById("socialBanner");
  if (banner) {
    const error = socialUI.apiError || (data && data.error) || "";
    if (!connected && socialUI.relayStarting) {
      banner.hidden = false;
      banner.dataset.state = "connecting";
      banner.innerHTML = `<span><strong>Sosyal relay başlatılıyor…</strong> Ücretsiz tünel hazırlanıyor, bu birkaç saniye sürebilir.</span>`;
    } else if (!connected && (error || !data)) {
      banner.hidden = false;
      banner.dataset.state = "error";
      banner.innerHTML = `<span><strong>Sosyal relay kapalı.</strong> Arkadaş eklemek için Bağlan; bir davete katılmak için aşağıdaki kodu uygula. ${socialEsc(error || "")}</span>
        <button type="button" class="btn-secondary" data-social-start-relay>Bağlan</button>
        <button type="button" class="btn-secondary" data-social-settings>Bağlantı ayarları</button>`;
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
    }
  }

  const code = (data && ((data.profile && data.profile.code) || (data.you && data.you.code))) || "";
  const codeBtn = document.getElementById("socialCopyCode");
  if (codeBtn) {
    codeBtn.textContent = socialFormatCode(code);
    codeBtn.disabled = !code;
  }
  const addBtn = document.getElementById("socialAddBtn");
  const addInput = document.getElementById("socialAddCode");
  if (addBtn) addBtn.disabled = !connected;
  if (addInput) addInput.disabled = !connected;

  const friends = (data && Array.isArray(data.friends)) ? data.friends : [];
  const requests = (data && data.requests) || { in: [], out: [] };
  const invites = (data && Array.isArray(data.invites)) ? data.invites : [];
  const joined = (data && data.joined) || null;
  const incoming = Array.isArray(requests.in) ? requests.in : [];
  const outgoing = Array.isArray(requests.out) ? requests.out : [];
  const online = friends.filter(f => f.online).length;

  const count = document.getElementById("socialFriendCount");
  if (count) count.textContent = String(friends.length);
  const summary = document.getElementById("socialPresenceSummary");
  if (summary) {
    summary.textContent = friends.length
      ? `${online} çevrimiçi • ${friends.length - online} çevrimdışı`
      : "Henüz arkadaş yok.";
  }

  const friendsList = document.getElementById("socialFriendsList");
  if (friendsList) {
    if (!friends.length) {
      friendsList.innerHTML = socialEmptyMarkup(
        connected ? "Henüz arkadaşın yok" : "Arkadaş listesi yükleniyor",
        connected ? "Arkadaşının kodunu yukarıya girerek başla." : "Relay bağlantısı kurulunca arkadaşların burada görünecek.",
        "＋"
      );
    } else {
      friendsList.innerHTML = friends.map((f) => {
        const fid = socialEsc(f.player_id);
        const name = socialEsc(f.name || "Oyuncu");
        const online = !!f.online;
        const status = String(f.status || (online ? "menu" : "offline"));
        const isPlaying = status === "playing";
        const meta = online
          ? (isPlaying ? `Oyunda${f.detail ? ` • ${socialEsc(f.detail)}` : ""}` : "Çevrimiçi")
          : "Çevrimdışı";
        const invite = invites.find((iv) => iv.host_id === f.player_id);
        const isJoined = !!(joined && (invite ? joined.session_id === invite.session_id : joined.host_id === f.player_id));
        return `<div class="social-friend" data-online="${online ? "1" : "0"}" data-status="${socialEsc(status)}">
          <div class="social-avatar">${socialEsc(socialInitial(f.name))}</div>
          <div class="social-friend-info">
            <div class="social-friend-name">${name}</div>
            <div class="social-friend-meta" data-online="${online ? "1" : "0"}" data-status="${socialEsc(status)}">${meta}</div>
          </div>
          <div class="social-friend-actions">
            ${invite && !isJoined ? `<button type="button" class="social-mini-btn primary" data-social-action="join" data-session-id="${socialEsc(invite.session_id)}" ${socialUI.joinBusy ? "disabled" : ""}>Katıl</button>` : ""}
            ${isJoined ? `<button type="button" class="social-mini-btn" data-social-action="leave" data-session-id="${socialEsc(joined.session_id)}">Bağlısın</button>` : ""}
            <button type="button" class="social-mini-btn danger" data-social-action="remove" data-player-id="${fid}" data-player-name="${name}">Çıkar</button>
          </div>
        </div>`;
      }).join("");
    }
  }

  const requestPanel = document.getElementById("socialRequestsPanel");
  const requestList = document.getElementById("socialRequestsList");
  const requestCount = document.getElementById("socialRequestCount");
  const totalRequests = incoming.length + outgoing.length;
  if (requestCount) requestCount.textContent = String(totalRequests);
  if (requestPanel) requestPanel.hidden = totalRequests === 0;
  if (requestList) {
    let html = "";
    incoming.forEach((r) => {
      html += `<div class="social-request">
        <div class="social-avatar">${socialEsc(socialInitial(r.name))}</div>
        <div class="social-request-info">
          <div class="social-request-name">${socialEsc(r.name || "Oyuncu")}</div>
          <div class="social-request-sub">sana istek gönderdi</div>
        </div>
        <div class="social-friend-actions">
          <button type="button" class="social-mini-btn primary" data-social-action="accept" data-player-id="${socialEsc(r.player_id)}">Kabul et</button>
          <button type="button" class="social-mini-btn" data-social-action="decline" data-player-id="${socialEsc(r.player_id)}">Reddet</button>
        </div>
      </div>`;
    });
    outgoing.forEach((r) => {
      html += `<div class="social-request">
        <div class="social-avatar">${socialEsc(socialInitial(r.name))}</div>
        <div class="social-request-info">
          <div class="social-request-name">${socialEsc(r.name || "Oyuncu")}</div>
          <div class="social-request-sub">istek gönderildi • yanıt bekleniyor</div>
        </div>
        <span class="social-connection-pill" data-state="connecting">Bekliyor</span>
      </div>`;
    });
    requestList.innerHTML = html || socialEmptyMarkup("İstek yok", "Yeni arkadaşlık istekleri burada görünür.", "＋");
  }

  const invitesList = document.getElementById("socialInvitesList");
  if (invitesList) {
    const visible = invites.filter((iv) => !socialUI.dismissedInvites?.has(iv.session_id));
    const cards = visible.map((iv) => {
      const isJoined = !!(joined && joined.session_id === iv.session_id);
      return `<div class="social-invite">
        <div class="social-invite-top">
          <div class="social-avatar">${socialEsc(socialInitial(iv.host_name))}</div>
          <div class="social-invite-info">
            <div class="social-invite-name">${socialEsc(iv.host_name || "Arkadaş")}</div>
            <div class="social-invite-world">${socialEsc(iv.world || "Dünya")} • ${socialEsc(isJoined ? "bağlısın" : socialFormatTimeLeft(iv.expires))}</div>
          </div>
        </div>
        <div class="social-invite-actions">
          ${isJoined
            ? `<button type="button" class="social-mini-btn primary" data-social-action="leave" data-session-id="${socialEsc(iv.session_id)}">Bağlantıyı kes</button>`
            : `<button type="button" class="social-mini-btn primary" data-social-action="join" data-session-id="${socialEsc(iv.session_id)}" ${socialUI.joinBusy ? "disabled" : ""}>Dünyaya katıl</button>
               <button type="button" class="social-mini-btn" data-social-action="dismiss" data-session-id="${socialEsc(iv.session_id)}">Sonra</button>`}
        </div>
      </div>`;
    });
    const joinedAlreadyListed = !!(joined && visible.some((iv) => iv.session_id === joined.session_id));
    if (joined && !joinedAlreadyListed) {
      cards.unshift(`<div class="social-invite">
        <div class="social-invite-top">
          <div class="social-avatar">${socialEsc(socialInitial(joined.host_name))}</div>
          <div class="social-invite-info">
            <div class="social-invite-name">${socialEsc(joined.host_name || "Arkadaş")}</div>
            <div class="social-invite-world">${socialEsc(joined.world || "Dünya")} • bağlısın</div>
          </div>
        </div>
        <div class="social-invite-actions">
          <button type="button" class="social-mini-btn primary" data-social-action="leave" data-session-id="${socialEsc(joined.session_id)}">Bağlantıyı kes</button>
        </div>
      </div>`);
    }
    if (!cards.length) {
      invitesList.innerHTML = socialEmptyMarkup(
        "Davet yok",
        "Bir arkadaşın dünyasını paylaştığında burada görünür.",
        "◇"
      );
    } else {
      invitesList.innerHTML = cards.join("");
    }
  }

  renderSocialShare(data);
  renderHostRelay(data && data.host_relay, data && data.invite);
  renderSocialNavDot(incoming.length + invites.length);
}

function renderHostRelay(hr, invite) {
  const el = document.getElementById("socialHostRelay");
  if (!el) return;
  const share = hr && hr.share;
  if (!hr || (!share && !hr.running && !hr.error)) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  if (share) {
    el.dataset.state = "ready";
    const addr = `${share.host || "bore.pub"}:${share.control_port || ""}`;
    el.innerHTML = `<div class="social-host-relay-head">
        <span class="eyebrow">Ücretsiz relay</span>
        <span class="social-connection-pill" data-state="online">Hazır</span>
      </div>
      <div class="social-host-relay-address"><code>${socialEsc(addr)}</code></div>
      <div class="social-host-relay-actions">
        <button type="button" class="social-mini-btn primary" data-social-action="copy-invite" ${invite ? "" : "disabled"}>Davet kodu</button>
        <button type="button" class="social-mini-btn" data-social-action="copy-relay">Adres</button>
        <button type="button" class="social-mini-btn danger" data-social-action="stop-host-relay">Kapat</button>
      </div>
      <p class="social-hint">${invite ? "Davet kodunu arkadaşlarına gönder; Arkadaşlar → Daveti uygula ile tek adımda bağlanırlar." : "Arkadaşların Bağlantı ekranına bu adresi girsin."} Senin launcher'ın otomatik olarak yerel relay'e bağlı.</p>`;
  } else if (hr.error) {
    el.dataset.state = "error";
    el.innerHTML = `<div class="social-host-relay-head"><span class="eyebrow">Host relay</span></div>
      <p class="social-hint">${socialEsc(hr.error)}</p>`;
  } else {
    el.dataset.state = "starting";
    el.innerHTML = `<div class="social-host-relay-head"><span class="eyebrow">Host relay</span><span class="social-connection-pill" data-state="connecting">Başlatılıyor…</span></div>
      <p class="social-hint">Ücretsiz tünel açılıyor; harici uygulama indirilmez.</p>`;
  }
}

function renderSocialShare(data) {
  const idle = document.getElementById("socialShareIdle");
  const active = document.getElementById("socialShareActive");
  if (!idle || !active) return;
  const share = data && data.share;
  if (share) {
    idle.hidden = true;
    active.hidden = false;
    const guests = Array.isArray(share.guests) ? share.guests.length : 0;
    active.innerHTML = `<div class="social-share-active">
      <div class="social-share-status">
        <div class="social-share-status-text">
          <strong>${socialEsc(share.world || "Dünya")}</strong>
          Port ${socialEsc(share.port)} • ${guests ? `${guests} arkadaş bağlı` : "arkadaşların davet listesinde"}
        </div>
      </div>
      <button type="button" class="btn-secondary social-wide-btn" data-social-action="unshare">Paylaşımı kapat</button>
      <p class="social-hint">Davet, çevrimiçi arkadaşlarına otomatik gönderildi. Arkadaşın katılınca Minecraft'ta dünyana bağlanır.</p>
    </div>`;
  } else {
    idle.hidden = false;
    active.hidden = true;
    active.innerHTML = "";
    const lanWrap = document.getElementById("socialLanWorlds");
    const worlds = (data && Array.isArray(data.lan_worlds)) ? data.lan_worlds : [];
    if (lanWrap) {
      if (!worlds.length) {
        lanWrap.innerHTML = `<div class="social-lan-empty">Açık LAN dünyası bulunamadı. Minecraft'ta dünyanı LAN'a açtığında burada görünür.</div>`;
      } else {
        lanWrap.innerHTML = worlds.map((w) => `<button type="button" class="social-lan-world${socialUI.selectedLanPort === Number(w.port) ? " active" : ""}"
          data-lan-port="${Number(w.port)}" data-lan-name="${socialEsc(w.motd || "Minecraft dünyası")}">
          <span class="social-lan-world-name">${socialEsc(w.motd || "Minecraft dünyası")}</span>
          <span class="social-lan-world-port">:${Number(w.port)}</span>
        </button>`).join("");
      }
    }
  }
}

function renderSocialNavDot(count) {
  const dot = document.getElementById("socialNavDot");
  if (dot) dot.hidden = count <= 0;
}

async function socialAddFriend() {
  const input = document.getElementById("socialAddCode");
  const btn = document.getElementById("socialAddBtn");
  if (!input || !btn) return;
  const code = input.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (code.length < 6) {
    showToast("Geçerli bir arkadaş kodu gir.", "info");
    input.focus();
    return;
  }
  btn.disabled = true;
  const data = await apiPost("/api/social/friend/add", { code }, 15000);
  btn.disabled = false;
  if (!data || data.success === false) {
    showToast((data && data.error) || "Arkadaşlık isteği gönderilemedi.", "error");
    return;
  }
  input.value = "";
  const stateText = data.result && data.result.state;
  if (stateText === "accepted") showToast("Arkadaş eklendi.", "success");
  else if (stateText === "pending") showToast("İstek zaten bekliyor.", "info");
  else showToast("Arkadaşlık isteği gönderildi.", "success");
  await loadSocialState(true);
}

async function socialRespondFriend(playerId, accept) {
  const data = await apiPost("/api/social/friend/respond", { player_id: playerId, accept: !!accept }, 15000);
  if (!data || data.success === false) {
    showToast((data && data.error) || "İstek yanıtlanamadı.", "error");
    return;
  }
  showToast(accept ? "Arkadaş eklendi." : "İstek reddedildi.", accept ? "success" : "info");
  await loadSocialState(true);
}

async function socialRemoveFriend(playerId, name) {
  const ok = await showConfirmDialog({
    title: "Arkadaşlıktan çıkar",
    message: `"${name || "Oyuncu"}" arkadaş listenden çıkarılacak. Emin misin?`,
    okText: "Çıkar",
    danger: true
  });
  if (!ok) return;
  const data = await apiPost("/api/social/friend/remove", { player_id: playerId }, 15000);
  if (!data || data.success === false) {
    showToast((data && data.error) || "Arkadaş çıkarılamadı.", "error");
    return;
  }
  showToast("Arkadaş listenden çıkarıldı.", "info");
  await loadSocialState(true);
}

async function socialShareWorld() {
  if (socialUI.shareBusy) return;
  const nameInput = document.getElementById("socialWorldName");
  const portInput = document.getElementById("socialWorldPort");
  const btn = document.getElementById("socialShareBtn");
  const world = (nameInput && nameInput.value.trim()) || "Dünya";
  const port = Number(portInput && portInput.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showToast("Geçerli bir LAN portu gir.", "info");
    portInput?.focus();
    return;
  }
  socialUI.shareBusy = true;
  const needsRelay = !(socialUI.data && socialUI.data.connected);
  if (btn) {
    btn.disabled = true;
    btn.textContent = needsRelay ? "Ücretsiz relay başlatılıyor…" : "Açılıyor…";
  }
  const data = await apiPost("/api/social/world/share", { world, port }, 120000);
  socialUI.shareBusy = false;
  if (btn) { btn.disabled = false; btn.textContent = "Dünyayı arkadaşlarına aç"; }
  if (!data || data.success === false) {
    showToast((data && data.error) || "Dünya paylaşılamadı.", "error");
    return;
  }
  showToast("Dünya arkadaşlarına açıldı.", "success");
  await loadSocialState(true);
}

async function socialUnshareWorld() {
  const data = await apiPost("/api/social/world/unshare", {}, 15000);
  if (!data || data.success === false) {
    showToast((data && data.error) || "Paylaşım kapatılamadı.", "error");
    return;
  }
  showToast("Dünya paylaşımı kapatıldı.", "info");
  await loadSocialState(true);
}

async function socialJoinWorld(sessionId) {
  if (!sessionId || socialUI.joinBusy) return;
  if (!getActiveInstance()) {
    showToast("Katılmak için önce bir profil seç.", "info");
    switchTab("tab-instances");
    return;
  }
  if (state.engineMode === "running" || state.launchRequested) {
    showToast("Minecraft açıkken otomatik katılınamıyor. Oyunu kapatıp tekrar dene.", "info");
    return;
  }
  socialUI.joinBusy = true;
  renderSocial();
  const data = await apiPost("/api/social/world/join", { session_id: sessionId }, 50000);
  if (!data || data.success === false) {
    socialUI.joinBusy = false;
    showToast((data && data.error) || "Dünyaya katılınamadı.", "error");
    return;
  }
  const localPort = data.result && data.result.local_port;
  if (!localPort) {
    socialUI.joinBusy = false;
    showToast("Yerel bağlantı portu alınamadı.", "error");
    return;
  }
  showToast("Dünyaya bağlanılıyor, Minecraft açılıyor…", "success");
  const launched = await handleLaunchGame({ quickPlayMultiplayer: `127.0.0.1:${localPort}` });
  socialUI.joinBusy = false;
  if (!launched) {
    await apiPost("/api/social/world/leave", {}, 8000);
  }
  await loadSocialState(true);
}

async function socialLeaveWorld() {
  await apiPost("/api/social/world/leave", {}, 8000);
  await loadSocialState(true);
}

async function socialCopyCode() {
  const code = ((socialUI.data && socialUI.data.profile && socialUI.data.profile.code) ||
    (socialUI.data && socialUI.data.you && socialUI.data.you.code) || "").replace(/[^A-Za-z0-9]/g, "");
  if (!code) return;
  const pretty = socialFormatCode(code);
  try {
    await navigator.clipboard.writeText(pretty);
    showToast(`Arkadaş kodu kopyalandı: ${pretty}`, "success");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = pretty;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(`Arkadaş kodu kopyalandı: ${pretty}`, "success");
    } catch (err) {
      showToast(`Arkadaş kodun: ${pretty}`, "info");
    }
    ta.remove();
  }
}

function openSocialSettings() {
  const data = socialUI.data || {};
  const profile = data.profile || {};
  const relay = data.relay || {};
  const nameEl = document.getElementById("socialSettingsName");
  const hostEl = document.getElementById("socialSettingsHost");
  const portEl = document.getElementById("socialSettingsPort");
  const tlsEl = document.getElementById("socialSettingsTls");
  const rendezvousEl = document.getElementById("socialSettingsRendezvous");
  if (nameEl) nameEl.value = profile.name || state.username || "";
  if (hostEl) hostEl.value = relay.host || profile.relay_host || "127.0.0.1";
  if (portEl) portEl.value = relay.port || profile.relay_port || 19021;
  if (tlsEl) tlsEl.checked = !!profile.relay_tls;
  if (rendezvousEl) rendezvousEl.value = profile.rendezvous_url || "";
  const modal = document.getElementById("socialSettingsModal");
  if (modal) {
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    nameEl?.focus();
  }
}

function closeSocialSettings() {
  const modal = document.getElementById("socialSettingsModal");
  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }
}

async function saveSocialSettings() {
  const name = (document.getElementById("socialSettingsName")?.value || "").trim();
  const host = (document.getElementById("socialSettingsHost")?.value || "").trim();
  const port = Number(document.getElementById("socialSettingsPort")?.value || 0);
  const tls = !!document.getElementById("socialSettingsTls")?.checked;
  const rendezvousUrl = (document.getElementById("socialSettingsRendezvous")?.value || "").trim();
  if (!name) {
    showToast("Görünen ad boş olamaz.", "info");
    return;
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    showToast("Relay adresi ve portu geçerli olmalı.", "info");
    return;
  }
  const data = await apiPost("/api/social/profile", {
    name, relay_host: host, relay_port: port, tls, rendezvous_url: rendezvousUrl
  }, 20000);
  if (!data || data.success === false) {
    showToast((data && data.error) || "Ayarlar kaydedilemedi.", "error");
    return;
  }
  socialUI.data = data;
  closeSocialSettings();
  showToast("Sosyal ayarlar kaydedildi.", "success");
  renderSocial();
  await loadSocialState(true);
}

function initSocialUI() {
  document.getElementById("socialRefreshBtn")?.addEventListener("click", () => loadSocialState(true));
  document.getElementById("socialSettingsBtn")?.addEventListener("click", openSocialSettings);
  document.getElementById("socialSettingsClose")?.addEventListener("click", closeSocialSettings);
  document.getElementById("socialSettingsCancel")?.addEventListener("click", closeSocialSettings);
  document.getElementById("socialSettingsSave")?.addEventListener("click", saveSocialSettings);
  document.getElementById("socialCopyCode")?.addEventListener("click", socialCopyCode);
  document.getElementById("socialAddBtn")?.addEventListener("click", socialAddFriend);
  document.getElementById("socialAddCode")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      socialAddFriend();
    }
  });
  document.getElementById("socialShareBtn")?.addEventListener("click", socialShareWorld);
  document.getElementById("socialBanner")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-social-start-relay]")) ensureSocialRelay(true);
    else if (e.target.closest("[data-social-settings]")) openSocialSettings();
  });
  document.getElementById("socialSettingsModal")?.addEventListener("click", (e) => {
    if (e.target.id === "socialSettingsModal") closeSocialSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSocialSettings();
  });

  document.getElementById("socialLanWorlds")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lan-port]");
    if (!btn) return;
    const port = Number(btn.dataset.lanPort);
    const name = btn.dataset.lanName || "Minecraft dünyası";
    socialUI.selectedLanPort = port;
    socialUI.selectedLanName = name;
    const nameInput = document.getElementById("socialWorldName");
    const portInput = document.getElementById("socialWorldPort");
    if (nameInput) nameInput.value = name;
    if (portInput) portInput.value = String(port);
    renderSocialShare(socialUI.data);
  });

  document.getElementById("socialFriendsList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-social-action]");
    if (!btn) return;
    const action = btn.dataset.socialAction;
    if (action === "join") socialJoinWorld(btn.dataset.sessionId);
    else if (action === "leave") socialLeaveWorld();
    else if (action === "remove") socialRemoveFriend(btn.dataset.playerId, btn.dataset.playerName);
  });

  document.getElementById("socialRequestsList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-social-action]");
    if (!btn) return;
    const action = btn.dataset.socialAction;
    if (action === "accept") socialRespondFriend(btn.dataset.playerId, true);
    else if (action === "decline") socialRespondFriend(btn.dataset.playerId, false);
  });

  document.getElementById("socialInvitesList")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-social-action]");
    if (!btn) return;
    const action = btn.dataset.socialAction;
    if (action === "join") socialJoinWorld(btn.dataset.sessionId);
    else if (action === "leave") socialLeaveWorld();
    else if (action === "dismiss") {
      if (!socialUI.dismissedInvites) socialUI.dismissedInvites = new Set();
      socialUI.dismissedInvites.add(btn.dataset.sessionId);
      renderSocial();
    }
  });

  document.getElementById("socialShareActive")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-social-action]");
    if (btn && btn.dataset.socialAction === "unshare") socialUnshareWorld();
  });

  document.getElementById("socialHostRelay")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-social-action]");
    if (!btn) return;
    const action = btn.dataset.socialAction;
    if (action === "copy-relay") socialCopyHostRelay(false);
    else if (action === "copy-invite") socialCopyHostRelay(true);
    else if (action === "stop-host-relay") socialStopHostRelay();
  });

  document.getElementById("socialInviteApply")?.addEventListener("click", () => {
    applySocialInvite(document.getElementById("socialInviteInput")?.value || "");
  });
  document.getElementById("socialInviteInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applySocialInvite(e.target.value || "");
    }
  });
  document.getElementById("socialClipboardBanner")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-social-action]");
    if (!btn) return;
    if (btn.dataset.socialAction === "apply-clipboard") {
      applySocialInvite(socialUI.pendingClipboardInvite || "");
    } else if (btn.dataset.socialAction === "dismiss-clipboard") {
      socialUI.pendingClipboardInvite = "";
      renderClipboardBanner("");
    }
  });
  initSocialClipboard();
}

async function applySocialInvite(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    showToast("Davet kodu boş.", "info");
    return;
  }
  const btn = document.getElementById("socialInviteApply");
  if (btn) { btn.disabled = true; btn.textContent = "Uygulanıyor…"; }
  const data = await apiPost("/api/social/invite/apply", { code: text }, 120000);
  if (btn) { btn.disabled = false; btn.textContent = "Daveti uygula"; }
  if (!data || data.success === false) {
    showToast((data && data.error) || "Davet uygulanamadı.", "error");
    return;
  }
  socialUI.data = data;
  socialUI.pendingClipboardInvite = "";
  renderClipboardBanner("");
  const input = document.getElementById("socialInviteInput");
  if (input) input.value = "";
  showToast("Davet uygulandı; relay ayarlandı.", "success");
  renderSocial();
  await loadSocialState(true);
}

function renderClipboardBanner(code) {
  const el = document.getElementById("socialClipboardBanner");
  if (!el) return;
  if (!code) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const short = code.length > 44 ? `${code.slice(0, 44)}…` : code;
  el.hidden = false;
  el.innerHTML = `<span><strong>Panoda davet bulundu.</strong> ${socialEsc(short)}</span>
    <span class="social-clipboard-banner-actions">
      <button type="button" class="social-mini-btn primary" data-social-action="apply-clipboard">Uygula</button>
      <button type="button" class="social-mini-btn" data-social-action="dismiss-clipboard">Yoksay</button>
    </span>`;
}

async function readClipboardInvite() {
  let text = "";
  try {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      text = await window.__TAURI__.core.invoke("check_clipboard_invite") || "";
    }
  } catch (_) {}
  if (!text) {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        text = await navigator.clipboard.readText();
      }
    } catch (_) {}
  }
  return text || "";
}

function handleExternalInvite(text) {
  const m = String(text || "").match(/CL1-[A-Za-z0-9_-]+/i);
  if (!m) return;
  const code = m[0].replace(/^cl1-/i, "CL1-");
  if (!code || code === socialUI.lastClipboardInvite) return;
  socialUI.lastClipboardInvite = code;
  socialUI.pendingClipboardInvite = code;
  renderClipboardBanner(code);
  switchTab("tab-friends");
}

async function inspectClipboardForInvite() {
  if (document.hidden) return;
  const text = await readClipboardInvite();
  if (!text) return;
  handleExternalInvite(text);
}

async function initInviteChannel() {
  try {
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      const startup = await window.__TAURI__.core.invoke("take_startup_invite");
      if (startup) handleExternalInvite(startup);
    }
    if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
      await window.__TAURI__.event.listen("cl-invite", (event) => handleExternalInvite(event.payload));
      await window.__TAURI__.event.listen("deep-link://new-url", (event) => {
        const urls = Array.isArray(event.payload) ? event.payload : [event.payload];
        urls.forEach((url) => handleExternalInvite(url));
      });
    }
  } catch (_) {}
}

function initSocialClipboard() {
  window.addEventListener("focus", inspectClipboardForInvite);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) inspectClipboardForInvite();
  });
  setTimeout(inspectClipboardForInvite, 900);
  initInviteChannel();
}

async function socialCopyHostRelay(withInvite) {
  const data = socialUI.data || {};
  const share = data.host_relay && data.host_relay.share;
  if (!share) {
    showToast("Host relay henüz hazır değil.", "info");
    return;
  }
  const host = share.host || "bore.pub";
  const port = share.control_port;
  const invite = data.invite;
  if (withInvite && !invite) {
    showToast("Davet kodu için önce dünyayı paylaş.", "info");
    return;
  }
  const text = withInvite
    ? `Cookie Launcher daveti:\n${invite.code}\n${invite.web_link}\n\nLauncher → Arkadaşlar → Daveti uygula.`
    : `${host}:${port}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast(withInvite ? "Davet metni kopyalandı." : "Relay adresi kopyalandı.", "success");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      showToast(withInvite ? "Davet metni kopyalandı." : "Relay adresi kopyalandı.", "success");
    } catch (err) {
      showToast(`Relay: ${host}:${port}`, "info");
    }
    ta.remove();
  }
}

async function socialStopHostRelay() {
  const ok = await showConfirmDialog({
    title: "Host relay'i kapat",
    message: "Ücretsiz relay ve bore tüneli kapanacak. Arkadaşların bağlantısı kesilecek. Emin misin?",
    okText: "Kapat",
    danger: true
  });
  if (!ok) return;
  const data = await apiPost("/api/social/relay/stop", {}, 20000);
  if (!data || data.success === false) {
    showToast((data && data.error) || "Relay kapatılamadı.", "error");
    return;
  }
  socialUI.data = data;
  renderSocial();
  showToast("Host relay kapatıldı.", "info");
  await loadSocialState(true);
}

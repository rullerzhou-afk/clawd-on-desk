"use strict";
const $ = (id) => document.getElementById(id);
let pending = 0,
  editing = false,
  seeking = false,
  queue = Promise.resolve(),
  timelineState = null,
  seekGuard = null,
  seekWaiting = null,
  seekSending = false;
function display(result) {
  if (result.library) {
    displayLibrary(result.library);
    return;
  }
  if (result.lyrics) {
    $("lyrics").checked = result.lyrics.visible;
    $("lyrics").disabled = result.lyrics.canControl === false;
    $("lyrics-status").textContent = result.lyrics.visible
      ? "已显示"
      : "已隐藏";
    $("message").textContent =
      result.lyrics.canControl === false
        ? "当前QQ音乐不支持直接控制歌词开关"
        : "桌面歌词状态已同步";
    $("message").classList.remove("error");
    return;
  }
  if (!result.ok) {
    $("message").textContent = result.error || "连接失败，请重试";
    $("message").classList.add("error");
    return;
  }
  if (!result.state) return;
  const state = result.state;
  $("title").textContent =
    state.title || (state.connected ? "QQ 音乐" : "尚未连接 QQ 音乐");
  $("title").title = $("title").textContent;
  $("artist").textContent =
    state.artist ||
    (state.connected ? "暂无歌手信息" : "打开 QQ 音乐并播放一首歌");
  $("status").textContent =
    state.playback === "Playing"
      ? "播放中"
      : state.connected
        ? "已暂停"
        : "未连接";
  $("toggle").textContent = state.playback === "Playing" ? "Ⅱ" : "▶";
  $("toggle").disabled = !state.connected;
  $("next").disabled = !state.connected || !state.canNext;
  $("previous").disabled = !state.connected || !state.canPrevious;
  $("volume").disabled = !state.volumeAvailable;
  $("mute").disabled = !state.volumeAvailable;
  if (!editing) {
    $("volume").value = Math.max(0, state.volume);
    $("level").textContent = state.volumeAvailable ? state.volume + "%" : "—";
  }
  $("mute").textContent = state.muted ? "取消静音" : "静音";
  $("mode").disabled = !state.connected;
  currentTrack = state;
  highlightCurrent();
  const guard =
    seekGuard &&
    seekGuard.title === state.title &&
    Date.now() < seekGuard.until;
  timelineState = guard
    ? {
        ...state,
        position:
          seekGuard.position +
          (state.playback === "Playing"
            ? (Date.now() - seekGuard.at) / 1000
            : 0),
        duration: seekGuard.duration,
        timelineSource: "estimated",
        receivedAt: Date.now(),
      }
    : { ...state, receivedAt: Date.now() };
  renderProgress();
  $("message").textContent = state.connected
    ? "音量仅作用于 QQ 音乐"
    : "请先打开 QQ 音乐并播放一首歌";
  $("message").classList.remove("error");
}
function command(action, value) {
  if (action === "status" && pending) return;
  if (pending >= 4) {
    display({ ok: false, error: "请稍候，正在完成音乐操作" });
    return;
  }
  pending++;
  const request = queue.then(async () => {
    try {
      display(await window.qqMusic.command(action, value));
      if (action !== "status") setTimeout(refresh, 650);
    } catch (error) {
      display({ ok: false, error: error.message });
    } finally {
      pending--;
    }
  });
  queue = request.catch(() => {});
  return request;
}
function refresh() {
  if (!pending && !editing) command("status");
}
for (const action of ["open", "previous", "toggle", "next", "mute"])
  $(action).addEventListener("click", () => command(action));
$("close").addEventListener("click", () => window.qqMusic.close());
$("lyrics-refresh").addEventListener("click", () => command("lyrics-status"));
$("lyrics").addEventListener("change", () => {
  const desired = $("lyrics").checked;
  $("lyrics").checked = !desired;
  command("set-lyrics", desired);
});
$("volume").addEventListener("input", () => {
  editing = true;
  $("level").textContent = $("volume").value + "%";
});
$("volume").addEventListener("change", () => {
  editing = false;
  command("set-volume", Number($("volume").value));
});
$("progress").addEventListener("input", () => {
  seeking = true;
  $("current-time").textContent = duration(Number($("progress").value));
});
$("progress").addEventListener("change", () => {
  const position = Number($("progress").value),
    at = Date.now();
  seeking = false;
  seekGuard = {
    position,
    duration: timelineState?.duration || 0,
    title: timelineState?.title,
    at,
    until: at + 2500,
  };
  if (timelineState)
    timelineState = {
      ...timelineState,
      position,
      receivedAt: at,
      timelineSource: "estimated",
    };
  renderProgress();
  seekWaiting = { position, at };
  void sendSeek();
});
$("progress").addEventListener("blur", () => {
  seeking = false;
  renderProgress();
});
$("progress").addEventListener("pointercancel", () => {
  seeking = false;
  renderProgress();
});
window.qqMusic.onResult(display);
for (const action of ["previous", "toggle", "next", "mute", "volume"])
  $(action).disabled = true;
let currentTrack = null,
  libraryTab = "queue",
  personalLists = [],
  playlistDetail = null,
  queueData = null,
  shownRows = 200,
  libraryBusy = false,
  currentMode = "",
  pendingLibraryView = null;
let playSending = false,
  playWaiting = null,
  playGeneration = 0,
  pendingTrack = null;
async function sendSeek() {
  if (seekSending) return;
  seekSending = true;
  try {
    while (seekWaiting) {
      const next = seekWaiting;
      seekWaiting = null;
      try {
        const result = await window.qqMusic.command("seek", next.position);
        if (!result.ok) throw Error(result.error);
        if (!seekWaiting && seekGuard?.at === next.at) display(result);
      } catch (error) {
        if (!seekWaiting) {
          seekGuard = null;
          display({ ok: false, error: error.message });
        }
      }
    }
  } finally {
    seekSending = false;
    setTimeout(refresh, 100);
  }
}
async function sendPlay() {
  if (playSending) return;
  playSending = true;
  try {
    while (playWaiting) {
      const next = playWaiting;
      playWaiting = null;
      try {
        const result = await window.qqMusic.command(next.action, next.value);
        if (!result.ok) throw Error(result.error);
        if (next.generation === playGeneration) {
          displayLibrary(result.library || {});
          if (next.action === "playlist-play") setTab("queue");
          setTimeout(refresh, 100);
          setTimeout(refresh, 500);
        }
      } catch (error) {
        if (next.generation === playGeneration) {
          pendingTrack = null;
          highlightCurrent();
          libraryMessage(error.message || "切歌失败，请重试", true);
        }
      }
    }
  } finally {
    playSending = false;
  }
}
function libraryMessage(text, error = false) {
  $("library-message").textContent = text;
  $("library-message").classList.toggle("error", error);
}
async function libraryCommand(action, value) {
  if (action === "queue-play" || action === "playlist-play") {
    const items =
      action === "queue-play" ? queueData?.items : playlistDetail?.items;
    pendingTrack = items?.[value?.index ?? 0] || null;
    highlightCurrent();
    libraryMessage("正在切换歌曲…");
    playWaiting = { action, value, generation: ++playGeneration };
    void sendPlay();
    return;
  }
  if (libraryBusy) {
    libraryMessage("正在读取列表，请稍候");
    return;
  }
  libraryBusy = true;
  const generation = playGeneration;
  $("library-refresh").disabled = true;
  libraryMessage(
    action.includes("play") &&
      action !== "playlist-tracks" &&
      action !== "library-list"
      ? "正在连接 QQ 音乐…"
      : "正在读取…",
  );
  try {
    const result = await window.qqMusic.command(action, value);
    if (!result.ok) throw Error(result.error);
    if (generation === playGeneration) displayLibrary(result.library || {});
  } catch (error) {
    libraryMessage(error.message || "读取失败，请稍后重试", true);
  } finally {
    libraryBusy = false;
    $("library-refresh").disabled = false;
    if (pendingLibraryView) {
      const next = pendingLibraryView;
      pendingLibraryView = null;
      openLibraryView(next);
    }
  }
}
function displayLibrary(data) {
  if (Object.hasOwn(data, "mode")) {
    currentMode = data.mode || "";
    $("mode").value = currentMode;
    $("mode").options[0].textContent = currentMode
      ? "读取当前模式…"
      : "暂未读到当前模式";
    libraryMessage(
      currentMode ? "播放模式已同步" : "请展开 QQ 音乐主窗口后刷新播放模式",
    );
  }
  if (data.playlists) {
    personalLists = data.playlists;
    libraryMessage("已读取 " + personalLists.length + " 个个人歌单");
  }
  if (data.playlist) {
    playlistDetail = data.playlist;
    shownRows = 200;
    libraryMessage(
      "已读取 " +
        playlistDetail.items.length +
        " 首歌曲" +
        (playlistDetail.excluded
          ? "，另有 " +
            playlistDetail.excluded +
            " 首特殊或失效曲目需在 QQ 音乐中查看"
          : ""),
    );
  }
  if (data.queue) {
    queueData = data.queue;
    libraryMessage(
      data.notice || queueData.notice || "队列已同步",
      data.playbackConfirmed === false,
    );
  }
  renderLibrary();
}
function setTab(tab) {
  libraryTab = tab === "playlists" ? "playlists" : "queue";
  playlistDetail = null;
  shownRows = 200;
  $("library-filter").value = "";
  renderLibrary();
}
function openLibraryView(view) {
  setTab(view);
  if (libraryBusy) {
    pendingLibraryView = libraryTab;
    return;
  }
  libraryCommand(libraryTab === "playlists" ? "library-list" : "queue-status");
}
function duration(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
function renderProgress() {
  if (!timelineState || seeking) return;
  const total = Math.max(0, Number(timelineState.duration) || 0);
  const position = Math.min(
    total,
    Math.max(
      0,
      (Number(timelineState.position) || 0) +
        (timelineState.playback === "Playing"
          ? (Date.now() - timelineState.receivedAt) / 1000
          : 0),
    ),
  );
  $("progress").max = String(Math.floor(total));
  $("progress").value = String(Math.floor(position));
  $("progress").disabled = !timelineState.canSeek || total <= 0;
  $("current-time").textContent =
    timelineState.timelineSource === "metadata" ? "—:—" : duration(position);
  $("total-time").textContent = duration(total);
  $("progress-note").hidden = ![
    "estimated",
    "unavailable",
    "metadata",
  ].includes(timelineState.timelineSource);
  $("progress-note").textContent =
    timelineState.timelineSource === "estimated"
      ? "进度估算中，展开 QQ 音乐可重新校准"
      : timelineState.timelineSource === "metadata"
        ? "可拖动跳转；展开 QQ 音乐可读取当前进度"
        : "请展开 QQ 音乐主窗口以读取进度";
}
function activeSong(item) {
  if (!currentTrack?.title) return false;
  return (
    currentTrack.title.trim() === item.title?.trim() &&
    (!item.artist ||
      !currentTrack.artist ||
      currentTrack.artist.includes(item.artist) ||
      item.artist.includes(currentTrack.artist))
  );
}
function highlightCurrent() {
  if (pendingTrack && activeSong(pendingTrack)) pendingTrack = null;
  for (const row of $("library-rows").querySelectorAll("[data-track]")) {
    const items =
      libraryTab === "queue" ? queueData?.items : playlistDetail?.items;
    const item = items?.[Number(row.dataset.track)];
    row.classList.toggle("current", !!item && activeSong(item));
    row.classList.toggle("switching", !!item && pendingTrack?.id === item.id);
  }
}
function renderLibrary() {
  $("tab-queue").classList.toggle("active", libraryTab === "queue");
  $("tab-playlists").classList.toggle("active", libraryTab === "playlists");
  const showingLists = libraryTab === "playlists" && !playlistDetail;
  $("queue-notice").hidden = libraryTab !== "queue";
  $("queue-notice").textContent =
    queueData?.source === "qqmusic-native"
      ? !queueData.fresh
        ? "队列窗口已隐藏，内容可能过期；请在 QQ 音乐展开队列后刷新。"
        : queueData.complete
          ? "已读取 QQ 音乐实际队列；未匹配到编号的歌曲仅支持查看。"
          : "仅显示 QQ 音乐当前开放读取的曲目，完整数量见右侧。"
      : "显示从桌宠发送的完整列表；QQ 音乐内的临时改动需展开原生队列后刷新。";
  const source = showingLists
    ? personalLists
    : (libraryTab === "queue" ? queueData?.items : playlistDetail?.items) || [];
  $("library-title").textContent = showingLists
    ? "我的歌单"
    : libraryTab === "queue"
      ? queueData?.name || "播放队列"
      : playlistDetail?.name || "歌单";
  $("library-count").textContent =
    (libraryTab === "queue" &&
    queueData?.source === "qqmusic-native" &&
    !queueData.complete
      ? source.length + " / " + queueData.total
      : source.length) + (showingLists ? " 个" : " 首");
  $("library-back").hidden = !playlistDetail || libraryTab !== "playlists";
  $("playlist-play").hidden =
    !playlistDetail || libraryTab !== "playlists" || !source.length;
  const query = $("library-filter").value.trim().toLocaleLowerCase();
  const filtered = source
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      [item.name, item.title, item.artist]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query),
    );
  const fragment = document.createDocumentFragment();
  for (const { item, index } of filtered.slice(0, shownRows)) {
    const row = document.createElement("button");
    row.className = "library-row";
    row.setAttribute("role", "listitem");
    row.title = showingLists
      ? item.name
      : [item.title, item.artist].filter(Boolean).join(" — ");
    const number = document.createElement("span");
    number.className = "row-number";
    number.textContent =
      showingLists ||
      (libraryTab === "queue" &&
        queueData?.source === "qqmusic-native" &&
        !queueData.complete)
        ? "♫"
        : String(index + 1);
    const text = document.createElement("span");
    text.className = "row-text";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = showingLists ? item.name : item.title;
    const subtitle = document.createElement("span");
    subtitle.className = "row-subtitle";
    subtitle.textContent = showingLists
      ? item.count + " 首 · " + (item.kind === "liked" ? "我喜欢" : "我的歌单")
      : item.artist;
    text.append(title, subtitle);
    row.append(number, text);
    if (!showingLists) {
      row.dataset.track = String(index);
      row.classList.toggle("current", activeSong(item));
      row.disabled = item.readOnly === true;
      const time = document.createElement("span");
      time.className = "row-time";
      time.textContent = Number.isFinite(item.seconds)
        ? duration(item.seconds)
        : "—";
      row.append(time);
    }
    row.addEventListener("click", () =>
      showingLists
        ? libraryCommand("playlist-tracks", item.id)
        : libraryTab === "queue"
          ? libraryCommand("queue-play", {
              revision: queueData.revision,
              index,
            })
          : libraryCommand("playlist-play", { id: playlistDetail.id, index }),
    );
    fragment.append(row);
  }
  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = query
      ? "没有找到匹配项目"
      : showingLists
        ? "点“刷新”读取个人歌单"
        : queueData?.source === "qqmusic-native"
          ? "QQ 音乐播放队列为空"
          : "在 QQ 音乐手动展开一次播放队列，再刷新";
    fragment.append(empty);
  }
  $("library-rows").replaceChildren(fragment);
  $("library-more").hidden = filtered.length <= shownRows;
}
$("tab-queue").addEventListener("click", () => openLibraryView("queue"));
$("tab-playlists").addEventListener("click", () =>
  openLibraryView("playlists"),
);
$("library-refresh").addEventListener("click", () =>
  libraryCommand(
    libraryTab === "queue"
      ? "queue-status"
      : playlistDetail
        ? "playlist-tracks"
        : "library-list",
    playlistDetail ? { id: playlistDetail.id, refresh: true } : true,
  ),
);
$("library-back").addEventListener("click", () => {
  playlistDetail = null;
  shownRows = 200;
  $("library-filter").value = "";
  renderLibrary();
});
$("library-filter").addEventListener("input", () => {
  shownRows = 200;
  renderLibrary();
});
$("library-more").addEventListener("click", () => {
  shownRows += 200;
  renderLibrary();
});
$("playlist-play").addEventListener("click", () =>
  libraryCommand("playlist-play", { id: playlistDetail.id, index: 0 }),
);
$("mode-refresh").addEventListener("click", () =>
  libraryCommand("mode-status"),
);
$("mode").addEventListener("change", () => {
  const desired = $("mode").value;
  $("mode").value = currentMode;
  libraryCommand("set-mode", desired);
});
window.qqMusic.onView(openLibraryView);
renderLibrary();
refresh();
command("lyrics-status");
libraryCommand("queue-status");
setTimeout(() => libraryCommand("mode-status"), 1500);
setInterval(refresh, 700);
setInterval(renderProgress, 100);
setInterval(() => {
  if (
    libraryTab === "queue" &&
    !libraryBusy &&
    !pending &&
    !playSending &&
    !seekSending
  )
    libraryCommand("queue-status");
}, 6000);

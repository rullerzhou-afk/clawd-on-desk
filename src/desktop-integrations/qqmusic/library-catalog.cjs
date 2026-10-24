"use strict";
const ID = /^[1-9][0-9]{0,18}$/;
function identifier(value) {
  const id = String(value ?? "");
  if (!ID.test(id)) throw Error("无效的歌单或歌曲编号");
  return id;
}
function result(response) {
  if (
    response?.code !== 0 ||
    response?.req_0?.code !== 0 ||
    !response.req_0.data
  )
    throw Error("QQ 音乐暂时无法读取这个歌单，请稍后刷新");
  return response.req_0.data;
}
function song(raw) {
  const id = identifier(raw.id ?? raw.songid);
  return {
    id,
    mid: String(raw.mid ?? raw.songmid ?? ""),
    title: String(raw.title ?? raw.name ?? raw.songname ?? ""),
    artist: (Array.isArray(raw.singer) ? raw.singer : [])
      .map((v) => String(v.title ?? v.name ?? ""))
      .filter(Boolean)
      .join(" / "),
    album: String(raw.album?.title ?? raw.album?.name ?? ""),
    seconds: Number(raw.interval) || 0,
    type: Number(raw.type ?? raw.songtype ?? 0),
  };
}
class LibraryCatalog {
  constructor({ request, account }) {
    this.request = request;
    this.account = identifier(account);
    this.lists = null;
    this.tracks = new Map();
    this.inflight = new Map();
  }
  async call(module, method, param) {
    return result(
      await this.request({
        comm: { ct: 24, cv: 0, format: "json" },
        req_0: { module, method, param },
      }),
    );
  }
  async playlists(refresh = false) {
    if (!refresh && this.lists && Date.now() - this.lists.time < 60000)
      return this.lists.items;
    const items = [],
      seen = new Set();
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const data = await this.call(
        "music.musicasset.PlaylistBaseRead",
        "GetPlaylistByUin",
        { uin: this.account, offset, size: 50 },
      );
      if (!Array.isArray(data.v_playlist))
        throw Error("QQ 音乐没有返回可读取的个人歌单");
      let added = 0;
      for (const p of data.v_playlist) {
        if (p.invalid || !ID.test(String(p.tid)) || seen.has(String(p.tid)))
          continue;
        seen.add(String(p.tid));
        added++;
        items.push({
          id: String(p.tid),
          name: String(p.dirName || "未命名歌单"),
          count: Number(p.songNum) || 0,
          kind: Number(p.dirId) === 201 ? "liked" : "created",
        });
      }
      offset += data.v_playlist.length;
      if (
        data.bFinish ||
        offset >= Number(data.total) ||
        data.v_playlist.length === 0
      )
        break;
      if (!added) throw Error("个人歌单分页重复，请重新刷新");
      if (page === 19) throw Error("歌单数量超出当前读取范围");
    }
    this.lists = { time: Date.now(), items };
    return items;
  }
  async playlist(id, refresh = false) {
    id = identifier(id);
    const cached = this.tracks.get(id);
    if (!refresh && cached && Date.now() - cached.time < 120000)
      return cached.value;
    if (this.inflight.has(id)) return this.inflight.get(id);
    const task = this.load(id);
    this.inflight.set(id, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(id);
    }
  }
  async load(id) {
    const lists = await this.playlists();
    const list = lists.find((p) => p.id === id);
    if (!list) throw Error("请选择“我的歌单”中已读取的歌单");
    const items = [],
      excluded = [];
    let offset = 0,
      total = null,
      name = list.name;
    const pageSignatures = new Set();
    for (let page = 0; page < 100; page++) {
      const data = await this.call(
        "music.srfDissInfo.aiDissInfo",
        "uniform_get_Dissinfo",
        {
          disstid: Number(id),
          dirid: 0,
          song_begin: offset,
          song_num: 200,
          userinfo: 1,
          tag: 1,
          orderlist: 1,
        },
      );
      if (data.code !== undefined && data.code !== 0)
        throw Error("这个歌单需要在 QQ 音乐中完成登录验证");
      if (!Array.isArray(data.songlist))
        throw Error("歌单歌曲暂时无法读取，请在 QQ 音乐中确认歌单可访问");
      // QQ subtracts only THIS PAGE's filtered tracks from total_song_num.
      // They still occupy positions in song_begin, even though songlist omits them.
      const hidden = [
        ...(Array.isArray(data.filtered_song) ? data.filtered_song : []),
        ...(Array.isArray(data.invalid_song) ? data.invalid_song : []),
      ];
      const count =
        Number(
          data.total_song_num ?? data.dirinfo?.songnum ?? data.songlist.length,
        ) + hidden.length;
      if (!Number.isSafeInteger(count) || count < 0 || count > 15000)
        throw Error("歌单歌曲数量异常");
      if (total !== null && total !== count)
        throw Error("歌单正在变化，请刷新后重新读取");
      total = count;
      name = String(data.dirinfo?.title || name);
      const signature = data.songlist
        .map((s) => String(s.id ?? s.songid))
        .join(",");
      if (signature && pageSignatures.has(signature))
        throw Error("歌单歌曲分页重复，未显示不完整列表");
      pageSignatures.add(signature);
      for (const raw of data.songlist) items.push(song(raw));
      excluded.push(
        ...hidden.map((raw) => ({
          id: identifier(raw.songid ?? raw.id),
          type: Number(raw.songtype ?? raw.type ?? 0),
        })),
      );
      offset += data.songlist.length + hidden.length;
      if (offset >= total) break;
      if (
        data.hasmore === 0 ||
        data.songlist.length + hidden.length === 0 ||
        page === 99
      )
        throw Error("歌单尚未完整读取，请稍后重试");
    }
    if (items.length + excluded.length !== total)
      throw Error("歌单歌曲数量不一致，请重新刷新");
    const value = { id, name, total, items, excluded: excluded.length };
    this.tracks.set(id, { time: Date.now(), value });
    return value;
  }
}
module.exports = { LibraryCatalog, identifier, song };

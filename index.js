// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from sogud/mygo-cloudmusic (originally egoist/mygo-cloudmusic).
// See THIRD_PARTY_NOTICES.md for the source revision and scope of the port.
// MyGo Music supplies host and fetch; this module has no Node dependencies.

const SITE = "https://music.163.com";
const EAPI = "https://interfacepc.music.163.com";
// Protocol key shared by the upstream client, not a user's credential.
const EAPI_KEY = "e82ckenh8dichen8";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const EAPI_UA = "NeteaseMusic 9.0.90/5038 (iPhone; iOS 16.2; zh_CN)";
const PAGE_SIZE = 30;
const PLAYLIST_LIMIT = 1000;
const PRIVATE_RADAR = "3136952023";
const COOKIE_NAMES = ["MUSIC_U", "__csrf", "NMTID"];

// MyGo 0.1.6 loads a module while holding the storage mutex. Host calls must
// happen inside an exported action, never during module initialization.
let session = null;
let epoch = 0;
let profileCheckedAt = 0;
let likedCache = null;
const pendingStreams = new Map();
let discoveryCovers = null;

function currentSession() {
  if (!session) session = host.storage.get("session") || { cookies: {}, profile: null };
  return session;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function idOf(value) {
  const id = String(value);
  if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) {
    throw new Error("无效的网易云音乐 ID");
  }
  return id;
}

function pageOffset(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function secureURL(value) {
  return typeof value === "string" ? value.replace(/^http:\/\//, "https://") : "";
}

function deviceID() {
  let id = host.storage.get("deviceId");
  if (!id) {
    // This is an install identifier, never a credential or encryption key.
    id = Array.from({ length: 52 }, () => Math.floor(Math.random() * 16).toString(16)).join("").toUpperCase();
    host.storage.set("deviceId", id);
  }
  return id;
}

function cookieHeader(cookies) {
  return COOKIE_NAMES.filter((key) => cookies[key]).map((key) => `${key}=${cookies[key]}`).join("; ");
}

function acceptCookies(response, cookies) {
  // moejs supplies getSetCookie(): do not split a combined header on commas,
  // because an Expires attribute itself contains a comma.
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    if (separator < 1 || !COOKIE_NAMES.includes(name)) continue;
    const value = pair.slice(separator + 1);
    const maxAge = /;\s*max-age\s*=\s*(-?\d+)/i.exec(line);
    const expires = /;\s*expires\s*=\s*([^;]+)/i.exec(line);
    const expired = maxAge ? Number(maxAge[1]) <= 0 : expires && Date.parse(expires[1]) <= Date.now();
    if (!value || expired) delete cookies[name];
    else cookies[name] = value;
  }
}

function persistSession() {
  if (session.cookies.MUSIC_U) host.storage.set("session", session);
  else host.storage.remove("session");
}

function clearSession() {
  epoch++;
  session = { cookies: {}, profile: null };
  profileCheckedAt = 0;
  likedCache = null;
  pendingStreams.clear();
  host.storage.remove("session");
}

async function request(path, params = {}, options = {}) {
  const activeSession = options.session || currentSession();
  const startedEpoch = epoch;
  let url;
  const headers = { "User-Agent": UA, Referer: `${SITE}/` };
  const init = { headers, redirect: "error" };
  if (options.eapi) {
    const now = Date.now();
    const header = {
      osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: deviceID(), os: "pc", appver: "3.1.17.204416",
      versioncode: "140", mobilename: "", buildver: String(Math.floor(now / 1000)),
      resolution: "1920x1080", channel: "netease",
      requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
      __csrf: "", ...activeSession.cookies,
    };
    const text = JSON.stringify({ ...params, header, e_r: false });
    const digest = host.crypto.md5(`nobody${path}use${text}md5forencrypt`);
    const encrypted = host.crypto.aesEcbEncrypt(EAPI_KEY, `${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`);
    url = EAPI + path.replace(/^\/api\//, "/eapi/");
    init.method = "POST";
    init.body = `params=${encrypted.toUpperCase()}`;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["User-Agent"] = EAPI_UA;
    headers.Cookie = Object.keys(header).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(header[key])}`).join("; ");
  } else {
    url = SITE + path;
    if (options.form) {
      // NetEase's web endpoints take these as a form POST with the session
      // cookie, not as a query string.
      init.method = "POST";
      init.body = options.form;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      const query = new URLSearchParams(params).toString();
      if (query) url += `?${query}`;
    }
    const cookie = cookieHeader(activeSession.cookies);
    if (cookie) headers.Cookie = cookie;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  init.signal = controller.signal;
  let response, body;
  try {
    response = await fetch(url, init);
    if (!response.ok) throw new Error(`网易云请求失败（HTTP ${response.status}）`);
    body = await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("网易云请求超时，请稍后重试");
    // Never put response bodies, request headers or login cookies in errors.
    if (response && !response.ok) throw error;
    throw new Error("无法读取网易云音乐，请检查网络及系统代理后重试");
  } finally {
    clearTimeout(timer);
  }
  if (startedEpoch !== epoch) throw new Error("账号状态已改变，请重试");
  if (!body || typeof body !== "object") throw new Error("网易云返回了无效数据");
  const code = Number(body.code);
  const allowed = options.codes || [200];
  if (!allowed.includes(code)) {
    if ([301, 302, 401].includes(code) && !options.keepSession) {
      if (activeSession === session) clearSession();
      throw fail("signIn", "请重新登录网易云音乐");
    }
    if (code === 460 || code === -460) {
      const error = new Error(`网易云暂时拒绝了请求（${code}），请稍后重试`);
      error.neteaseCode = code;
      throw error;
    }
    if (code === 405) throw new Error("网易云暂时限制了请求，请稍后再试");
    // Keep what NetEase said: for playlist edits it explains a refusal better
    // than the number alone.
    const said = typeof body.message === "string" && body.message ? `：${body.message}` : "";
    throw new Error(`网易云接口返回错误（${Number.isFinite(code) ? code : "未知"}）${said}`);
  }
  const wasSignedIn = !!activeSession.cookies.MUSIC_U;
  acceptCookies(response, activeSession.cookies);
  if (activeSession === session) {
    if (wasSignedIn && !activeSession.cookies.MUSIC_U) {
      clearSession();
      throw fail("signIn", "网易云登录状态已失效，请重新登录");
    }
    persistSession();
  }
  return body;
}

const eapi = (path, params, options = {}) => request(path, params, { ...options, eapi: true });

function toArtist(artist = {}) {
  return { id: String(artist.id || ""), name: artist.name || "", imageUrl: secureURL(artist.img1v1Url || artist.picUrl) };
}

function toAlbum(album = {}) {
  const date = Number(album.publishTime);
  return {
    id: String(album.id || ""), name: album.name || "", imageUrl: secureURL(album.picUrl),
    artists: (album.artists || (album.artist ? [album.artist] : [])).map(toArtist),
    released: date > 0 ? new Date(date).toISOString().slice(0, 10) : "",
  };
}

function toTrack(track) {
  const privilege = track.privilege;
  return {
    id: String(track.id), name: track.name || "",
    artists: (track.ar || track.artists || []).map(toArtist),
    album: toAlbum(track.al || track.album), duration: track.dt || track.duration || 0,
    url: `${SITE}/song?id=${track.id}`,
    unavailable: privilege ? privilege.st < 0 || privilege.pl <= 0 : track.fee === 1 || track.fee === 4,
  };
}

function toPlaylist(playlist) {
  return {
    id: String(playlist.id), name: playlist.name || "",
    imageUrl: secureURL(playlist.coverImgUrl || playlist.picUrl),
    description: playlist.description || "", owner: playlist.creator?.nickname || "",
    trackCount: playlist.trackCount || 0, saved: !!playlist.subscribed,
    mine: !!session?.profile && String(playlist.creator?.userId) === session.profile.id,
  };
}

async function songDetails(ids, originals = []) {
  if (!ids.length) return [];
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    batches.push(ids.slice(offset, offset + 400));
  }
  const results = await Promise.all(batches.map(async (batch) => {
    const data = await eapi("/api/v3/song/detail", { c: JSON.stringify(batch.map((id) => ({ id: Number(idOf(id)) }))) });
    const privileges = new Map((data.privileges || []).map((p) => [String(p.id), p]));
    return (data.songs || []).map((song) => ({ ...song, privilege: privileges.get(String(song.id)) || song.privilege }));
  }));
  const byID = new Map(results.flat().map((song) => [String(song.id), song]));
  const fallback = new Map(originals.map((song) => [String(song.id), song]));
  // MyGo advances offset by the number of returned tracks. Keep a slot for
  // every requested ID, including songs removed from the detail response.
  return ids.map((id) => byID.get(String(id)) || {
    ...(fallback.get(String(id)) || { id, name: "歌曲暂不可用" }),
    privilege: { st: -1, pl: 0 },
  });
}

async function profileFor(activeSession) {
  const data = await request("/api/nuser/account/get", {}, { session: activeSession });
  const profile = activeSession.cookies.MUSIC_U ? data.profile : null;
  return profile ? { id: String(profile.userId), name: profile.nickname, imageUrl: secureURL(profile.avatarUrl) } : null;
}

export async function account() {
  currentSession();
  if (!session.cookies.MUSIC_U) return null;
  if (session.profile && Date.now() - profileCheckedAt < 60000) return session.profile;
  try {
    const profile = await profileFor(session);
    if (!profile) { clearSession(); return null; }
    session.profile = profile;
    profileCheckedAt = Date.now();
    persistSession();
    return profile;
  } catch (error) {
    if (error.code === "signIn") return null;
    throw error;
  }
}

async function requireAccount() {
  const profile = await account();
  if (!profile) throw fail("signIn", "请先扫码登录网易云音乐");
  return profile;
}

export async function signIn() {
  const startedEpoch = ++epoch;
  const pending = { cookies: {}, profile: null };
  host.signInPrompt({ text: "正在生成网易云音乐登录二维码…" });
  const key = await eapi("/api/login/qrcode/unikey", { type: 3 }, { session: pending });
  if (!key.unikey) throw new Error("网易云未返回登录二维码，请稍后重试");
  const qr = `${SITE}/login?codekey=${encodeURIComponent(key.unikey)}`;
  host.signInPrompt({ qr, text: "请用网易云音乐手机 App 扫码，并在手机上确认登录" });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline && startedEpoch === epoch) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (startedEpoch !== epoch) break;
    const result = await eapi("/api/login/qrcode/client/login", { key: key.unikey, type: 3 }, {
      session: pending, codes: [800, 801, 802, 803],
    });
    if (result.code === 800) throw new Error("二维码已过期，请重新点击登录");
    if (result.code === 802) host.signInPrompt({ qr, text: "已扫码，请在手机上确认登录" });
    if (result.code === 803) {
      if (!pending.cookies.MUSIC_U) throw new Error("网易云未返回有效会话，请重新扫码登录");
      pending.profile = await profileFor(pending);
      if (!pending.profile) throw new Error("无法读取已登录账号，请重新扫码");
      if (startedEpoch !== epoch) break;
      session = pending;
      profileCheckedAt = Date.now();
      likedCache = null;
      persistSession();
      host.signInPrompt({ text: "登录成功" });
      return pending.profile;
    }
  }
  throw new Error("登录已取消或超时，请重新点击登录");
}

export function signOut() {
  // Forget this plugin's session. Do not affect other NetEase clients.
  clearSession();
}

export async function search({ query, kind = "tracks", offset = 0 }) {
  const types = {
    tracks: [1, "songs", "songCount", toTrack], albums: [10, "albums", "albumCount", toAlbum],
    artists: [100, "artists", "artistCount", toArtist], playlists: [1000, "playlists", "playlistCount", toPlaylist],
  };
  const type = types[kind];
  if (!type) throw fail("unsupported", "首版支持歌曲、专辑、歌手和歌单搜索");
  const text = String(query || "").trim();
  if (!text) return { [kind]: [], more: false };
  offset = pageOffset(offset);
  const data = await request("/api/cloudsearch/pc", { s: text, type: type[0], limit: PAGE_SIZE, offset, total: "true" });
  const result = data.result || {};
  const items = result[type[1]] || [];
  const records = kind === "tracks" ? await songDetails(items.map((song) => song.id), items) : items;
  return { [kind]: records.map(type[3]), more: items.length > 0 && offset + items.length < (result[type[2]] || 0) };
}

async function discoveryPlaylists() {
  const data = await request("/api/personalized/playlist", { limit: 24 });
  const playlists = (data.result || []).map(toPlaylist);
  // Decorative artwork for navigation, not a preview of private recommendations.
  discoveryCovers = playlists.map(item => item.imageUrl).filter(Boolean);
  return playlists;
}

function discoveryCover(index) {
  return discoveryCovers?.length ? discoveryCovers[index % discoveryCovers.length] : "";
}

export async function home() {
  const playlists = await discoveryPlaylists();
  return {
    title: "发现音乐", subtitle: "网易云音乐 · 登录后可读取你的歌单和喜欢的音乐",
    sections: [
      { title: "为你推荐", links: [
        { title: "每日推荐", subtitle: "登录后查看今天的推荐歌曲", page: "daily", imageUrl: discoveryCover(0) },
        { title: "私人雷达", subtitle: "发现属于你的音乐", page: "radar", imageUrl: discoveryCover(1) },
        { title: "个性化歌单", subtitle: "网易云为你推荐的歌单", page: "recommendations", imageUrl: discoveryCover(2) },
      ] },
      { title: "私人漫游", stations: stationList() },
      { title: "推荐歌单", playlists },
    ],
  };
}

export async function browse({ page }) {
  if (page === "radar") {
    // NetEase's dynamic playlist is selected for the signed-in listener.
    // Never label its anonymous response as someone's personal radar.
    await requireAccount();
    const radar = await playlist({ id: PRIVATE_RADAR });
    return { title: "私人雷达", subtitle: radar.name, sections: [{ tracks: radar.tracks }] };
  }
  if (page === "daily") {
    await requireAccount();
    const data = await request("/api/v3/discovery/recommend/songs");
    const songs = data.data?.dailySongs || [];
    return { title: "每日推荐", sections: [{ tracks: (await songDetails(songs.map(song => song.id), songs)).map(toTrack) }] };
  }
  if (page === "recommendations") {
    await requireAccount();
    const data = await request("/api/v1/discovery/recommend/resource");
    return { title: "个性化歌单", sections: [{ playlists: (data.recommend || []).map(toPlaylist) }] };
  }
  if (page !== "charts") throw fail("unsupported", "没有这个页面");
  const data = await request("/api/toplist/detail");
  return { title: "排行榜", sections: [{ playlists: (data.list || []).map(toPlaylist) }] };
}

export async function playlists() {
  const profile = await account();
  if (!profile) return [];
  // Return all pages instead of silently dropping subscriptions after 200.
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const data = await request("/api/user/playlist", { uid: profile.id, limit: 200, offset });
    const items = data.playlist || [];
    result.push(...items.map(toPlaylist));
    if (!data.more || items.length < 200) return result;
    if (offset >= 1800) throw new Error("账号歌单超过首版支持的 2000 个，暂时无法完整加载");
  }
}

export async function playlist({ id }) {
  const data = await request("/api/v6/playlist/detail", { id: idOf(id), n: PLAYLIST_LIMIT });
  if (!data.playlist) throw fail("unavailable", "歌单不存在或当前账号无权访问");
  const source = data.playlist;
  const ids = (source.trackIds || source.tracks || []).slice(0, PLAYLIST_LIMIT).map((track) => track.id);
  const result = toPlaylist(source);
  result.tracks = (await songDetails(ids, source.tracks || [])).map(toTrack);
  if (source.trackCount > PLAYLIST_LIMIT) {
    result.description += `\n本版本载入前 ${PLAYLIST_LIMIT} 首（歌单共 ${source.trackCount} 首）。`;
  }
  return result;
}

export async function album({ id }) {
  const data = await request(`/api/v1/album/${idOf(id)}`);
  if (!data.album) throw fail("unavailable", "专辑不可用");
  return { album: toAlbum(data.album), tracks: (await songDetails((data.songs || []).map((song) => song.id), data.songs || [])).map(toTrack) };
}

export async function artist({ id }) {
  id = idOf(id);
  const [detail, albums] = await Promise.all([
    request(`/api/v1/artist/${id}`), request(`/api/artist/albums/${id}`, { limit: 30, offset: 0 }),
  ]);
  if (!detail.artist) throw fail("unavailable", "歌手不可用");
  return {
    artist: toArtist(detail.artist), albums: (albums.hotAlbums || []).map(toAlbum),
    tracks: (await songDetails((detail.hotSongs || []).map((song) => song.id), detail.hotSongs || [])).map(toTrack),
  };
}

async function likedIDs() {
  const profile = await requireAccount();
  if (likedCache && likedCache.uid === profile.id && Date.now() - likedCache.at < 60000) return likedCache.ids;
  const data = await eapi("/api/song/like/get", { uid: profile.id });
  const ids = (data.ids || []).map(String);
  likedCache = { uid: profile.id, ids, at: Date.now() };
  return ids;
}

export async function liked({ offset = 0 }) {
  offset = pageOffset(offset);
  const ids = await likedIDs();
  return { tracks: (await songDetails(ids.slice(offset, offset + PAGE_SIZE))).map(toTrack), more: offset + PAGE_SIZE < ids.length };
}

export async function isLiked({ ids }) {
  currentSession();
  if (!session.cookies.MUSIC_U) return Object.fromEntries(ids.map((id) => [id, false]));
  const liked = new Set(await likedIDs());
  return Object.fromEntries(ids.map((id) => [id, liked.has(String(id))]));
}

export async function like({ id, on }) {
  await requireAccount();
  await eapi("/api/radio/like", { alg: "itembased", trackId: idOf(id), like: String(!!on), time: "3" });
  likedCache = null;
}

// Adding and taking songs out of a playlist the listener owns.
async function submitTracks(op, pid, ids, activeSession) {
  const form = new URLSearchParams({ op, pid, imme: "true", trackIds: JSON.stringify(ids.map(Number)) });
  if (activeSession.cookies.__csrf) form.set("csrf_token", activeSession.cookies.__csrf);
  try {
    // A refused edit is not a sign-out: keepSession stops a 401 body code from
    // clearing the listener's session.
    return await request("/api/playlist/manipulate/tracks", {}, {
      form: form.toString(), keepSession: true, codes: [200, 502],
    });
  } catch (error) {
    throw new Error(`${op === "add" ? "添加到歌单" : "移出歌单"}失败：${error.message}`);
  }
}

async function playlistTrackIDs(pid) {
  const data = await request("/api/v6/playlist/detail", { id: pid, n: PLAYLIST_LIMIT });
  return ((data.playlist && data.playlist.trackIds) || []).map((track) => String(track.id));
}

// NetEase answers a repeat add with 502 and adds nothing, even when the batch
// also holds songs the playlist is missing. Send what is missing instead, and
// say so plainly when nothing was.
async function manipulateTracks(op, id, trackIds) {
  const activeSession = currentSession();
  if (!activeSession.cookies.MUSIC_U) throw fail("signIn", "请先扫码登录网易云音乐");
  const pid = idOf(id);
  const ids = [...new Set((trackIds || []).map((trackId) => idOf(trackId)))];
  if (!ids.length) return;
  let data = await submitTracks(op, pid, ids, activeSession);
  if (op === "add" && Number(data.code) === 502) {
    const present = new Set(await playlistTrackIDs(pid));
    const missing = ids.filter((trackId) => !present.has(trackId));
    if (!missing.length) {
      throw fail("duplicate", ids.length > 1 ? "这些歌曲已经在这个歌单里了" : "这首歌已经在这个歌单里了");
    }
    data = await submitTracks(op, pid, missing, activeSession);
    if (Number(data.code) === 502) throw fail("duplicate", "这些歌曲已经在这个歌单里了");
  }
  if (Number(data.code) !== 200) {
    const said = typeof data.message === "string" && data.message ? `：${data.message}` : "";
    throw new Error(`${op === "add" ? "添加到歌单" : "移出歌单"}失败${said}`);
  }
}

export async function addToPlaylist({ id, trackIds }) {
  await manipulateTracks("add", id, trackIds);
}

export async function removeFromPlaylist({ id, trackIds }) {
  await manipulateTracks("del", id, trackIds);
}

export async function lyrics({ id }) {
  const data = await request("/api/song/lyric", { id: idOf(id), lv: 1, tv: -1 });
  return { lrc: data.lrc?.lyric || "", translation: data.tlyric?.lyric || "" };
}

export async function stream({ id, quality = "high" }) {
  id = idOf(id);
  const generation = epoch;
  const key = `${generation}:${id}:${quality}`;
  if (pendingStreams.has(key)) return pendingStreams.get(key);
  const pending = loadStream(id, quality, generation);
  pendingStreams.set(key, pending);
  try { return await pending; }
  finally { if (pendingStreams.get(key) === pending) pendingStreams.delete(key); }
}

async function loadStream(id, quality, generation) {
  const level = { standard: "standard", high: "exhigh", lossless: "lossless" }[quality] || "exhigh";
  let data;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (generation !== epoch) throw new Error("账号状态已改变，请重试");
    try {
      data = await eapi("/api/song/enhance/player/url/v1", {
        ids: JSON.stringify([Number(id)]), level, encodeType: level === "lossless" ? "flac" : "mp3",
      });
      break;
    } catch (error) {
      if (![460, -460].includes(error.neteaseCode)) throw error;
      if (attempt === 1) throw new Error(`网易云仍拒绝播放请求（${error.neteaseCode}），请稍后再试，并在官方客户端确认该歌曲可正常播放`);
      // One delayed retry of this read only, with the same device/account and
      // quality. Never retry account mutations or turn permission failures
      // into a different source, a preview, or a lower-quality success.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  const audio = (data.data || []).find((item) => String(item.id) === id);
  if (!audio || !audio.url || (audio.code !== undefined && audio.code !== 200) || audio.freeTrialInfo != null) {
    throw fail("unavailable", "当前账号无完整播放权限，或歌曲在当前地区不可用");
  }
  const url = new URL(secureURL(audio.url));
  if (url.protocol !== "https:" || !/^(?:[a-z0-9-]+\.)*music\.126\.net$/i.test(url.hostname)) {
    throw fail("unavailable", "网易云返回了不支持的音频地址");
  }
  const type = String(audio.type || "mp3").toLowerCase();
  if (!["mp3", "flac", "ogg"].includes(type)) throw fail("unavailable", "该歌曲的音频格式暂不支持");
  return {
    url: url.toString(), type, size: audio.size || 0, bitRate: audio.br || 0,
    quality: ["lossless", "hires"].includes(audio.level) ? "lossless" : audio.level === "standard" ? "standard" : "high",
    gain: audio.gain || 0, peak: audio.peak || 0,
    headers: { "User-Agent": UA, Referer: `${SITE}/` },
  };
}

// The host asks stationNext again as the queue runs out. These modes are
// NetEase's own recommendations, not a shuffle of the current local list.
function stationList() {
  return [
    { id: "DEFAULT", name: "私人漫游", description: "随心听，持续推荐你可能喜欢的歌曲" },
    { id: "FAMILIAR", name: "熟悉的歌", description: "回到熟悉的旋律" },
    { id: "EXPLORE", name: "新发现", description: "探索还没听过的音乐" },
  ].map((station, index) => ({ ...station, imageUrl: discoveryCover(index + 3) }));
}

export async function stations() {
  if (discoveryCovers === null) await discoveryPlaylists();
  return stationList();
}

export async function stationNext({ id }) {
  if (!["DEFAULT", "FAMILIAR", "EXPLORE"].includes(id)) throw fail("unsupported", "没有这个漫游模式");
  await requireAccount();
  const data = await eapi("/api/v1/radio/get", { mode: id, limit: 3 });
  const songs = data.data || [];
  return (await songDetails(songs.map(song => song.id), songs)).map(toTrack);
}

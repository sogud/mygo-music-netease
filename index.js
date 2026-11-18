// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from sogud/mygo-cloudmusic (originally egoist/mygo-cloudmusic).
// See THIRD_PARTY_NOTICES.md for the source revision and scope of the port.
// MyGo Music supplies host and fetch; this module has no Node dependencies.

const SITE = "https://music.163.com";
const EAPI = "https://interfacepc.music.163.com";
// Protocol key shared by the upstream client, not a user's credential.
const EAPI_KEY = "e82ckenh8dichen8";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
// Keep the HTTP User-Agent paired with the Windows desktop EAPI header and
// interfacepc host to avoid NetEase -460 risk-control rejections on playback.
const EAPI_CLIENT = {
  osver: "Microsoft-Windows-10-Professional-build-19045-64bit",
  os: "pc",
  appver: "3.1.17.204416",
  versioncode: "140",
  resolution: "1920x1080",
  channel: "netease",
};
const EAPI_UA = `Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/${EAPI_CLIENT.appver}`;
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
let likedRevision = 0;
const pendingStreams = new Map();
let discoveryCovers = null;
let heartState = null;
let pendingHeart = null;
let commentSnapshot = null;

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

// MyGo Music 0.1.20+ replaces {size} (including URL-encoded braces) with the
// pixels needed by each view. Ask NetEase's image CDN to resize before the
// download, instead of fetching and decoding an original for a small row.
function artworkURL(value) {
  const picture = secureURL(value);
  if (!picture) return "";
  try {
    const url = new URL(picture);
    if (url.protocol !== "https:" || !/^p\d+\.music\.126\.net$/.test(url.hostname) ||
        url.port || url.username || url.password) return picture;
    // Set just the resize parameter, preserving other query values and the
    // fragment. Audio and external image services keep their original URLs.
    url.searchParams.set("param", "{size}y{size}");
    return url.toString();
  } catch {
    return picture;
  }
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
  heartState = null;
  pendingHeart = null;
  host.storage.remove("session");
}

function acceptResponseCookies(response, activeSession) {
  const wasSignedIn = !!activeSession.cookies.MUSIC_U;
  acceptCookies(response, activeSession.cookies);
  if (activeSession === session) {
    if (wasSignedIn && !activeSession.cookies.MUSIC_U) {
      clearSession();
      throw fail("signIn", "网易云登录状态已失效，请重新登录");
    }
    persistSession();
  }
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
      ...EAPI_CLIENT,
      deviceId: deviceID(),
      mobilename: "",
      buildver: String(Math.floor(now / 1000)),
      requestId: `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`,
      __csrf: "",
      ...activeSession.cookies,
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
    if (options.form !== undefined) {
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
    if (response) throw new Error("网易云返回的响应无法解析，请稍后重试");
    throw new Error("无法读取网易云音乐，请检查网络及系统代理后重试");
  } finally {
    clearTimeout(timer);
  }
  if (startedEpoch !== epoch) throw new Error("账号状态已改变，请重试");
  if (!body || typeof body !== "object") throw new Error("网易云返回了无效数据");
  const code = Number(body.code);
  const allowed = options.codes || [200];
  if (!allowed.includes(code)) {
    // Content access can be forbidden while the account is still signed in.
    if (code === 401 && options.keepSession) {
      acceptResponseCookies(response, activeSession);
      throw fail("unavailable", "当前账号无权访问该内容");
    }
    if ([301, 302, 401].includes(code)) {
      if (activeSession === session) clearSession();
      throw fail("signIn", "请重新登录网易云音乐");
    }
    if (code === 460 || code === -460) {
      // A refused response can still renew NMTID. Keep the server's cookie
      // update for the same device/account retry, including session expiry.
      acceptResponseCookies(response, activeSession);
      const error = new Error(`网易云暂时拒绝了请求（${code}），请稍后重试`);
      error.neteaseCode = code;
      throw error;
    }
    if (code === 405) throw new Error("网易云暂时限制了请求，请稍后再试");
    throw new Error(`网易云接口返回错误（${Number.isFinite(code) ? code : "未知"}）`);
  }
  acceptResponseCookies(response, activeSession);
  return body;
}

const eapi = (path, params, options = {}) => request(path, params, { ...options, eapi: true });

function toArtist(artist = {}) {
  return { id: String(artist.id || ""), name: artist.name || "", imageUrl: artworkURL(artist.img1v1Url || artist.picUrl) };
}

function toAlbum(album = {}) {
  const date = Number(album.publishTime);
  return {
    id: String(album.id || ""), name: album.name || "", imageUrl: artworkURL(album.picUrl),
    artists: (album.artists || (album.artist ? [album.artist] : [])).map(toArtist),
    released: date > 0 ? new Date(date).toISOString().slice(0, 10) : "",
  };
}

function toTrack(track) {
  const privilege = track.privilege;
  // 宿主没有“这首歌从哪来”的字段，就用歌手行末尾的标签区分：网易云自己
  // 给不了完整音源（VIP/付费）的歌，或者实际由自定义音源补上的歌，加一个
  // 「来自音源」；能走网易云流的歌保持原样。
  const withdrawn = privilege ? privilege.st < 0 : false;
  const paidOnly = privilege ? privilege.pl <= 0 : track.fee === 1 || track.fee === 4;
  const artists = (track.ar || track.artists || []).map(toArtist);
  // 网易云给不了完整音源的歌，歌手后面标「需音源」；实际由音源播过的换成
  // 「已用音源」。能走网易云流的歌不加任何标记。
  const served = lxServed.has(String(track.id));
  if (!withdrawn && (served || paidOnly)) {
    artists.push({ id: "", name: served ? "已用音源" : "需音源" });
  }
  return {
    id: String(track.id), name: track.name || "",
    artists,
    album: toAlbum(track.al || track.album), duration: track.dt || track.duration || 0,
    url: `${SITE}/song?id=${track.id}`,
    // 宿主会把 unavailable 的歌整行禁用，点了没反应，也就轮不到自定义音源
    // 去补 VIP 歌。所以只要不是明确下架（st < 0），都让它可点，能不能放
    // 交给取流去判断。
    unavailable: withdrawn,
  };
}

function toPlaylist(playlist) {
  return {
    id: String(playlist.id), name: playlist.name || "",
    imageUrl: artworkURL(playlist.coverImgUrl || playlist.picUrl),
    description: playlist.description || "", owner: playlist.creator?.nickname || "",
    trackCount: playlist.trackCount || 0, saved: !!playlist.subscribed,
    fixed: Number(playlist.specialType) === 5,
    mine: !!session?.profile && String(playlist.creator?.userId) === session.profile.id,
  };
}

function toShow(show) {
  return {
    id: String(show.id), name: show.name || "", imageUrl: artworkURL(show.picUrl),
    description: show.desc || "", publisher: show.dj?.nickname || "",
    episodeCount: show.programCount || 0, subscribed: !!show.subed,
  };
}

function toEpisode(program, show) {
  const programID = idOf(program.id);
  const audioID = program.mainSong?.id ? idOf(program.mainSong.id) : null;
  const published = new Date(Number(program.createTime));
  return {
    // Keep the program ID for comments and the audio ID for playback. Missing
    // audio stays visible so the host's next offset still counts this episode.
    id: `program:${programID}${audioID ? ":" + audioID : ""}`,
    name: program.name || "", showId: String(show.id),
    artists: show.dj?.nickname ? [{ id: "", name: show.dj.nickname }] : [],
    album: { id: "", name: show.name || "", imageUrl: artworkURL(program.coverUrl || show.picUrl) },
    duration: program.duration || program.mainSong?.duration || 0,
    description: program.description || "",
    published: published.getTime() > 0 ? published.toISOString().slice(0, 10) : "",
    url: `${SITE}/program?id=${programID}`, unavailable: !audioID,
  };
}

function trackIdentity(value) {
  const match = /^program:(\d+)(?::(\d+))?$/.exec(String(value));
  if (match) {
    const program = idOf(match[1]);
    return { program, audio: match[2] ? idOf(match[2]) : null, thread: `A_DJ_1_${program}` };
  }
  const audio = idOf(value);
  return { audio, thread: `R_SO_4_${audio}` };
}

function toComment(comment) {
  const quote = (comment.beReplied || []).map(reply =>
    `${reply.user?.nickname || ""}：${reply.content || ""}`).join("\n");
  return {
    id: String(comment.commentId), author: comment.user?.nickname || "",
    avatarUrl: artworkURL(comment.user?.avatarUrl),
    text: (comment.content || "") + (quote ? `\n\n回复：${quote}` : ""),
    time: comment.time || 0, likes: comment.likedCount || 0, liked: !!comment.liked,
  };
}

async function songDetails(ids, originals = [], options = {}) {
  if (!ids.length) return [];
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    batches.push(ids.slice(offset, offset + 400));
  }
  const results = await Promise.all(batches.map(async (batch) => {
    const data = await eapi("/api/v3/song/detail", { c: JSON.stringify(batch.map((id) => ({ id: Number(idOf(id)) }))) }, options);
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
  return profile ? { id: String(profile.userId), name: profile.nickname, imageUrl: artworkURL(profile.avatarUrl) } : null;
}

export async function account() {
  const activeSession = currentSession();
  if (!activeSession.cookies.MUSIC_U) return null;
  if (activeSession.profile && Date.now() - profileCheckedAt < 60000) return activeSession.profile;
  try {
    const profile = await profileFor(activeSession);
    // A QR login can finish without another epoch change. Do not apply the
    // previous account's profile or sign-out to that newly accepted session.
    if (activeSession !== session) throw new Error("账号状态已改变，请重试");
    if (!profile) { clearSession(); return null; }
    activeSession.profile = profile;
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
      // Reject requests started against the previous account during QR login.
      epoch++;
      pendingStreams.clear();
      heartState = null;
      pendingHeart = null;
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
    shows: [1009, "djRadios", "djRadiosCount", toShow],
  };
  const type = types[kind];
  if (!type) throw fail("unsupported", "支持歌曲、专辑、歌手、歌单和播客搜索");
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

async function discoverySection() {
  try {
    return { title: "推荐歌单", playlists: await discoveryPlaylists() };
  } catch (error) {
    // Authentication failures still reach the host's sign-in flow. Optional
    // recommendations and cover art must not hide the navigation or radio.
    if (error.code === "signIn") throw error;
    return {
      title: "推荐歌单", empty: "推荐歌单暂时无法加载，点击「查看全部」重试；其他入口仍可使用。",
      morePage: "discovery",
    };
  }
}

export async function home() {
  const recommendations = await discoverySection();
  return {
    title: "发现音乐", subtitle: "网易云音乐 · 发现喜欢的音乐",
    sections: [
      { title: "我的音乐", links: [
        { title: "最近一周", subtitle: "听歌排行", page: "record:week" },
        { title: "所有时间", subtitle: "听歌排行", page: "record:all" },
        { title: "音乐云盘", subtitle: "我的云盘歌曲", page: "cloud:0" },
      ] },
      { title: "为你推荐", links: [
        { title: "每日推荐", subtitle: "每天更新，为你推荐好音乐", page: "daily", imageUrl: discoveryCover(0) },
        { title: "私人雷达", subtitle: "发现属于你的音乐", page: "radar", imageUrl: discoveryCover(1) },
        { title: "个性化歌单", subtitle: "网易云为你推荐的歌单", page: "recommendations", imageUrl: discoveryCover(2) },
      ] },
      { title: "私人漫游", stations: stationList() },
      recommendations,
    ],
  };
}

export async function browse({ page }) {
  if (page === "sources") return browseSources();
  if (page === "source-add") {
    lxListCache = null;
    const added = lxSyncFromSetting().added;
    const base = await browseSources();
    const note = added.length
      ? `已添加 ${added.length} 个音源：\n${added.map((item) => item.entry).join("\n")}`
      : "没有新的音源。要再加一个，就在「设置 → 插件 → 网易云音乐 → 自定义音源脚本」里追加一行地址，回来再点一次「添加音源」。";
    return {
      ...base,
      description: `${note}\n\n${base.description}`,
    };
  }
  if (page.startsWith("source:")) {
    const [, id, action] = page.split(":");
    return lxSourcePage(id, action);
  }
  if (/^cloud:\d+$/.test(page)) {
    await requireAccount();
    const offset = pageOffset(Number(page.slice(6)));
    const data = await request("/api/v1/cloud/get", { limit: PAGE_SIZE, offset }, { keepSession: true });
    if (!Array.isArray(data.data)) throw new Error("网易云未返回有效的云盘列表");
    const tracks = data.data.map(item => {
      // Private cloud songs may not exist in the public detail catalogue.
      const song = item.simpleSong || {};
      const track = toTrack({ ...song, id: item.songId, name: item.songName || song.name });
      if (!song.privilege) track.unavailable = false; // Stream still enforces access/trial checks.
      return track;
    });
    if (data.hasMore && !tracks.length) throw new Error("网易云未返回完整的云盘列表");
    return { title: "音乐云盘", sections: [{ tracks, empty: "云盘暂无歌曲", morePage: data.hasMore ? `cloud:${offset + tracks.length}` : "" }] };
  }
  if (page === "record:week" || page === "record:all") {
    const profile = await requireAccount();
    const week = page === "record:week";
    const data = await request("/api/v1/play/record", { uid: profile.id, type: week ? 1 : 0 }, { keepSession: true });
    const entries = data[week ? "weekData" : "allData"];
    if (!Array.isArray(entries)) throw new Error("网易云未返回有效的听歌排行");
    return { title: week ? "最近一周 · 听歌排行" : "所有时间 · 听歌排行", sections: [{ tracks: entries.filter(item => item.song?.id).map(item => toTrack(item.song)), empty: "暂无听歌记录" }] };
  }
  if (page === "discovery") {
    return { title: "推荐歌单", sections: [{ playlists: await discoveryPlaylists(), empty: "暂时没有推荐歌单" }] };
  }
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
  const activeSession = currentSession();
  const generation = epoch;
  const profile = await account();
  if (!profile) return [];
  checkAccountSession(activeSession, generation);
  // Return all pages instead of silently dropping subscriptions after 200.
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const data = await request("/api/user/playlist", { uid: profile.id, limit: 200, offset }, {
      session: activeSession, keepSession: true,
    });
    checkAccountSession(activeSession, generation);
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

// Some subscription responses ignore offset. Recover via a larger prefix,
// but only claim completeness when the server explicitly ends the list.
async function completeShowPrefix(previousSize, limit) {
  for (;;) {
    const data = await request("/api/djradio/get/subed", { limit, offset: 0, total: "true" }, { keepSession: true });
    if (!Array.isArray(data.djRadios)) throw new Error("网易云未返回有效的播客订阅列表");
    const unique = new Map(data.djRadios.map(item => [String(item.id), { ...toShow(item), subscribed: true }]));
    if (data.hasMore === false) return [...unique.values()];
    if (unique.size <= previousSize || limit >= 2000) throw new Error("网易云未返回完整的播客订阅列表，请稍后重试");
    previousSize = unique.size;
    limit = Math.min(2000, limit * 2);
  }
}

export async function shows() {
  await requireAccount();
  const result = new Map();
  let duplicatePages = 0;
  for (let offset = 0; offset < 2000;) {
    const data = await request("/api/djradio/get/subed", { limit: 100, offset, total: "true" }, { keepSession: true });
    const items = data.djRadios || [];
    const previousSize = result.size;
    for (const item of items) result.set(String(item.id), { ...toShow(item), subscribed: true });
    if (!data.hasMore) return [...result.values()];
    // A changing subscription list can overlap a page. Advance by the raw
    // count once, then recover via a bounded prefix if offset stays stuck.
    duplicatePages = result.size === previousSize ? duplicatePages + 1 : 0;
    if (!items.length || duplicatePages > 1) {
      return completeShowPrefix(result.size, Math.min(2000, Math.max(200, offset * 2)));
    }
    offset += items.length;
  }
  throw new Error("播客订阅超过本版本支持的 2000 个，暂时无法完整加载");
}

export async function show({ id, offset = 0 }) {
  id = idOf(id);
  offset = pageOffset(offset);
  const [detail, programs] = await Promise.all([
    request("/api/djradio/v2/get", { id }, { keepSession: true }),
    request("/api/dj/program/byradio", { radioId: id, limit: PAGE_SIZE, offset, asc: "false" }, { keepSession: true }),
  ]);
  if (!detail.data || String(detail.data.id) !== id) throw fail("unavailable", "播客不存在或当前账号无权访问");
  return {
    show: toShow(detail.data),
    episodes: (programs.programs || []).map(program => toEpisode(program, detail.data)),
    more: !!programs.more,
  };
}

export async function album({ id }) {
  const data = await request(`/api/v1/album/${idOf(id)}`);
  if (!data.album) throw fail("unavailable", "专辑不可用");
  return { album: toAlbum(data.album), tracks: (await songDetails((data.songs || []).map((song) => song.id), data.songs || [])).map(toTrack) };
}

async function artistAlbums(id) {
  // The host has no artist-album pagination action. Collect every page here,
  // advancing by raw page length so overlapping albums do not shift offsets.
  const albums = new Map();
  for (let offset = 0; offset < 10000;) {
    const data = await request(`/api/artist/albums/${id}`, { limit: PAGE_SIZE, offset });
    const items = data.hotAlbums || [];
    const previousSize = albums.size;
    for (const item of items) albums.set(String(item.id), toAlbum(item));
    if (!data.more) return [...albums.values()];
    if (!items.length || albums.size === previousSize) {
      throw new Error("网易云未返回完整的歌手专辑列表，请稍后重试");
    }
    offset += items.length;
  }
  throw new Error("歌手专辑过多，暂时无法完整加载");
}

export async function artist({ id }) {
  id = idOf(id);
  const [detail, albums] = await Promise.all([
    request(`/api/v1/artist/${id}`), artistAlbums(id),
  ]);
  if (!detail.artist) throw fail("unavailable", "歌手不可用");
  return {
    artist: toArtist(detail.artist), albums,
    tracks: (await songDetails((detail.hotSongs || []).map((song) => song.id), detail.hotSongs || [])).map(toTrack),
  };
}

async function likedIDs() {
  const activeSession = currentSession();
  const generation = epoch;
  const profile = await requireAccount();
  checkAccountSession(activeSession, generation);
  if (likedCache && likedCache.uid === profile.id && Date.now() - likedCache.at < 60000) return likedCache.ids;
  const revision = likedRevision;
  const data = await eapi("/api/song/like/get", { uid: profile.id }, { session: activeSession, keepSession: true });
  checkAccountSession(activeSession, generation);
  if (revision !== likedRevision) throw new Error("喜欢状态已更新，请重试");
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
  const identities = ids.map(id => ({ id, ...trackIdentity(id) }));
  const songs = identities.filter(item => !item.program);
  const result = Object.fromEntries(ids.map(id => [id, false]));
  // The host also asks about episode IDs. This read-only podcast integration
  // does not export likeEpisode and must not query song likes for episodes.
  if (!songs.length) return result;
  currentSession();
  if (!session.cookies.MUSIC_U) return result;
  const liked = new Set(await likedIDs());
  for (const item of songs) result[item.id] = liked.has(item.audio);
  return result;
}

export async function like({ id, on }) {
  const identity = trackIdentity(id);
  if (identity.program) throw fail("unsupported", "暂不支持喜欢或取消喜欢播客节目");
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  await eapi("/api/radio/like", { alg: "itembased", trackId: identity.audio, like: String(!!on), time: "3" }, {
    session: activeSession, keepSession: true,
  });
  checkAccountSession(activeSession, generation);
  likedRevision++;
  likedCache = null;
}

function checkAccountSession(activeSession, generation) {
  if (generation !== epoch || activeSession !== session) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function submitPlaylistTracks(op, id, ids, activeSession, generation) {
  checkAccountSession(activeSession, generation);
  const form = new URLSearchParams({ op, pid: id, imme: "true", trackIds: JSON.stringify(ids.map(Number)) });
  if (activeSession.cookies.__csrf) form.set("csrf_token", activeSession.cookies.__csrf);
  try {
    const data = await request("/api/playlist/manipulate/tracks", {}, {
      session: activeSession, form: form.toString(), keepSession: true, codes: [200, 502],
    });
    checkAccountSession(activeSession, generation);
    return data;
  } catch (error) {
    // Preserve signIn so the host can offer login; a content 401 keeps session.
    error.message = `${op === "add" ? "添加到歌单" : "移出歌单"}失败：${error.message}`;
    throw error;
  }
}

async function playlistTrackIDs(id, activeSession, generation) {
  checkAccountSession(activeSession, generation);
  const data = await request("/api/v6/playlist/detail", { id, n: PLAYLIST_LIMIT }, {
    session: activeSession, keepSession: true,
  });
  checkAccountSession(activeSession, generation);
  const source = data.playlist;
  if (String(source?.id) !== id || !Array.isArray(source.trackIds) || source.trackIds.length < source.trackCount) {
    throw new Error("无法确认歌单的完整歌曲列表，请刷新后重试");
  }
  return new Set(source.trackIds.map(track => String(track.id)));
}

async function manipulatePlaylistTracks(op, id, trackIds) {
  const pid = String(Number(idOf(id)));
  if (trackIds == null) trackIds = [];
  if (!Array.isArray(trackIds)) throw new Error("无效的歌曲列表");
  const ids = [...new Set(trackIds.map(value => {
    const identity = trackIdentity(value);
    if (identity.program) throw fail("unsupported", "暂不支持将播客节目添加到歌曲歌单或从中移除");
    return String(Number(identity.audio));
  }))];
  if (!ids.length) return;
  const activeSession = currentSession();
  const generation = epoch;
  await requireAccount();
  checkAccountSession(activeSession, generation);
  let data = await submitPlaylistTracks(op, pid, ids, activeSession, generation);
  if (op === "add" && Number(data.code) === 502) {
    // A duplicate rejects the whole batch. Only retry songs proved absent;
    // never treat an unexplained 502 or a concurrent edit as successful.
    const present = await playlistTrackIDs(pid, activeSession, generation);
    const missing = ids.filter(trackID => !present.has(trackID));
    if (!missing.length) {
      throw fail("duplicate", ids.length === 1 ? "这首歌已经在这个歌单里了" : "这些歌曲已经在这个歌单里了");
    }
    if (missing.length < ids.length) {
      data = await submitPlaylistTracks(op, pid, missing, activeSession, generation);
    }
  }
  if (Number(data.code) !== 200) {
    throw new Error(`${op === "add" ? "添加到歌单" : "移出歌单"}未完成（${data.code}），请刷新歌单后重试`);
  }
  likedCache = null;
}

export async function addToPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("add", id, trackIds);
}

export async function removeFromPlaylist({ id, trackIds }) {
  await manipulatePlaylistTracks("del", id, trackIds);
}

export async function comments({ trackId, offset = 0 }) {
  const identity = trackIdentity(trackId);
  offset = pageOffset(offset);
  const activeSession = currentSession();
  if (!commentSnapshot || commentSnapshot.thread !== identity.thread ||
      commentSnapshot.session !== activeSession || commentSnapshot.epoch !== epoch || offset === 0) {
    const hot = await request(`/api/v1/resource/hotcomments/${identity.thread}`, {
      rid: identity.program || identity.audio, limit: 20, offset: 0, beforeTime: 0,
    }, { session: activeSession, keepSession: true });
    const items = (hot.hotComments || []).slice().sort((a, b) => (b.likedCount || 0) - (a.likedCount || 0)).slice(0, 20);
    const unique = new Map(items.map(item => [String(item.commentId), item]));
    commentSnapshot = { thread: identity.thread, session: activeSession, epoch, items: [...unique.values()], seen: new Set(unique.keys()), cursor: 0, more: true, total: 0 };
  }
  const state = commentSnapshot;
  // Host offsets count displayed comments, not raw chronological records.
  // Retain both cursors so overlap with hot comments never skips a record.
  const pending = (state.pending || Promise.resolve()).catch(() => {}).then(async () => {
    let stagnantPages = 0;
    for (let pages = 0; state.items.length < offset + PAGE_SIZE && state.more; pages++) {
      if (pages >= 50) throw new Error("评论分页过多，请重新打开评论后重试");
      const data = await request(`/api/v1/resource/comments/${identity.thread}`, {
        limit: PAGE_SIZE, offset: state.cursor,
      }, { session: activeSession, keepSession: true });
      if (!Array.isArray(data.comments) || (data.more && !data.comments.length)) throw new Error("网易云未返回完整的评论列表");
      const previousSize = state.items.length;
      for (const item of data.comments) {
        const id = String(item.commentId);
        if (!state.seen.has(id)) { state.seen.add(id); state.items.push(item); }
      }
      stagnantPages = state.items.length === previousSize ? stagnantPages + 1 : 0;
      if (data.more && stagnantPages >= 2) throw new Error("网易云未返回完整的评论列表，请稍后重试");
      state.cursor += data.comments.length;
      state.more = !!data.more;
      state.total = data.total || state.items.length;
    }
  });
  state.pending = pending;
  try { await pending; }
  finally { if (state.pending === pending) state.pending = null; }
  if (state.session !== session || state.epoch !== epoch) throw new Error("账号状态已改变，请重试");
  return { comments: state.items.slice(offset, offset + PAGE_SIZE).map(toComment), total: state.total, more: offset + PAGE_SIZE < state.items.length || state.more };
}

// Word-timed lyrics (yrc) are served only by the desktop endpoint, and only
// to a signed-in listener: each line carries the span it is sung over, and
// each word, a character for CJK, its own. The web endpoint never carries
// them. A yrc row reads [start, length](start, length, 0)word…, times in
// milliseconds.
function parseYRC(text) {
  const lines = [];
  for (const row of String(text || "").split(/\r?\n/)) {
    const line = /^\[(\d+),(\d+)\](.*)$/.exec(row);
    if (!line) continue;
    const marks = [];
    const pattern = /\((\d+),(\d+),[^)]*\)/g;
    for (let mark; (mark = pattern.exec(line[3])); ) {
      marks.push({ at: mark.index, after: pattern.lastIndex, start: Number(mark[1]), end: Number(mark[1]) + Number(mark[2]) });
    }
    const words = marks
      .map((mark, i) => ({ start: mark.start, end: mark.end, text: line[3].slice(mark.after, marks[i + 1]?.at) }))
      .filter((word) => word.text);
    if (words.length) {
      lines.push({ start: Number(line[1]), end: Number(line[1]) + Number(line[2]), text: words.map((word) => word.text).join(""), words });
    }
  }
  return lines;
}

// A word-timed translation arrives as plain timed lines of its own; the one
// nearest to a line's start, within half a second, is that line's translation.
function alignTranslations(lines, timed) {
  const byTime = [];
  for (const row of String(timed || "").split(/\r?\n/)) {
    const text = row.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    const pattern = /\[(\d+):(\d+)(?:\.(\d+))?\]/g;
    for (let match; (match = pattern.exec(row)); ) {
      byTime.push({ start: Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || "").padEnd(3, "0").slice(0, 3)), text });
    }
  }
  for (const line of lines) {
    const nearest = byTime
      .filter((item) => Math.abs(item.start - line.start) <= 500)
      .sort((a, b) => Math.abs(a.start - line.start) - Math.abs(b.start - line.start))[0];
    if (nearest?.text) line.translation = nearest.text;
  }
  return lines;
}

// What a desktop lyric answer becomes: word-timed lines when it has yrc, with
// the word-timed translation preferred and the line-wise one as the stand-in,
// and plain LRC otherwise.
function lyricAnswer(desktop, translation) {
  const lrc = desktop.lrc?.lyric || "";
  const lines = parseYRC(desktop.yrc?.lyric);
  if (!lines.length) return { lrc, translation };
  return { lines: alignTranslations(lines, desktop.ytlrc?.lyric || translation), lrc, translation };
}

export async function lyrics({ id }) {
  const identity = trackIdentity(id);
  if (identity.program) return { lrc: "", translation: "" };
  const activeSession = currentSession();
  const generation = epoch;
  const params = { id: identity.audio, cp: false, tv: 0, lv: 0, rv: 0, kv: 0, yv: 0, ytv: 0, yrv: 0 };
  const options = { session: activeSession, keepSession: true };
  const checkSession = () => {
    if (activeSession !== session || generation !== epoch) throw new Error("账号状态已改变，请重试");
  };
  const fromDesktop = async (translation = "") => {
    const desktop = await eapi("/api/song/lyric/v1", params, options);
    checkSession();
    return lyricAnswer(desktop, desktop.tlyric?.lyric || translation);
  };
  // Prefer word timing when signed in, but retain web lyrics if the desktop
  // service fails. Authentication and account changes must still propagate.
  let desktopAnswer, desktopError;
  if (activeSession.cookies.MUSIC_U) {
    try {
      desktopAnswer = await fromDesktop();
      if (desktopAnswer.lines || desktopAnswer.lrc.trim()) return desktopAnswer;
    } catch (error) {
      if (error.code === "signIn") throw error;
      checkSession();
      desktopError = error;
    }
  }
  const data = await request("/api/song/lyric", { id: identity.audio, lv: 1, tv: -1 }, options);
  checkSession();
  const lrc = data.lrc?.lyric || "";
  const translation = data.tlyric?.lyric || desktopAnswer?.translation || "";
  if (lrc.trim()) return { lrc, translation };
  // Carry the web translation into the desktop fallback, even when the web
  // response has no original lyrics. Do not retry a failed desktop lookup.
  if (desktopError) throw desktopError;
  if (!desktopAnswer) return fromDesktop(translation);
  return { lrc: "", translation };
}

async function neteaseStream({ id, quality = "high" }) {
  id = trackIdentity(id).audio;
  if (!id) throw fail("unavailable", "该播客节目没有可播放的音频");
  const generation = epoch;
  const key = `${generation}:${id}:${quality}`;
  const pending = pendingStreams.get(key) || loadStream(id, quality, generation);
  pendingStreams.set(key, pending);
  try {
    const result = await pending;
    // Every waiter must recheck after resuming, including shared requests.
    if (generation !== epoch) throw new Error("账号状态已改变，请重试");
    return result;
  }
  finally { if (pendingStreams.get(key) === pending) pendingStreams.delete(key); }
}

// NetEase answers first. A custom source of the listener's is asked only when
// NetEase has no full audio for this track, so its own rights and quality
// still decide what plays.
export async function stream({ id, quality = "high" }) {
  try {
    return await neteaseStream({ id, quality });
  } catch (error) {
    if (error?.code === "signIn" || !lxEnabled()) throw error;
    const audio = await customStream(id, quality);
    if (!audio) throw error;
    return audio;
  }
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
      if (attempt === 1) {
        const refused = new Error(`[${error.neteaseCode}] 网易云仍拒绝播放请求，请稍后再试，并在官方客户端确认该歌曲可正常播放`);
        refused.neteaseCode = error.neteaseCode;
        throw refused;
      }
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
  if (!["mp3", "flac", "ogg", "m4a", "mp4", "aac"].includes(type)) throw fail("unavailable", "该歌曲的音频格式暂不支持");
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
  ].map((station, index) => ({
    ...station,
    // Older hosts replace source errors with a generic toast, so keep the
    // prerequisite visible on the station card as well.
    description: `${station.description}。需在网易云 App 中开启「个性化服务」。`,
    imageUrl: discoveryCover(index + 3),
  }));
}

export async function stations() {
  if (discoveryCovers === null) await discoverySection();
  return stationList();
}

// Candidate only: HEART is deliberately absent from stationList until live
// account and continuation checks pass. This uses NetEase's intelligence API,
// never the FAMILIAR radio or a local shuffle as a substitute.
function checkHeartAccount(activeSession, generation) {
  if (activeSession !== session || generation !== epoch) {
    throw new Error("账号状态已改变，请重试");
  }
}

async function startHeart(activeSession, generation, profile) {
  let likedPlaylist;
  for (let offset = 0; offset < 2000; offset += 200) {
    const data = await request("/api/user/playlist", { uid: profile.id, limit: 200, offset }, {
      session: activeSession, keepSession: true,
    });
    checkHeartAccount(activeSession, generation);
    if (!Array.isArray(data.playlist)) throw new Error("无法读取喜欢的音乐歌单");
    likedPlaylist = data.playlist.find(item => item && Number(item.specialType) === 5 &&
      String(item.creator?.userId) === profile.id);
    if (likedPlaylist) break;
    if (!data.more || data.playlist.length < 200) break;
  }
  if (!likedPlaylist) throw fail("unavailable", "未找到当前账号的喜欢歌单，暂时无法开启心动模式");
  const playlistID = idOf(likedPlaylist.id);
  const data = await request("/api/v6/playlist/detail", { id: playlistID, n: 1 }, {
    session: activeSession, keepSession: true,
  });
  checkHeartAccount(activeSession, generation);
  const playlist = data.playlist;
  if (!playlist || String(playlist.id) !== playlistID || Number(playlist.specialType) !== 5 ||
      String(playlist.creator?.userId) !== profile.id) {
    throw fail("unavailable", "无法确认当前账号的喜欢歌单");
  }
  const tracks = playlist.trackIds || playlist.tracks;
  if (!Array.isArray(tracks)) throw new Error("网易云未返回喜欢歌单的歌曲列表");
  if (!tracks.length) throw fail("unavailable", "喜欢歌单为空，请先在网易云喜欢一首歌曲");
  const seedTrack = tracks.find(track => track && /^\d+$/.test(String(track.id)) &&
    Number.isSafeInteger(Number(track.id)) && Number(track.id) > 0);
  if (!seedTrack) throw fail("unavailable", "喜欢歌单没有可用的种子歌曲");
  const seed = idOf(seedTrack.id);
  return { uid: profile.id, generation, playlistID, seed, last: seed, seen: [] };
}

async function loadHeart(activeSession, generation) {
  const profile = await requireAccount();
  checkHeartAccount(activeSession, generation);
  const state = heartState?.generation === generation && heartState.uid === profile.id
    ? heartState : await startHeart(activeSession, generation, profile);
  checkHeartAccount(activeSession, generation);
  const seen = new Set(state.seen);
  let cursor = state.last;
  // Advance over repeated batches, but do not loop indefinitely if the
  // service cannot supply a new recommendation or stops advancing its cursor.
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await eapi("/api/playmode/intelligence/list", {
      songId: cursor, startMusicId: state.seed, playlistId: state.playlistID,
      type: "fromPlayOne", count: 1,
    }, { session: activeSession, keepSession: true });
    checkHeartAccount(activeSession, generation);
    if (!Array.isArray(data.data)) throw new Error("网易云未返回有效的心动推荐列表");
    const songs = [];
    let nextCursor = cursor;
    for (const item of data.data) {
      // Removed songs can leave null entries or empty songInfo records.
      if (item == null) continue;
      if (typeof item !== "object") throw new Error("网易云返回了无效的心动推荐歌曲");
      if (item.songInfo == null) continue;
      const id = idOf(item.songInfo.id);
      nextCursor = id;
      if (!seen.has(id)) { seen.add(id); songs.push(item.songInfo); }
    }
    if (songs.length) {
      const ids = songs.map(song => idOf(song.id));
      const tracks = (await songDetails(ids, songs, { session: activeSession, keepSession: true })).map(toTrack);
      checkHeartAccount(activeSession, generation);
      heartState = { ...state, last: nextCursor, seen: [...seen].slice(-200) };
      return tracks;
    }
    // No new tracks need resolving; retain the service's cursor so the next
    // invocation does not restart at the original repeated batch.
    heartState = { ...state, last: nextCursor };
    if (nextCursor === cursor) break;
    cursor = nextCursor;
  }
  throw fail("unavailable", "网易云暂未返回新的心动推荐，请稍后重试");
}

async function heartNext() {
  const activeSession = currentSession();
  const generation = epoch;
  if (pendingHeart?.session === activeSession && pendingHeart.generation === generation) {
    return pendingHeart.promise;
  }
  const pending = { session: activeSession, generation, promise: loadHeart(activeSession, generation) };
  pendingHeart = pending;
  try { return await pending.promise; }
  finally { if (pendingHeart === pending) pendingHeart = null; }
}

export async function stationNext({ id }) {
  if (id === "HEART") return heartNext();
  if (!["DEFAULT", "FAMILIAR", "EXPLORE"].includes(id)) throw fail("unsupported", "没有这个漫游模式");
  await requireAccount();
  const data = await eapi("/api/v1/radio/get", { mode: id, limit: 3 });
  const songs = data.data || [];
  if (songs.length === 0) {
    let personalizationDisabled = false;
    try {
      const preferences = await request("/api/user/setting", {}, { keepSession: true });
      personalizationDisabled = preferences.setting?.personalServiceSetting === 2;
    } catch (error) {
      // A diagnostic lookup must not turn a transient empty batch into a new
      // failure, but an expired session still needs the normal sign-in flow.
      if (error.code === "signIn") throw error;
    }
    if (personalizationDisabled) {
      throw fail("unavailable", "网易云的「个性化服务」已关闭。请在官方 App 的「设置 → 消息和隐私 → 个性化服务」中开启后重试。");
    }
  }
  return (await songDetails(songs.map(song => song.id), songs)).map(toTrack);
}

// ---------------------------------------------------------------------------
// 自定义音源：洛雪音乐（LX Music）格式的脚本
//
// 脚本按洛雪的自定义源规范运行：开头是 /* @name ... */ 信息块，脚本里用
// globalThis.lx 的 on/send/request 与应用通信，send(inited, { sources }) 上报
// 它支持的源。这里只取它的 musicUrl，用来补网易云自己放不了的歌。
// ---------------------------------------------------------------------------

const LX_SOURCE_KEYS = ["wy", "kw", "kg", "tx", "mg", "local"];
const LX_INFO_FIELDS = { name: 24, description: 36, author: 56, homepage: 1024, version: 36 };
const LX_QUALITIES = { standard: "128k", high: "320k", lossless: "flac" };
const LX_MAX_SCRIPT = 2 << 20;
const LX_FETCH_TIMEOUT = 15000;
const lxScriptText = new Map();
let lxSources = null;
let lxLoading = null;
let lxSettingCache = null;
let lxListCache = null;
// 这次会话里实际由自定义音源播放过的歌曲 ID，用来在列表里标出来源。
const lxServed = new Set();

// 音源列表存在插件的私有存储里，这样页面上的添加、启用、删除都能立刻生效；
// 设置里的「自定义音源脚本」只作为首次导入和批量粘贴的入口。
function lxStoreList() {
  if (lxListCache) return lxListCache;
  lxListCache = lxSyncFromSetting().list;
  return lxListCache;
}

// 设置框里的脚本是“待导入”的：每次读列表时并进来，删掉过的不会再回来。
function lxSyncFromSetting() {
  let stored;
  try { stored = host.storage.get("sources"); } catch { stored = undefined; }
  const list = Array.isArray(stored)
    ? stored.filter((item) => item && typeof item.entry === "string" && item.entry)
    : [];
  const ignored = lxIgnored();
  const known = new Set(list.map((item) => item.entry));
  const added = [];
  for (const entry of lxEntriesFromSetting()) {
    if (known.has(entry) || ignored.includes(entry)) continue;
    known.add(entry);
    added.push({ id: lxID(), entry, enabled: true });
  }
  const result = list.concat(added);
  if (added.length || !Array.isArray(stored)) lxSaveList(result);
  return { list: result, added };
}

function lxIgnored() {
  try {
    const list = host.storage.get("sourceIgnored");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function lxIgnore(entry) {
  const list = lxIgnored();
  if (!list.includes(entry)) {
    try { host.storage.set("sourceIgnored", list.concat(entry)); } catch { /* 忽略 */ }
  }
}

function lxSaveList(list) {
  lxListCache = list;
  try { host.storage.set("sources", list); } catch { /* 存不下时至少本进程内有效 */ }
  lxSources = null;
  lxLoading = null;
  lxScriptText.clear();
}

function lxID() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

function lxSetting() {
  if (lxSettingCache === null) {
    let value = "";
    try { value = String(host.setting("customSource") || ""); } catch { value = ""; }
    lxSettingCache = value.trim();
  }
  return lxSettingCache;
}

// 地址之间用空白或逗号分开，方便在单行设置框里放多个源。data: 地址里本身
// 就有逗号和分号，所以它一直读到空白为止；带空格的本地路径用引号包起来。
function lxParseEntries(text) {
  const entries = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && /[\s,，;；]/.test(text[i])) i++;
    if (i >= text.length) break;
    const quote = text[i] === '"' || text[i] === "'" ? text[i] : "";
    if (quote) {
      const end = text.indexOf(quote, i + 1);
      if (end < 0) { entries.push(text.slice(i + 1)); break; }
      entries.push(text.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    const inline = /^data:/i.test(text.slice(i, i + 5));
    let end = i;
    while (end < text.length && (inline ? !/\s/.test(text[end]) : !/[\s,，;；]/.test(text[end]))) end++;
    entries.push(text.slice(i, end));
    i = end;
  }
  return entries;
}

function lxEntriesFromSetting() {
  return lxParseEntries(lxSetting());
}

function lxEntries() {
  return lxStoreList().filter((item) => item.enabled !== false).map((item) => item.entry);
}

// 本地脚本：Windows 的 C:\…、UNC 的 \\…、以及 macOS/Linux 的 /…。
function lxIsLocalPath(entry) {
  return /^[a-z]:[\\/]/i.test(entry) || entry.startsWith("\\\\") || entry.startsWith("/");
}

function lxEnabled() {
  return lxEntries().length > 0;
}

function lxInfoOf(script) {
  const head = /^\/\*[\s\S]+?\*\//.exec(script);
  if (!head) throw new Error("不是洛雪自定义音源：开头缺少 /* @name ... */ 信息块");
  const info = {};
  for (const line of head[0].split(/\r?\n/)) {
    const match = /^\s?\*\s?@(\w+)\s+(.+)$/.exec(line);
    if (!match || !(match[1] in LX_INFO_FIELDS)) continue;
    info[match[1]] = match[2].trim().slice(0, LX_INFO_FIELDS[match[1]]);
  }
  return { name: info.name || "未命名音源", description: info.description || "", version: info.version || "", author: info.author || "", homepage: info.homepage || "" };
}

const LX_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function lxDecodeBase64(text) {
  const clean = String(text).replace(/[\s=]+$/g, "").replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0, value = 0, at = 0;
  for (const char of clean) {
    value = (value << 6) | LX_BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (value >> bits) & 0xff; }
  }
  return out.subarray(0, at);
}

function lxEncodeBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += LX_BASE64[a >> 2] + LX_BASE64[((a & 3) << 4) | ((b || 0) >> 4)]
      + (b === undefined ? "=" : LX_BASE64[((b & 15) << 2) | ((c || 0) >> 6)])
      + (c === undefined ? "=" : LX_BASE64[c & 63]);
  }
  return out;
}

// 宿主沙箱不保证有 TextEncoder/TextDecoder，这里自带一份 UTF-8 编解码。
function lxText(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    if (first < 0x80) { out += String.fromCharCode(first); continue; }
    const need = first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : first >= 0xc0 ? 1 : 0;
    let code = need === 3 ? first & 0x07 : need === 2 ? first & 0x0f : need === 1 ? first & 0x1f : 0xfffd;
    for (let k = 0; k < need && i < bytes.length; k++) code = (code << 6) | (bytes[i++] & 0x3f);
    out += code > 0xffff
      ? String.fromCharCode(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 0x3ff))
      : String.fromCharCode(code);
  }
  return out;
}

function lxBytes(text) {
  const out = [];
  for (const char of String(text)) {
    let code = char.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(out);
}

// 脚本里 Buffer 的常用操作。Uint8Array 本身没有 toString(format)，所以给
// 自定义源一个够用的 Buffer 子类，让 lx.utils.buffer.from 的结果能照常使用。
class LXBuffer extends Uint8Array {
  toString(format = "utf8") {
    const name = String(format || "utf8").toLowerCase();
    if (name === "hex") return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
    if (name === "base64") return lxEncodeBase64(this);
    if (name === "binary" || name === "latin1") return String.fromCharCode(...this);
    return lxText(this);
  }
}

function lxBufferFrom(...args) {
  const [value, encoding] = args;
  if (value instanceof Uint8Array) return new LXBuffer(value);
  if (Array.isArray(value)) return new LXBuffer(Uint8Array.from(value));
  if (value instanceof ArrayBuffer) return new LXBuffer(new Uint8Array(value));
  const text = String(value ?? "");
  const name = String(encoding || "utf8").toLowerCase();
  if (name === "hex") {
    const out = new Uint8Array(Math.floor(text.length / 2));
    for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16) || 0;
    return new LXBuffer(out);
  }
  if (name === "base64") return new LXBuffer(lxDecodeBase64(text));
  if (name === "binary" || name === "latin1") return new LXBuffer(Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff));
  return new LXBuffer(lxBytes(text));
}

// AES：洛雪的 lx.utils.crypto.aesEncrypt 用 Node 的 createCipheriv，很多源
// 靠它签名。这里按同样的参数形式实现 CBC/ECB/CTR 的加解密。
function lxAesMul(a, b) {
  let product = 0;
  while (b) {
    if (b & 1) product ^= a;
    const high = a & 0x80;
    a = (a << 1) & 0xff;
    if (high) a ^= 0x1b;
    b >>= 1;
  }
  return product;
}

const lxAesTables = (() => {
  const power = (a, n) => {
    let result = 1;
    while (n > 0) { if (n & 1) result = lxAesMul(result, a); a = lxAesMul(a, a); n >>= 1; }
    return result;
  };
  const sbox = new Uint8Array(256), inverse = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const back = i === 0 ? 0 : power(i, 254);
    let value = back, rotated = back;
    for (let k = 0; k < 4; k++) { rotated = ((rotated << 1) | (rotated >> 7)) & 0xff; value ^= rotated; }
    sbox[i] = value ^ 0x63;
    inverse[value ^ 0x63] = i;
  }
  return { sbox, inverse };
})();

function lxAesExpand(key) {
  const nk = key.length / 4, rounds = nk + 6, words = 4 * (rounds + 1);
  const w = new Uint8Array(words * 4);
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < words; i++) {
    let t = [w[i * 4 - 4], w[i * 4 - 3], w[i * 4 - 2], w[i * 4 - 1]];
    if (i % nk === 0) {
      t = [lxAesTables.sbox[t[1]] ^ rcon, lxAesTables.sbox[t[2]], lxAesTables.sbox[t[3]], lxAesTables.sbox[t[0]]];
      rcon = lxAesMul(rcon, 2);
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((v) => lxAesTables.sbox[v]);
    }
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return { w, rounds };
}

function lxAesAddRoundKey(state, w, round) {
  for (let i = 0; i < 16; i++) state[i] ^= w[round * 16 + i];
}

function lxAesSub(state, table) {
  for (let i = 0; i < 16; i++) state[i] = table[state[i]];
}

// state 按列优先排列：第 r 行第 c 列是 state[r + 4c]。
function lxAesShift(state, inverse) {
  const copy = Uint8Array.from(state);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const from = inverse ? (c - r + 4) % 4 : (c + r) % 4;
      state[r + 4 * c] = copy[r + 4 * from];
    }
  }
}

function lxAesMix(state, inverse) {
  const matrix = inverse ? [14, 11, 13, 9] : [2, 3, 1, 1];
  for (let c = 0; c < 4; c++) {
    const a = state.slice(c * 4, c * 4 + 4);
    for (let r = 0; r < 4; r++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value ^= lxAesMul(a[k], matrix[(k - r + 4) % 4]);
      state[c * 4 + r] = value;
    }
  }
}

function lxAesBlock(block, expanded, decrypt) {
  const state = Uint8Array.from(block);
  const { w, rounds } = expanded;
  if (!decrypt) {
    lxAesAddRoundKey(state, w, 0);
    for (let round = 1; round < rounds; round++) {
      lxAesSub(state, lxAesTables.sbox);
      lxAesShift(state, false);
      lxAesMix(state, false);
      lxAesAddRoundKey(state, w, round);
    }
    lxAesSub(state, lxAesTables.sbox);
    lxAesShift(state, false);
    lxAesAddRoundKey(state, w, rounds);
  } else {
    lxAesAddRoundKey(state, w, rounds);
    for (let round = rounds - 1; round > 0; round--) {
      lxAesShift(state, true);
      lxAesSub(state, lxAesTables.inverse);
      lxAesAddRoundKey(state, w, round);
      lxAesMix(state, true);
    }
    lxAesShift(state, true);
    lxAesSub(state, lxAesTables.inverse);
    lxAesAddRoundKey(state, w, 0);
  }
  return state;
}

function lxAesCipher(bytes, mode, key, iv, decrypt) {
  const name = String(mode || "").toLowerCase();
  const size = /aes-(\d+)/.exec(name)?.[1];
  if (!size || ![128, 192, 256].includes(Number(size))) throw new Error(`不支持的加密方式：${mode}`);
  if (![16, 24, 32].includes(key.length)) throw new Error("AES 密钥长度不正确");
  const expanded = lxAesExpand(key);
  const block = name.endsWith("-ecb") ? "ecb" : name.endsWith("-ctr") ? "ctr" : name.endsWith("-cbc") ? "cbc" : "";
  if (!block) throw new Error(`不支持的加密方式：${mode}`);
  if (block === "ctr") {
    const out = new Uint8Array(bytes.length);
    const counter = Uint8Array.from(iv);
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const stream = lxAesBlock(counter, expanded, false);
      for (let i = 0; i < 16 && offset + i < bytes.length; i++) out[offset + i] = bytes[offset + i] ^ stream[i];
      for (let i = 15; i >= 0; i--) { counter[i] = (counter[i] + 1) & 0xff; if (counter[i] !== 0) break; }
    }
    return out;
  }
  if (block === "cbc" && (!iv || iv.length !== 16)) throw new Error("AES-CBC 需要 16 字节的 iv");
  // Node 的 createCipheriv 默认按 PKCS#7 补位，洛雪的脚本按这个语义用。
  let data = bytes;
  if (!decrypt) {
    const pad = 16 - (bytes.length % 16);
    data = new Uint8Array(bytes.length + pad).fill(pad);
    data.set(bytes);
  }
  const out = new Uint8Array(data.length);
  let chain = Uint8Array.from(iv || new Uint8Array(16));
  for (let offset = 0; offset < data.length; offset += 16) {
    const chunk = data.subarray(offset, offset + 16);
    if (!decrypt) {
      const mixed = new Uint8Array(16);
      for (let i = 0; i < 16; i++) mixed[i] = chunk[i] ^ (block === "cbc" ? chain[i] : 0);
      const result = lxAesBlock(mixed, expanded, false);
      out.set(result, offset);
      chain = result;
    } else {
      const result = lxAesBlock(chunk, expanded, true);
      for (let i = 0; i < 16; i++) out[offset + i] = result[i] ^ (block === "cbc" ? chain[i] : 0);
      chain = Uint8Array.from(chunk);
    }
  }
  if (!decrypt) return out;
  const pad = out[out.length - 1];
  return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
}

function lxRandomBytes(size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor(Math.random() * 256);
  return new LXBuffer(out);
}

// 一个脚本一个运行环境：globalThis 被参数遮住，脚本只能看到自己的 lx。
// 有的脚本要等一次异步请求拿到 token 才发 inited，所以给一点等待时间。
function lxRuntime(script, info, wait = 5000) {
  const handlers = {};
  let inited = null;
  let initError = null;
  let notify = null;
  const lx = {
    EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },
    version: "2.0.0",
    env: "desktop",
    currentScriptInfo: { ...info, rawScript: script },
    on(name, handler) {
      if (name !== "request") return Promise.reject(new Error(`不支持的事件：${name}`));
      handlers.request = handler;
      return Promise.resolve();
    },
    send(name, data) {
      if (name === "inited") { inited = data || {}; notify?.(); return Promise.resolve(); }
      return Promise.resolve();
    },
    request(url, options, callback) {
      const settings = options || {};
      const controller = new AbortController();
      const wait = Number(settings.timeout) > 0 ? Math.min(Number(settings.timeout), 60000) : 60000;
      const timer = setTimeout(() => controller.abort(), wait);
      const headers = { ...(settings.headers || {}) };
      const init = { method: String(settings.method || "get").toUpperCase(), headers, signal: controller.signal };
      if (settings.form) {
        init.body = new URLSearchParams(settings.form).toString();
        if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = "application/x-www-form-urlencoded";
      } else if (settings.body != null) {
        init.body = typeof settings.body === "string" ? settings.body : JSON.stringify(settings.body);
        if (typeof settings.body !== "string" && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      }
      fetch(url, init).then(async (response) => {
        const text = typeof response.text === "function" ? await response.text()
          : typeof response.arrayBuffer === "function" ? lxText(new Uint8Array(await response.arrayBuffer()))
          : typeof response.json === "function" ? JSON.stringify(await response.json())
          : "";
        const raw = lxBytes(text);
        let body = text;
        try { body = JSON.parse(text); } catch { /* 不是 JSON 就原样给文本 */ }
        // 真实 fetch 的 headers 可迭代，测试或别的实现不一定，所以两种都接。
        let headerFields = {};
        try { headerFields = Object.fromEntries(response.headers || []); }
        catch { headerFields = { ...(response.headers || {}) }; }
        const answer = { statusCode: response.status, statusMessage: response.statusText, headers: headerFields, bytes: raw.length, raw: new LXBuffer(raw), body };
        callback.call(lx, null, answer, body);
      }).catch((error) => {
        callback.call(lx, error, null, null);
      }).finally(() => clearTimeout(timer));
      return () => controller.abort();
    },
    utils: {
      crypto: {
        md5: (text) => host.crypto.md5(String(text)),
        aesEncrypt: (buffer, mode, key, iv) => new LXBuffer(lxAesCipher(lxBufferFrom(buffer), mode, lxBufferFrom(key), iv == null ? null : lxBufferFrom(iv), false)),
        randomBytes: lxRandomBytes,
      },
      buffer: {
        from: lxBufferFrom,
        bufToString: (buf, format) => lxBufferFrom(buf).toString(format),
      },
      zlib: {
        inflate: () => Promise.reject(new Error("当前插件不支持 zlib 解压，请换用不需要压缩的音源")),
        deflate: () => Promise.reject(new Error("当前插件不支持 zlib 压缩，请换用不需要压缩的音源")),
      },
    },
  };
  // 不少洛雪脚本直接用全局 Buffer / atob / btoa，这里给一个够用的替身。
  const Buffer = {
    from: lxBufferFrom,
    alloc: (size, fill = 0) => new LXBuffer(new Uint8Array(size).fill(typeof fill === "number" ? fill : 0)),
    concat: (list) => {
      const parts = list.map((item) => lxBufferFrom(item));
      const out = new LXBuffer(parts.reduce((total, part) => total + part.length, 0));
      let at = 0;
      for (const part of parts) { out.set(part, at); at += part.length; }
      return out;
    },
    isBuffer: (value) => value instanceof Uint8Array,
  };
  const sandbox = {
    lx, Buffer, console,
    atob: (text) => lxText(lxDecodeBase64(text)),
    btoa: (text) => lxEncodeBase64(lxBytes(text)),
  };
  try {
    // 脚本与插件在同一个 realm：把插件的 host（里面有登录 cookie）和其它
    // 宿主能力挡在参数外，脚本只能用 lx 拿到的东西。用箭头函数包一层，免
    // 得脚本里的 this 又指回真实全局。
    const factory = new Function(
      "globalThis", "window", "self", "host", "fetch", "process", "require", "module", "exports", "global",
      `"use strict";\nreturn () => {\n${script}\n}`,
    );
    factory(sandbox, sandbox, sandbox, undefined, undefined, undefined, undefined, undefined, undefined, sandbox)();
  } catch (error) {
    initError = error;
  }
  const runtime = {
    info, script, handlers,
    get sources() {
      return inited && inited.sources && typeof inited.sources === "object" ? inited.sources : null;
    },
    error: initError,
    get ready() { return !!runtime.sources && typeof handlers.request === "function"; },
  };
  if (runtime.ready || initError) return Promise.resolve(runtime);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); notify = null; resolve(runtime); };
    const timer = setTimeout(done, wait);
    notify = done;
  });
}

// 宿主不给插件读文件，本地脚本只能借 host.spawn 起一个系统命令把文件打印
// 到标准输出。这需要插件清单里声明 process 权限，并由你在插件设置里点
// 「允许运行程序」。
async function lxReadLocal(entry) {
  const spawn = typeof host !== "undefined" ? host.spawn : null;
  if (typeof spawn !== "function") {
    throw new Error("这个版本的 MyGo 不支持读取本地文件，请改用 https:// 地址");
  }
  const windows = /^[a-z]:[\\/]/i.test(entry) || entry.startsWith("\\\\");
  // 用 base64 把字节原样带回来，免得经过控制台的代码页变成乱码。路径里的
  // 单引号按 PowerShell 的写法转义。
  const literal = entry.replace(/'/g, "''");
  const command = windows ? "powershell" : "base64";
  const args = windows
    ? ["-NoProfile", "-NonInteractive", "-Command", `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${literal}'))`]
    : [entry];
  let child;
  try {
    child = spawn(command, args);
  } catch (error) {
    throw new Error(`读不了本地音源脚本：${String(error?.message || error)}（需要在插件设置里允许运行程序）`);
  }
  let text = "";
  for (;;) {
    const line = await child.readLine();
    if (line === null) break;
    text += line.trim();
  }
  const code = await child.wait();
  if (code !== 0 || !text.trim()) {
    const why = String(child.errorOutput?.() || "").trim().slice(0, 120);
    throw new Error(`读不了本地音源脚本${code ? `（退出码 ${code}）` : ""}${why ? `：${why}` : ""}。若提示权限，请在插件设置里点「允许运行程序」。`);
  }
  return lxText(lxDecodeBase64(text));
}

async function lxReadScript(entry) {
  if (lxScriptText.has(entry)) return lxScriptText.get(entry);
  let script;
  if (/^data:/i.test(entry)) {
    const match = /^data:([^,]*?),(.*)$/s.exec(entry);
    if (!match) throw new Error("无法识别的 data: 地址");
    script = /;base64/i.test(match[1]) ? lxText(lxDecodeBase64(match[2])) : decodeURIComponent(match[2]);
  } else if (/^https?:\/\//i.test(entry)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LX_FETCH_TIMEOUT);
    try {
      const response = await fetch(entry, { headers: { "User-Agent": UA }, signal: controller.signal, redirect: "follow" });
      if (!response.ok) throw new Error(`下载音源脚本失败（HTTP ${response.status}）`);
      script = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw new Error("下载音源脚本超时，请检查网络后重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  } else if (/^file:\/\//i.test(entry) || lxIsLocalPath(entry)) {
    script = await lxReadLocal(entry.replace(/^file:\/\//i, "").replace(/^\/([a-z]:)/i, "$1"));
  } else {
    throw new Error(`音源地址要填 https:// 链接、data: 内联脚本或本地文件路径：${entry.slice(0, 32)}`);
  }
  if (script.length > LX_MAX_SCRIPT) throw new Error("音源脚本过大");
  lxScriptText.set(entry, script);
  return script;
}

async function lxLoad() {
  const entries = lxEntries();
  const result = [];
  for (const entry of entries) {
    try {
      const script = await lxReadScript(entry);
      const info = lxInfoOf(script);
      const runtime = await lxRuntime(script, info);
      if (runtime.error) throw runtime.error;
      if (!runtime.sources) throw new Error("脚本没有发送 inited 事件，可能不是洛雪自定义音源");
      result.push({ ...runtime, entry });
    } catch (error) {
      result.push({ entry, info: { name: entry.replace(/^data:.{0,24}.*/, "内联脚本") }, error, sources: null, ready: false, handlers: {} });
    }
  }
  return result;
}

async function lxSourcesNow() {
  if (lxSources) return lxSources;
  if (!lxLoading) {
    lxLoading = lxLoad().then((loaded) => { lxSources = loaded; return loaded; })
      .finally(() => { lxLoading = null; });
  }
  return lxLoading;
}

// 只有脚本声明了「网易云」源、并且它给出了 musicUrl，才可能补这首歌。
function lxUsable(runtime) {
  const source = runtime?.sources?.wy;
  return !!(runtime?.ready && source && Array.isArray(source.actions) && source.actions.includes("musicUrl"));
}

function lxQualityName(quality) {
  const source = quality === "lossless" ? "flac" : quality === "standard" ? "128k" : "320k";
  return source;
}

// 宿主只把歌曲 ID 交给 stream，脚本却常按名字和歌手再查一次，所以回退时
// 按 ID 补一次详情。查不到就让脚本只凭 ID 去要。
async function lxTrackInfo(id) {
  try {
    const [song] = await songDetails([id]);
    if (!song || String(song.id) !== String(id)) return null;
    return toTrack(song);
  } catch {
    return null;
  }
}

async function customStream(id, quality) {
  if (!lxEnabled()) return null;
  const identity = trackIdentity(id);
  if (!identity.audio) return null;
  const loaded = await lxSourcesNow();
  const runtimes = loaded.filter(lxUsable);
  if (!runtimes.length) return null;
  const track = await lxTrackInfo(identity.audio);
  const wanted = lxQualityName(quality);
  const failures = [];
  // 有多个音源时按顺序试，一个拿不到就换下一个，只有全都失败才报错。
  for (const runtime of runtimes) {
    const offered = Array.isArray(runtime.sources.wy.qualitys) ? runtime.sources.wy.qualitys : [];
    const type = offered.includes(wanted) ? wanted : offered.includes("320k") ? "320k" : offered[0] || wanted;
    // 洛雪的脚本按 musicInfo 里的名字和歌手再查一次，字段要按它的写法给全。
    const musicInfo = {
      songmid: identity.audio, id: identity.audio, hash: identity.audio,
      name: track?.name || "", singer: (track?.artists || []).map((artist) => artist.name).filter(Boolean).join("、"),
      albumName: track?.album?.name || "", albumId: String(track?.album?.id || ""),
      interval: track?.duration ? Math.round(track.duration / 1000) : 0,
      source: "wy", strMediaMid: identity.audio, mediaMid: identity.audio,
    };
    let url;
    try {
      url = await Promise.resolve(runtime.handlers.request({ source: "wy", action: "musicUrl", info: { type, musicInfo } }));
    } catch (error) {
      failures.push(`${runtime.info.name}：${String(error?.message || error).slice(0, 60)}`);
      continue;
    }
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      failures.push(`${runtime.info.name}：没有给出音频地址`);
      continue;
    }
    const audio = new URL(url);
    if (audio.protocol !== "https:") audio.protocol = "https:";
    const guess = /\.(flac|mp3|m4a|aac|ogg|mp4)(?:$|\?)/i.exec(audio.pathname)?.[1]?.toLowerCase();
    // 记下来：这首歌这次是从音源播的，列表里要标出来。
    lxServed.add(identity.audio);
    return {
      url: audio.toString(), type: guess || (type === "flac" ? "flac" : "mp3"), size: 0, bitRate: type === "flac" ? 1000 : type === "320k" ? 320 : 128,
      quality: type === "flac" ? "lossless" : type === "128k" ? "standard" : "high",
      gain: 0, peak: 0, headers: { "User-Agent": UA },
    };
  }
  throw fail("unavailable", `自定义音源都没有拿到音频：${failures.join("；").slice(0, 200)}`);
}

export async function browseSources() {
  const list = lxStoreList();
  const add = { title: "添加音源", subtitle: "粘贴脚本链接、本地路径或内联脚本", page: "source-add", imageUrl: lxAddCover() };
  if (!list.length) {
    return {
      title: "自定义音源", subtitle: "洛雪音乐（LX Music）格式的音源脚本",
      description: "还没有音源。点下面的「添加音源」，把脚本的 https:// 链接、本机文件路径（如 C:\\音源.js）"
        + "或 data: 内联脚本贴进去；要加多个就一行一个。\n"
        + "网易云自己有完整音源时不会用到它，只有放不了歌时才向它要音频。",
      sections: [{ title: "还没有添加音源", links: [add] }],
    };
  }
  const loaded = await lxSourcesNow();
  // 宿主的页面只在页头显示 description，section 只认 title，所以每个脚本的
  // 详情并到页面描述里。
  const details = loaded.map((runtime) => {
    const info = runtime.info || {};
    if (!runtime.ready) {
      return `${info.name || "音源"}：没能加载 —— ${String(runtime.error?.message || runtime.error || "脚本没有上报 inited")}`.slice(0, 300);
    }
    const list = LX_SOURCE_KEYS.filter((key) => runtime.sources[key]).map((key) => {
      const names = { wy: "网易云", kw: "酷我", kg: "酷狗", tx: "QQ 音乐", mg: "咪咕", local: "本地" };
      const qualities = (runtime.sources[key].qualitys || []).join(" / ") || "无";
      return `${names[key] || key}：${qualities}`;
    });
    const version = [info.version && `v${info.version}`, info.author].filter(Boolean).join(" · ");
    return [
      `${info.name}${version ? `（${version}）` : ""}`,
      info.description,
      list.length ? `支持的源：${list.join("；")}` : "没有声明任何源",
      lxUsable(runtime) ? "" : "没有「网易云」源，不会用来补网易云的歌。",
    ].filter(Boolean).join("\n");
  });
  return {
    title: "自定义音源",
    subtitle: `${loaded.filter(lxUsable).length} / ${loaded.length} 个可用于网易云`,
    description: details.join("\n\n") + "\n\n点每张卡片可以启用、停用或删除这个音源。",
    sections: [
      { title: "音源", links: loaded.map((runtime, index) => lxSourceLink(runtime, list[index])) },
      { title: "添加", links: [add] },
    ],
  };
}

function lxSourceLink(runtime, item) {
  const info = runtime?.info || {};
  const name = info.name || "音源";
  const on = item?.enabled !== false;
  const state = on ? (lxUsable(runtime) ? "已启用" : "已启用，但没有网易云源") : "已停用";
  return {
    title: name,
    subtitle: `${state} · 点开可启用、停用或删除`,
    page: `source:${item?.id || ""}`,
  };
}

// 添加卡片的配图：用网易云公开推荐歌单的封面，取不到就留空。
function lxAddCover() {
  return discoveryCovers?.[0] || "";
}

async function lxSourcePage(id, action) {
  const list = lxStoreList();
  const before = list.find((one) => one.id === id);
  if (!before) return browseSources();
  if (action === "toggle") {
    lxSaveList(list.map((one) => one.id === id ? { ...one, enabled: one.enabled === false } : one));
  } else if (action === "delete") {
    lxIgnore(before.entry);
    lxSaveList(list.filter((one) => one.id !== id));
    return browseSources();
  } else if (action === "retry") {
    lxSources = null;
    lxLoading = null;
    lxScriptText.clear();
  }
  // 切换、删除之后要用改过的这一条，不能再用操作前的快照。
  const item = lxStoreList().find((one) => one.id === id) || before;
  const loaded = await lxSourcesNow();
  const runtime = loaded.find((one) => one.entry === item.entry) || { info: {}, ready: false, sources: null };
  const info = runtime.info || {};
  const on = item.enabled !== false;
  const lines = [];
  if (info.name) lines.push(`${info.name}${info.version ? `（v${info.version}）` : ""}${info.author ? ` · ${info.author}` : ""}`);
  lines.push(item.entry);
  if (!on) lines.push("这个音源已停用，不会参与取流。");
  else if (!runtime.ready) lines.push(`没能加载：${String(runtime.error?.message || "脚本没有上报 inited")}`);
  else if (!lxUsable(runtime)) lines.push("这个脚本没有「网易云」源，不会用来补网易云的歌。");
  else lines.push("已启用，网易云放不了歌时会向它要音频。");
  return {
    title: info.name || "音源",
    subtitle: on ? "已启用" : "已停用",
    description: lines.join("\n"),
    sections: [{
      title: "操作",
      links: [
        { title: on ? "停用" : "启用", subtitle: on ? "不再用它补歌" : "重新参与补歌", page: `source:${id}:toggle` },
        { title: "重新加载", subtitle: "改过脚本文件后读一遍", page: `source:${id}:retry` },
        { title: "删除", subtitle: "从列表里移除这个音源", page: `source:${id}:delete` },
        { title: "返回列表", subtitle: "查看全部音源", page: "sources" },
      ],
    }],
  };
}

export function setSetting({ key } = {}) {
  if (key && key !== "customSource") return;
  lxSettingCache = null;
  // 设置框里的新脚本要能立刻并进列表，所以列表缓存也要作废。
  lxListCache = null;
  lxSources = null;
  lxLoading = null;
  lxScriptText.clear();
}

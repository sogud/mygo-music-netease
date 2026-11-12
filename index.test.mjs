import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

let sequence = 0;
const response = (body, cookies = []) => ({
  ok: true, status: 200, json: async () => body, headers: { getSetCookie: () => cookies },
});

async function setup(handler, savedSession) {
  const storage = new Map(savedSession ? [["session", structuredClone(savedSession)]] : []);
  const prompts = [];
  const storageReads = [];
  globalThis.host = {
    storage: { get: (k) => { storageReads.push(k); return storage.get(k); }, set: (k, v) => storage.set(k, structuredClone(v)), remove: (k) => storage.delete(k) },
    crypto: {
      md5: (text) => createHash("md5").update(text).digest("hex"),
      aesEcbEncrypt: (key, text) => {
        const c = createCipheriv("aes-128-ecb", key, null);
        return Buffer.concat([c.update(text, "utf8"), c.final()]).toString("hex");
      },
    },
    signInPrompt: (prompt) => prompts.push(prompt),
  };
  globalThis.fetch = handler;
  const plugin = await import(`./index.js?test=${++sequence}`);
  return { plugin, storage, prompts, storageReads };
}

function decode(body) {
  const encrypted = new URLSearchParams(body).get("params");
  const c = createDecipheriv("aes-128-ecb", "e82ckenh8dichen8", null);
  const text = Buffer.concat([c.update(Buffer.from(encrypted, "hex")), c.final()]).toString();
  const [path, json, digest] = text.split("-36cd479b6b5-");
  assert.equal(digest, createHash("md5").update(`nobody${path}use${json}md5forencrypt`).digest("hex"));
  return { path, data: JSON.parse(json) };
}

const song = (id) => ({ id, name: `Song ${id}`, ar: [{ id: 5, name: "Artist" }], al: { id: 6, name: "Album" }, dt: 180000, fee: 1 });

// Each public search mapping must expose a template, not the full original or
// a fixed small picture that would also be used in Now Playing.
test("search provides sized artwork for tracks, albums, artists, playlists and shows", async () => {
  const picture = "http://p1.music.126.net/fixture.jpg";
  const track = { ...song(1), al: { id: 6, picUrl: picture }, ar: [{ id: 5, img1v1Url: picture }] };
  for (const [kind, key, item] of [
    ["tracks", "songs", track], ["albums", "albums", { id: 6, picUrl: picture }],
    ["artists", "artists", { id: 5, img1v1Url: picture }],
    ["playlists", "playlists", { id: 9, coverImgUrl: picture }],
    ["shows", "djRadios", { id: 8, picUrl: picture }],
  ]) {
    const { plugin } = await setup(async (url) => url.includes("cloudsearch")
      ? response({ code: 200, result: { [key]: [item] } })
      : response({ code: 200, songs: [track], privileges: [] }));
    const record = (await plugin.search({ query: "fixture", kind }))[kind][0];
    const images = kind === "tracks" ? [record.album.imageUrl, record.artists[0].imageUrl] : [record.imageUrl];
    for (const image of images) {
      const url = new URL(image);
      assert.equal(url.protocol, "https:", kind);
      assert.equal(url.searchParams.get("param"), "{size}y{size}", kind);
    }
  }
});

// Only the image CDN understands param; existing query values, fragments and
// non-CDN URLs must survive without redirecting their requests to another host.
test("artwork templates preserve query values and leave other URLs alone", async () => {
  const source = "https://p12.music.126.net/cover.jpg?quality=90&param=200y200&version=v2&param=800y800&label=a%20b&token=a%2Fb#cover";
  const unchanged = [
    "https://images.example/cover.jpg?param=200y200",
    "https://p1.music.126.net.example/cover.jpg",
    "https://m1.music.126.net/cover.jpg",
    "https://p1.music.126.net:8443/cover.jpg",
    "https://user:password@p1.music.126.net/cover.jpg",
    "file:///tmp/cover.jpg", "data:image/png;base64,fixture", "not a URL",
  ];
  const { plugin } = await setup(async () => response({ code: 200, result: {
    albums: [source, ...unchanged, "http://images.example/cover.jpg", "", null].map((picUrl, id) => ({ id, picUrl })),
  } }));
  const albums = (await plugin.search({ query: "fixture", kind: "albums" })).albums;
  const url = new URL(albums[0].imageUrl);
  assert.deepEqual(url.searchParams.getAll("param"), ["{size}y{size}"]);
  assert.equal(url.searchParams.get("quality"), "90");
  assert.equal(url.searchParams.get("version"), "v2");
  assert.equal(url.searchParams.get("label"), "a b");
  assert.equal(url.searchParams.get("token"), "a/b");
  assert.equal(url.hash, "#cover");
  assert.deepEqual(albums.slice(1, 1 + unchanged.length).map(album => album.imageUrl), unchanged);
  assert.deepEqual(albums.slice(-3).map(album => album.imageUrl), ["https://images.example/cover.jpg", "", ""]);
});

// Podcast episodes can have their own cover or fall back to their show; both
// routes need the same size contract as albums and playlist artwork.
test("podcast covers and episode fallbacks use sized artwork", async () => {
  const showPicture = "https://p2.music.126.net/show.jpg";
  const episodePicture = "https://p3.music.126.net/episode.jpg";
  const { plugin } = await setup(async (url) => url.includes("djradio/v2/get")
    ? response({ code: 200, data: { id: 8, picUrl: showPicture } })
    : response({ code: 200, programs: [
      { id: 1, coverUrl: episodePicture, mainSong: { id: 11 } },
      { id: 2, mainSong: { id: 12 } },
    ] }));
  const page = await plugin.show({ id: "8" });
  const covers = [page.show.imageUrl, ...page.episodes.map(episode => episode.album.imageUrl)];
  assert.deepEqual(covers.map(cover => new URL(cover).pathname), ["/show.jpg", "/episode.jpg", "/show.jpg"]);
  assert.ok(covers.every(cover => new URL(cover).searchParams.get("param") === "{size}y{size}"));
});

// Account and comment avatars pass through the host's image loader too.
test("account and comment avatars use the same artwork size contract", async () => {
  const picture = "https://p4.music.126.net/avatar.jpg";
  const { plugin } = await setup(async (url) => url.includes("account/get")
    ? response({ code: 200, profile: { userId: 8, nickname: "Fixture", avatarUrl: picture } })
    : response({ code: 200, comments: [{ commentId: 9, user: { nickname: "Fixture", avatarUrl: picture } }] }),
  { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const account = await plugin.account();
  const page = await plugin.comments({ trackId: "1" });
  assert.equal(new URL(account.imageUrl).searchParams.get("param"), "{size}y{size}");
  assert.equal(new URL(page.comments[0].avatarUrl).searchParams.get("param"), "{size}y{size}");
});

// MyGo 0.1.6 holds its mutex while importing: top-level storage calls deadlock.
test("module initialization defers host storage until an action", async () => {
  const { plugin, storageReads } = await setup(async () => response({ code: 200 }));
  assert.deepEqual(storageReads, []);
  assert.equal(await plugin.account(), null);
  assert.deepEqual(storageReads, ["session"]);
});

// Details may return IDs in another order and correct search's stale privileges.
test("search preserves order, pages, and uses the account's detail privileges", async () => {
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("cloudsearch")) {
      assert.equal(new URL(url).searchParams.get("offset"), "30");
      return response({ code: 200, result: { songs: [song(1), song(2)], songCount: 90 } });
    }
    const { path, data } = decode(init.body);
    assert.equal(path, "/api/v3/song/detail");
    assert.deepEqual(JSON.parse(data.c), [{ id: 1 }, { id: 2 }]);
    return response({ code: 200, songs: [song(2), song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }, { id: 2, st: 0, pl: 0 }] });
  });
  const result = await plugin.search({ query: "song", offset: 30 });
  assert.deepEqual(result.tracks.map((t) => [t.id, t.unavailable]), [["1", false], ["2", true]]);
  assert.equal(result.more, true);
});

// A playlist can contain only a preview of the actual track list.
test("playlist resolves trackIds beyond the preview and retains their order", async () => {
  const { plugin } = await setup(async (url) => url.includes("playlist/detail")
    ? response({ code: 200, playlist: { id: 9, name: "List", trackCount: 3, tracks: [song(3)], trackIds: [{ id: 3 }, { id: 2 }, { id: 1 }] } })
    : response({ code: 200, songs: [song(1), song(2), song(3)], privileges: [] }));
  assert.deepEqual((await plugin.playlist({ id: "9" })).tracks.map((t) => t.id), ["3", "2", "1"]);
});

// Previews and missing authorization must not be represented as full playback.
test("stream rejects previews, unavailable tracks and unexpected download hosts", async () => {
  for (const audio of [
    { id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: { start: 0, end: 30 } },
    { id: 1, url: null, code: 404 },
    { id: 1, url: "https://unexpected.example/song.mp3" },
  ]) {
    const { plugin } = await setup(async () => response({ code: 200, data: [audio] }));
    await assert.rejects(plugin.stream({ id: "1" }), { code: "unavailable" });
  }
});

// Host quality names differ from NetEase's; CDN requests must never get cookies.
test("stream maps quality and keeps the session away from the CDN", async () => {
  const { plugin } = await setup(async (_url, init) => {
    const { data } = decode(init.body);
    assert.equal(data.level, "exhigh");
    assert.equal(data.header.MUSIC_U, "synthetic-session");
    return response({ code: 200, data: [{ id: 1, code: 200, url: "http://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123", type: "mp3", level: "exhigh", size: 100, freeTrialInfo: null }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const audio = await plugin.stream({ id: "1", quality: "high" });
  assert.equal(audio.url, "https://m1.music.126.net/song.mp3?token=audio%2Ftoken&expires=123");
  assert.equal(audio.quality, "high");
  assert.equal(audio.headers.Cookie, undefined);
});

// A late account response after sign-out must not resurrect persisted credentials.
test("sign-out wins over an in-flight account request", async () => {
  let finish;
  const { plugin, storage } = await setup(() => new Promise((resolve) => { finish = resolve; }), {
    cookies: { MUSIC_U: "synthetic-session" }, profile: null,
  });
  const pending = plugin.account();
  plugin.signOut();
  finish(response({ code: 200, profile: { userId: 8, nickname: "Fixture" } }));
  await assert.rejects(pending);
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
});

// A QR confirmation persists only accepted session cookies, not response metadata.
test("QR sign-in stores an approved session, restores it, then removes it on sign-out", async () => {
  const { plugin, storage, prompts } = await setup(async (url, init) => {
    if (url.includes("unikey")) return response({ code: 200, unikey: "synthetic-qr" });
    if (url.includes("qrcode/client/login")) return response({ code: 803 }, [
      "MUSIC_U=synthetic-session; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/; HttpOnly",
      "__csrf=synthetic-csrf; Path=/", "unrelated=ignored; Path=/",
    ]);
    assert.equal(init.headers.Cookie, "MUSIC_U=synthetic-session; __csrf=synthetic-csrf");
    return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
  });
  assert.equal((await plugin.signIn()).id, "8");
  assert.equal(prompts.some((p) => !!p.qr), true);
  assert.deepEqual(Object.keys(storage.get("session").cookies).sort(), ["MUSIC_U", "__csrf"]);
  assert.equal((await plugin.account()).name, "Fixture");
  plugin.signOut();
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
});

// Expired credentials must lead to a sign-in prompt instead of endless retries.
test("expired session is cleared; guest private actions require sign-in", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 301 }), {
    cookies: { MUSIC_U: "synthetic-session" }, profile: null,
  });
  assert.equal(await plugin.account(), null);
  assert.equal(storage.has("session"), false);
  await assert.rejects(plugin.like({ id: "1", on: true }), { code: "signIn" });
  await assert.rejects(plugin.liked({ offset: 0 }), { code: "signIn" });
  assert.deepEqual(await plugin.playlists(), []);
});

// Missing details must still consume a slot in the host's offset-based pages.
test("search and liked keep missing IDs across partial and empty detail pages", async () => {
  const all = Array.from({ length: 60 }, (_, i) => i + 1);
  for (const kind of ["search", "liked"]) {
    for (const missingAll of [false, true]) {
      const offsets = [];
      const { plugin } = await setup(async (url, init) => {
        if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
        if (url.includes("cloudsearch")) {
          const offset = Number(new URL(url).searchParams.get("offset"));
          offsets.push(offset);
          return response({ code: 200, result: { songs: all.slice(offset, offset + 30).map(song), songCount: 60 } });
        }
        const { path, data } = decode(init.body);
        if (path === "/api/song/like/get") return response({ code: 200, ids: all });
        assert.equal(path, "/api/v3/song/detail");
        const ids = JSON.parse(data.c).map(x => x.id);
        const present = ids.filter(id => missingAll ? id > 30 : id !== 1);
        return response({ code: 200, songs: present.map(song), privileges: present.map(id => ({ id, st: 0, pl: 320000 })) });
      }, kind === "liked" ? { cookies: { MUSIC_U: "synthetic-session" }, profile: null } : undefined);
      const page = offset => kind === "search" ? plugin.search({ query: "song", offset }) : plugin.liked({ offset });
      const first = await page(0);
      assert.equal(first.tracks.length, 30);
      assert.equal(first.more, true);
      assert.equal(first.tracks[0].id, "1");
      assert.equal(first.tracks[0].unavailable, true);
      if (kind === "search") assert.equal(first.tracks[0].name, "Song 1");
      if (missingAll) assert.ok(first.tracks.every(track => track.unavailable));
      const second = await page(first.tracks.length);
      assert.equal(second.more, false);
      assert.deepEqual([...first.tracks, ...second.tracks].map(track => track.id), all.map(String));
      if (kind === "search") assert.deepEqual(offsets, [0, 30]);
    }
  }
});

// A successful response can revoke a session through Set-Cookie, not only code 301.
test("server cookie deletion clears persisted state and cannot return after reload", async () => {
  for (const cookie of [
    "MUSIC_U=deleted; Max-Age=0; Path=/",
    "MUSIC_U=deleted; Max-Age=-1; Path=/",
    "MUSIC_U=; Path=/",
    "MUSIC_U=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
  ]) {
    const { plugin, storage } = await setup(async () => response({ code: 200, result: [] }, [cookie]), {
      cookies: { MUSIC_U: "synthetic-old-session" }, profile: { id: "8", name: "Fixture" },
    });
    await assert.rejects(plugin.home(), { code: "signIn" });
    assert.equal(storage.has("session"), false);
    assert.equal(await plugin.account(), null);
    const restored = await setup(async (_url, init) => {
      assert.equal(init.headers.Cookie, undefined);
      return response({ code: 200, result: [] });
    }, storage.get("session"));
    await restored.plugin.home();
    assert.equal(await restored.plugin.account(), null);
  }
});

// A positive Max-Age overrides Expires and must persist the replacement cookie.
test("normal cookie renewal remains persisted", async () => {
  const { plugin, storage } = await setup(async () => response({ code: 200, result: [] }, [
    "MUSIC_U=synthetic-renewed; Max-Age=3600; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
  ]), { cookies: { MUSIC_U: "synthetic-old" }, profile: null });
  await plugin.home();
  assert.equal(storage.get("session").cookies.MUSIC_U, "synthetic-renewed");
});

// Concurrent requests share a single retry, using the same identity and quality.
test("stream recovers from one 460 without duplicating concurrent requests", async () => {
  for (const code of [460, -460]) {
    const requests = [];
    const { plugin } = await setup(async (_url, init) => {
      requests.push(decode(init.body).data);
      if (requests.length === 1) return response({ code });
      return response({ code: 200, data: [{ id: 1, code: 200, url: "https://m1.music.126.net/song.mp3", type: "mp3", freeTrialInfo: null }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    const [a, b] = await Promise.all([plugin.stream({ id: "1" }), plugin.stream({ id: "1" })]);
    assert.deepEqual(a, b);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].header.deviceId, requests[1].header.deviceId);
    assert.equal(requests[0].header.MUSIC_U, requests[1].header.MUSIC_U);
    assert.equal(requests[0].level, requests[1].level);
  }
});

// Persistent rejection stops after two attempts, and the failed promise isn't cached.
test("stream bounds persistent 460 retries and releases the in-flight entry", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => {
    calls++;
    if (calls <= 2) return response({ code: -460 });
    return response({ code: 200, data: [{ id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: null }] });
  });
  await assert.rejects(plugin.stream({ id: "1" }), /仍拒绝播放请求（-460）/);
  assert.equal(calls, 2);
  assert.equal((await plugin.stream({ id: "1" })).type, "mp3");
  assert.equal(calls, 3);
});

// Signing out during backoff must prevent the retry from using another session.
test("sign-out cancels a scheduled playback retry", async (t) => {
  const timer = globalThis.setTimeout;
  let wake;
  let scheduled;
  const queued = new Promise(resolve => { scheduled = resolve; });
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms === 1000) { wake = fn; scheduled(); return 0; }
    return timer(fn, ms, ...args);
  });
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: -460 }); });
  const playing = plugin.stream({ id: "1" });
  await queued;
  plugin.signOut();
  wake();
  await assert.rejects(playing, /账号状态已改变/);
  assert.equal(calls, 1);
});

// The retry must not turn permission errors or previews into playback successes.
test("stream does not retry expired authentication or trial audio", async () => {
  for (const body of [
    { code: 301 },
    { code: 200, data: [{ id: 1, url: "https://m1.music.126.net/song.mp3", freeTrialInfo: { start: 0, end: 30 } }] },
  ]) {
    let calls = 0;
    const { plugin } = await setup(async () => { calls++; return response(body); });
    await assert.rejects(plugin.stream({ id: "1" }));
    assert.equal(calls, 1);
  }
});

// Personal recommendations require a real session before making their requests.
test("guests can discover entries but private recommendations ask for sign-in", async () => {
  let calls = 0;
  const { plugin } = await setup(async () => { calls++; return response({ code: 200, result: [] }); });
  const home = await plugin.home();
  assert.ok(home.sections.some(section => section.links?.some(link => link.page === "daily")));
  const stations = await plugin.stations();
  assert.equal(stations.length, 3);
  assert.ok(stations.every(station => station.description.includes("个性化服务")));
  for (const page of ["daily", "radar", "recommendations"]) await assert.rejects(plugin.browse({ page }), { code: "signIn" });
  await assert.rejects(plugin.stationNext({ id: "DEFAULT" }), { code: "signIn" });
  assert.equal(calls, 1);
});

// Daily songs and each FM mode use their own endpoint and account-aware details.
test("daily, radar, personalized playlists and continuous FM map to host capabilities", async () => {
  const modes = [];
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
    if (url.includes("playlist/detail")) {
      assert.equal(new URL(url).searchParams.get("id"), "3136952023");
      assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
      return response({ code: 200, playlist: { id: 3136952023, name: "Fixture Radar", trackCount: 2, trackIds: [{ id: 2 }, { id: 1 }] } });
    }
    if (url.includes("recommend/songs")) return response({ code: 200, data: { dailySongs: [song(2), song(1)] } });
    if (url.includes("recommend/resource")) return response({ code: 200, recommend: [{ id: 9, name: "Fixture Radar", trackCount: 2 }] });
    const { path, data } = decode(init.body);
    assert.equal(data.header.MUSIC_U, "synthetic-session");
    if (path === "/api/v1/radio/get") {
      modes.push(data.mode);
      assert.equal(data.limit, 3);
      return response({ code: 200, data: [song(2), song(1)] });
    }
    assert.equal(path, "/api/v3/song/detail");
    return response({ code: 200, songs: [song(1), song(2)], privileges: [{ id: 1, st: 0, pl: 320000 }, { id: 2, st: 0, pl: 320000 }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const daily = await plugin.browse({ page: "daily" });
  assert.deepEqual(daily.sections[0].tracks.map(track => track.id), ["2", "1"]);
  assert.ok(daily.sections[0].tracks.every(track => !track.unavailable));
  const radar = await plugin.browse({ page: "radar" });
  assert.deepEqual(radar.sections[0].tracks.map(track => track.id), ["2", "1"]);
  const lists = await plugin.browse({ page: "recommendations" });
  assert.equal(lists.sections[0].playlists[0].id, "9");
  for (const id of ["DEFAULT", "FAMILIAR", "EXPLORE", "DEFAULT"]) {
    assert.deepEqual((await plugin.stationNext({ id })).map(track => track.id), ["2", "1"]);
  }
  assert.deepEqual(modes, ["DEFAULT", "FAMILIAR", "EXPLORE", "DEFAULT"]);
  await assert.rejects(plugin.stationNext({ id: "unknown" }), { code: "unsupported" });
});

test("disabled personalization explains an empty radio batch and permits recovery", async () => {
  for (const mode of ["DEFAULT", "FAMILIAR", "EXPLORE"]) {
    let radioCalls = 0;
    let detailCalls = 0;
    let settingsCalls = 0;
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) {
        settingsCalls++;
        assert.match(init.headers.Cookie, /MUSIC_U=synthetic-session/);
        return response({ code: 200, setting: { personalServiceSetting: 2 } });
      }
      const { path, data } = decode(init.body);
      if (path === "/api/v1/radio/get") {
        assert.equal(data.mode, mode);
        radioCalls++;
        return response({ code: 200, data: radioCalls === 1 ? [] : [song(1)] });
      }
      assert.equal(path, "/api/v3/song/detail");
      detailCalls++;
      return response({ code: 200, songs: [song(1)], privileges: [{ id: 1, st: 0, pl: 320000 }] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

    await assert.rejects(plugin.stationNext({ id: mode }), error => {
      assert.equal(error.code, "unavailable");
      assert.match(error.message, /个性化服务/);
      return true;
    });
    assert.equal(radioCalls, 1);
    assert.equal(detailCalls, 0);
    assert.equal(settingsCalls, 1);
    assert.notEqual(await plugin.account(), null);
    assert.deepEqual((await plugin.stationNext({ id: mode })).map(track => track.id), ["1"]);
    assert.equal(radioCalls, 2);
    assert.equal(detailCalls, 1);
    assert.equal(settingsCalls, 1);
  }
});

test("other empty radio batches remain retryable when the setting is enabled or unknown", async () => {
  for (const preferences of [
    { code: 200, setting: { personalServiceSetting: 0 } },
    { code: 200, setting: {} },
    { code: 500 },
  ]) {
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) return response(preferences);
      assert.equal(decode(init.body).path, "/api/v1/radio/get");
      return response({ code: 200, data: [] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    assert.deepEqual(await plugin.stationNext({ id: "DEFAULT" }), []);
    assert.notEqual(await plugin.account(), null);
  }
});

test("radio and diagnostic authentication failures keep their sign-in error", async () => {
  for (const failingEndpoint of ["radio", "settings"]) {
    const { plugin } = await setup(async (url, init) => {
      if (url.includes("account/get")) return response({ code: 200, profile: { userId: 8, nickname: "Fixture" } });
      if (url.includes("/user/setting")) return response({ code: 301 });
      assert.equal(decode(init.body).path, "/api/v1/radio/get");
      return response(failingEndpoint === "radio" ? { code: 301 } : { code: 200, data: [] });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });

    await assert.rejects(plugin.stationNext({ id: "DEFAULT" }), { code: "signIn" });
    assert.equal(await plugin.account(), null);
  }
});

// The host must recognize NetEase's built-in liked playlist without losing ownership.
test("fixed playlist mapping preserves ownership across lists and detail", async () => {
  const fixtures = [
    { id: 21, specialType: 5, creator: { userId: 7 }, expectedFixed: true, expectedMine: true },
    { id: 22, specialType: "5", creator: { userId: 8 }, subscribed: true, expectedFixed: true, expectedMine: false },
    { id: 23, specialType: 0, creator: { userId: 7 }, expectedFixed: false, expectedMine: true },
    { id: 24, creator: { userId: 8 }, subscribed: true, expectedFixed: false, expectedMine: false },
  ];
  const { plugin } = await setup(async (url) => {
    if (url.includes("nuser/account/get")) return response({ code: 200, profile: { userId: 7, nickname: "Fixture" } });
    if (url.includes("user/playlist")) return response({ code: 200, playlist: fixtures, more: false });
    if (url.includes("playlist/detail")) {
      const id = Number(new URL(url).searchParams.get("id"));
      return response({ code: 200, playlist: { ...fixtures.find(p => p.id === id), trackIds: [] } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: { id: "7", name: "Fixture" } });
  const lists = await plugin.playlists();
  assert.equal(lists.length, fixtures.length);
  for (const [i, source] of fixtures.entries()) {
    for (const mapped of [lists[i], await plugin.playlist({ id: String(source.id) })]) {
      assert.equal(mapped.fixed, source.expectedFixed, `fixed for ${source.id}`);
      assert.equal(mapped.mine, source.expectedMine, `mine for ${source.id}`);
      assert.equal(mapped.saved, !!source.subscribed, `saved for ${source.id}`);
    }
  }
});

// Word-timed lyrics come only from the desktop endpoint, and only signed in.
test("lyrics return word-timed lines for a signed-in listener without touching the web endpoint", async () => {
  let sawWeb = false;
  const { plugin } = await setup(async (url, init) => {
    if (url.includes("/eapi/")) {
      const { path, data } = decode(init.body);
      assert.equal(path, "/api/song/lyric/v1");
      assert.equal(data.header.MUSIC_U, "synthetic-session");
      return response({
        code: 200,
        lrc: { lyric: "[00:01.00]hello world" },
        tlyric: { lyric: "[00:01.00]你好世界" },
        yrc: { lyric: "[1000,3000](1000,500,0)he(1500,500,0)llo(2000,1000,0) world" },
        ytlrc: { lyric: "[00:01.000]你好，世界" },
      });
    }
    sawWeb = true;
    return response({ code: 200, lrc: { lyric: "" }, tlyric: { lyric: "" } });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const result = await plugin.lyrics({ id: "1" });
  assert.equal(sawWeb, false);
  const [line] = result.lines;
  assert.equal(line.start, 1000);
  assert.equal(line.end, 4000);
  assert.equal(line.text, "hello world");
  assert.equal(line.translation, "你好，世界");
  assert.deepEqual(line.words.map((word) => [word.start, word.end, word.text]), [
    [1000, 1500, "he"], [1500, 2000, "llo"], [2000, 3000, " world"],
  ]);
});

// No yrc in the answer, plain LRC stands, still without the web round trip.
test("lyrics fall back to the desktop endpoint's plain LRC when it has no yrc", async () => {
  const { plugin } = await setup(async (_url, init) => {
    const { path } = decode(init.body);
    assert.equal(path, "/api/song/lyric/v1");
    return response({ code: 200, lrc: { lyric: "[00:01.00]plain" }, tlyric: { lyric: "[00:01.00]纯文本" } });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const result = await plugin.lyrics({ id: "1" });
  assert.equal(result.lines, undefined);
  assert.equal(result.lrc, "[00:01.00]plain");
  assert.equal(result.translation, "[00:01.00]纯文本");
});

// Signed out, the web endpoint answers and the desktop one stays fallback.
test("lyrics ask the web endpoint first when signed out, then the desktop endpoint if empty", async () => {
  const web = { lrc: { lyric: "[00:01.00]web line" }, tlyric: { lyric: "[00:01.00]网页歌词" } };
  const { plugin } = await setup(async (url) => {
    assert.ok(!url.includes("/eapi/"));
    return response({ code: 200, ...web });
  });
  const result = await plugin.lyrics({ id: "1" });
  assert.equal(result.lrc, "[00:01.00]web line");
  assert.equal(result.translation, "[00:01.00]网页歌词");

  const { plugin: fallback } = await setup(async (url, init) => {
    if (url.includes("/eapi/")) {
      const { path, data } = decode(init.body);
      assert.equal(path, "/api/song/lyric/v1");
      assert.equal(data.header.MUSIC_U, undefined);
      return response({ code: 200, lrc: { lyric: "[00:02.00]desktop line" }, tlyric: { lyric: "[00:02.00]桌面歌词" } });
    }
    return response({ code: 200, lrc: { lyric: "" }, tlyric: { lyric: "" } });
  });
  const empty = await fallback.lyrics({ id: "1" });
  assert.equal(empty.lrc, "[00:02.00]desktop line");
});

// A desktop service failure must not hide usable web lyrics.
test("lyrics regression: desktop non-auth failure falls back to web", async () => {
  for (const failure of ["network", "business"]) {
    const calls = [];
    const { plugin } = await setup(async (url) => {
      calls.push(url.includes("/eapi/") ? "desktop" : "web");
      if (url.includes("/eapi/")) {
        if (failure === "network") throw new Error("synthetic transport failure");
        return response({ code: 500 });
      }
      return response({ code: 200, lrc: { lyric: "[00:01.00]web original" }, tlyric: { lyric: "[00:01.00]网页翻译" } });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    assert.deepEqual(await plugin.lyrics({ id: "1" }), { lrc: "[00:01.00]web original", translation: "[00:01.00]网页翻译" });
    assert.deepEqual(calls, ["desktop", "web"]);
  }
});

// Web translation can be present even when only desktop has original lyrics.
test("lyrics regression: preserves web translation with desktop original", async () => {
  for (const yrc of [undefined, { lyric: "[1000,1000](1000,1000,0)original" }]) {
    const calls = [];
    const { plugin } = await setup(async (url) => {
      const desktop = url.includes("/eapi/");
      calls.push(desktop ? "desktop" : "web");
      return response(desktop
        ? { code: 200, lrc: { lyric: "[00:01.00]original" }, yrc }
        : { code: 200, lrc: { lyric: "" }, tlyric: { lyric: "[00:01.00]网页翻译" } });
    });
    const answer = await plugin.lyrics({ id: "1" });
    assert.equal(answer.lrc, "[00:01.00]original");
    assert.equal(answer.translation, "[00:01.00]网页翻译");
    if (yrc) assert.equal(answer.lines[0].translation, "网页翻译");
    assert.deepEqual(calls, ["web", "desktop"]);
  }
});

test("lyrics fallback never hides expired authentication or retries failed desktop", async () => {
  for (const code of [301, 500]) {
    let calls = 0;
    const { plugin } = await setup(async (url) => {
      calls++;
      return response(url.includes("/eapi/") ? { code } : { code: 200, lrc: { lyric: "" } });
    }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
    await assert.rejects(plugin.lyrics({ id: "1" }), code === 301 ? { code: "signIn" } : /500/);
    assert.equal(calls, code === 301 ? 1 : 2);
  }
});

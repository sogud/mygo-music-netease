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
    return response({ code: 200, data: [{ id: 1, code: 200, url: "http://m1.music.126.net/song.mp3", type: "mp3", level: "exhigh", size: 100, freeTrialInfo: null }] });
  }, { cookies: { MUSIC_U: "synthetic-session" }, profile: null });
  const audio = await plugin.stream({ id: "1", quality: "high" });
  assert.equal(audio.url, "https://m1.music.126.net/song.mp3");
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
  assert.equal((await plugin.stations()).length, 3);
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

// One overlapping page must not discard later subscriptions; repeated nonprogress stays bounded.
test("podcast pagination advances past one duplicate page but rejects a stalled feed", async () => {
  for (const stalled of [false, true]) {
    const offsets = [];
    const { plugin } = await setup(async (url) => {
      if (url.includes('account/get')) return response({ code: 200, profile: { userId: 8, nickname: 'Fixture' } });
      offsets.push(Number(new URL(url).searchParams.get('offset')));
      const i = offsets.length - 1;
      return response({ code: 200, djRadios: [{ id: !stalled && i === 2 ? 2 : 1 }], hasMore: stalled || i < 2 });
    }, { cookies: { MUSIC_U: 'synthetic-session' }, profile: null });
    if (stalled) {
      await assert.rejects(plugin.shows(), /完整的播客订阅列表/);
      assert.equal(offsets.length, 3);
    } else {
      assert.deepEqual((await plugin.shows()).map(x => x.id), ['1', '2']);
      assert.deepEqual(offsets, [0, 1, 2]);
    }
  }
});

// A response started before a successful like/unlike must not restore the old cache.
test("late liked-list reads cannot overwrite a successful like or unlike", async () => {
  for (const on of [true, false]) {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    let reads = 0;
    const { plugin } = await setup(async (url, init) => {
      if (url.includes('account/get')) return response({ code: 200, profile: { userId: 8, nickname: 'Fixture' } });
      const { path } = decode(init.body);
      if (path === '/api/radio/like') return response({ code: 200 });
      assert.equal(path, '/api/song/like/get');
      reads++;
      if (reads === 1) {
        started();
        return new Promise(resolve => { release = () => resolve(response({ code: 200, ids: on ? [] : [1] })); });
      }
      return response({ code: 200, ids: on ? [1] : [] });
    }, { cookies: { MUSIC_U: 'synthetic-session' }, profile: null });
    const pending = plugin.isLiked({ ids: ['1'] });
    await ready;
    await plugin.like({ id: '1', on });
    release();
    await assert.rejects(pending, /喜欢状态已更新/);
    assert.deepEqual(await plugin.isLiked({ ids: ['1'] }), { '1': on });
    assert.equal(reads, 2);
  }
});

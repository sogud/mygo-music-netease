# TODO

- [x] 2026-11-07 01:57 +0800 · Codex（ChatGPT 委派 / Mac mini）· 用户授权发布后已推送 93e9a4e 并公开发布 v0.1.1，附 netease-0.1.1.zip；语法检查、17 项测试及包清单核对通过，GitHub 资产 SHA-256 与本地一致。发布链接：https://github.com/sogud/mygo-music-netease/releases/tag/v0.1.1 。未操作 issues，汽水保持暂停；本机已安装的 local.2 与发布版功能代码一致，-460 仍仅缓解。

- [x] 2026-11-07 01:54 +0800 · Codex（ChatGPT 委派 / Mac mini）· 修复发现页六个入口未提供 imageUrl 的问题：使用公开推荐歌单封面配图，漫游列表可独立加载封面；更新 index.js、现有异步测试及版本清单。已安装 local.2 到正式 MyGo Music 0.1.6，实际窗口确认六张封面显示，原登录数据保留；访客 moejs 与相关测试通过。按用户“发一版本”准备 0.1.1，远端 main 无新增差异。

- [x] 2026-11-07 01:48 +0800 · Codex（ChatGPT 委派 / Mac mini）· 按“安装下”将 `plugin.json` 标为 `0.1.1-local.1`，备份旧代码至 `tmp/mygo-music-verification/netease-before-local-fix.zip`，安装 5 个发布文件到 `~/Library/Application Support/MyGo Music/plugins/netease/`；逐文件确认与源码相同，plugin-data 文件元数据未改变。重启正式 MyGo Music 0.1.6，窗口确认新导航及首页入口可见、已有登录和歌单保留；已安装代码在隔离访客 moejs 中返回 24 个公开歌单，3 种漫游与全部私人页面登录门控通过。未操作个人推荐或播放；-460 仍仅缓解。未安装汽水、提交、推送或发布。

- [x] 2026-11-07 01:45 +0800 · Codex（ChatGPT 委派 / Mac mini）· 补查 #1：旧 Go 客户端与插件使用相同 player/url/v1 接口及音质参数；访客探针中 413829859（详情 st=0/pl=320000）在原版和修复版均恢复完整 MP3；1855204126（st=-200/pl=0）首次 HTTP 200/code=-460，一次延迟重试后返回音频 code=404/无 URL，插件正确拒绝播放。证实 -460 可为暂时拒绝，尚不能确定服务端具体触发规则或宣称根治。探针 `tmp/mygo-music-verification/netease-460-probe.mjs` 仅使用内存访客状态、输出允许的错误和权限字段。补验 #2 真实 moejs：首页 3 个推荐入口、3 种漫游、24 个公开歌单；日推/雷达/个性化歌单及全部 3 种漫游的访客登录门控通过。未改生产代码、读取真实凭据或推送发布；已登录内容仍待用户扫码验收。

- [x] 2026-11-07 01:39 +0800 · Codex（ChatGPT 委派 / Mac mini）· 按更正后的任务修复 `index.js`、`index.test.mjs`、`plugin.json`，同步 README 和许可参考：#3 保留缺失详情占位，#4 同步清除过期持久会话；两项原版回归失败、修复版通过。#2 加入每日推荐、私人雷达、个性化歌单和 DEFAULT/FAMILIAR/EXPLORE 漫游。语法检查与 17 项测试通过；真实 moejs 菜单、三种漫游声明及访客登录门控通过。保留原有 TODO 改动，未提交、推送、发布、安装或操作 issues；汽水仍暂停。
- [ ] 2026-11-07 01:39 +0800 · Codex（ChatGPT 委派 / Mac mini）· #1 已复现服务端 -460，新增同账号同音质的一次延迟重试、并发请求合并及持续拒绝提示；真实 moejs 中歌曲 3431158072 返回 MP3，413829859 重试后仍被拒绝，不能标为彻底解决。#2 已用网易云公开响应确认私人雷达入口 3136952023，但日推/雷达/漫游的已登录个性化内容仍待账号验收；未读取真实凭据。验证工具及原版回归对照留在 `tmp/mygo-music-verification/verify_netease_revision.go`、`netease-regression-baseline.test.mjs`。

- [x] 2026-11-07 01:25 +0800 - Codex (ChatGPT delegation / Mac mini): Read-only review of published commit 302aaf4 and host pagination; existing 8 tests passed. Created nonduplicate issues #3 (missing details desynchronize pagination) and #4 (server cookie deletion leaves persisted session). Both explicitly distinguish static evidence from live-account verification. Source/test files unchanged; Qishui remains paused. Links: https://github.com/sogud/mygo-music-netease/issues/3 and https://github.com/sogud/mygo-music-netease/issues/4.

- [x] 2026-11-06 22:54 +08:00 · Codex（ChatGPT / Mac mini）· 为公开仓库 `sogud/mygo-music-netease` 添加 `mygo-music-plugin` 话题；GitHub API 已确认话题和 PUBLIC 状态，插件目录收录尚未确认。

- [x] 2026-11-06 14:53 UTC · Codex（ChatGPT 委派 / Mac mini）· 按用户后续要求公开发布 `sogud/mygo-music-netease` 与 `v0.1.0` ZIP；按用户要求简化 `README.md` 和 Release 说明，移除“来源与限制”章节。保留许可证及独立署名文件。

- [x] 2026-11-06 14:47 UTC · Codex（ChatGPT 委派 / Mac mini）· 新增 `index.js`、`plugin.json`，移植搜索、歌单、歌词、扫码登录、喜欢列表及授权播放；新增 `index.test.mjs`、`pack.py`、README、AGPL 许可和来源说明。8 项测试及上游 `internal/plugin` 测试通过；真实 moejs 验证四类搜索、24 推荐歌单、65 榜单、59 首歌单、歌词、专辑、歌手 50 首/30 专辑、扫码生成及 HTTP 206 音频解码（48000 Hz）。
- [x] 2026-11-06 14:47 UTC · Codex（ChatGPT 委派 / Mac mini）· 官方 MyGo Music 0.1.6 已安装到 `/Applications/MyGo Music.app`，SHA-256 与官方发布值一致，签名和公证通过；插件 ZIP 通过宿主安装器安装到 `~/Library/Application Support/MyGo Music/plugins/netease/`，原生界面已显示推荐歌单和搜索结果。
- [ ] 2026-11-06 14:47 UTC · Codex（ChatGPT 委派 / Mac mini）· 用户扫码后的个人歌单、真实喜欢操作、VIP/无损播放权限和重启后的真实会话恢复仍需账号验收；未读取已有其他客户端凭据，未进行真实喜欢/取消喜欢写操作。

- [x] 2026-11-12 10:06 UTC · Codex（ChatGPT 委派 / Mac mini）· v0.1.9 独立修复候选：index.js 隔离扫码期间旧账号请求，喜欢与歌单显式绑定会话，区分响应解析失败与网络错误，保留 ±460 诊断代码；index.test.mjs 三项新增回归在 v0.1.8 失败、修复后通过，既有断言随新消息更新后23项通过；MyGo 0.1.22 实际 moejs 列表/喜欢检查通过。真实只读喜欢30首、播客13个成功，取流仍失败，登录文件未改；无真实换账号/UI验收，不声称解决460或重启红心。未混入待验收功能。

- [x] 2026-11-12 11:03 UTC · Codex（ChatGPT 委派 / Mac mini）· v0.1.10 独立格式修复：index.js 接受宿主已支持的 m4a/mp4/aac，plugin.json/README 要求MyGo>=0.1.21；权限/试听拒绝保留。专项旧版失败、修复后6项取流回归通过。真实云盘样本首次-460、同身份内置重试成功；M4A 1534152字节经内存由MyGo0.1.22原生解码器解码192512采样/48kHz并seek成功，未落盘音频或凭据。云盘页面未混入此包，#18完整功能与UI验收待完成。

- [x] 2026-11-12 11:08 UTC · Codex（ChatGPT 委派 / Mac mini）· v0.1.11在c82696f主线整合云盘分页入口、周/总榜及热评前置去重分页，并包含已合并逐字歌词/封面/漫游提示和v0.1.9–10修复。修改index.js/index.test.mjs/plugin.json/README；42项插件检查、moejs新页面/评论/歌词回退/喜欢播客检查、6项现有宿主自动界面测试通过。最终候选真实只读云盘两页60首、周22/总100、逐字475字/普通LRC回退、评论两页60唯一；此前相同取流函数云盘M4A原生解码及seek通过。用户桌面未目视验收，账号及本地插件未改；不声称修复460/重启红心或实现听歌次数列/时长上报。

- [x] 2026-11-12 11:16 UTC · Codex（ChatGPT 委派 / Mac mini）· #20真实小页复现offset0/5/10返回相同5条且hasMore=true，GET与POST相同。index.js 增加仅停滞时有界扩大首页恢复：真实limit10=>10、20=>13且hasMore=false，返回13唯一，登录文件未改。专项原版失败/修复通过，持续截断仍报错、上限2000；原分页及实际moejs列表/喜欢检查通过。v0.1.12仅此修复。最新上游0.1.24仅设置控件等变化，无新增队列/批量下载/时长回调；#19无新反馈，不操作代理。

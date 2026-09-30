# 架构

本文描述 dsh-boot-animation 在 0.3.0 起的结构。0.2.x 的问题不是"少几个判断"，
而是**没有单一数据源**：播放地址只有一个（`/boot.mp4`，含义是"当前 active 那个"），
片库、选择、预览、播放、缓存各自持有状态，没有任何一处能回答"此刻在播哪个 clip"。

本文件按十段说明现在的答案。文中所有文件名都是真实路径。

```
src/
  host/                     主机半边：纯 JS，无编译器，Node 原生 ESM
    index.js                HTTP 接线：建协作者、注册路由（只做这一件事）
    clip-id.js              ClipId 的形状、生成、校验
    clip-registry.js        ClipRegistry：发现片段、懒 hash、按内容去重
    clip-resolver.js        ClipResolver：clipId → 唯一一个 clip
    selection-store.js      SelectionStore：schema v2 + 迁移 + 损坏自愈
    media-server.js         MediaServer：单 clip 字节 + Range/ETag/缓存策略
    random-controller.js    RandomController：唯一随机来源（纯函数 + 记忆）
    diagnostics.js          Diagnostics：有界、去路径的事件环
    errors.js               五类边界：plugin/clip/media/playback/ui
  client/                   浏览器半边：TS，tsdown 打成 lib/client.js
    index.ts                接线：dynamic inject + 挂载两个 slot
    store.ts                ClientStore：客户端唯一数据源
    session.ts              uiSession 绑定（blank 双形状）+ session→clip pin/已播记录
    ui.ts                   三个界面：BootOverlay / VideoLibrary / PinAction
    styles.ts               样式表（模板字符串，有 check-css-template 防呆）
    diagnostics.ts          客户端诊断
scripts/lib/harness.mjs     测试骨架：加载真实产物、复刻真实路由匹配
```

## 1. Plugin lifecycle

```
DSH 启动
  → 主机半边 import('lib/index.js')       ← 只解析模块，不读媒体
      apply(ctx) 建立 7 个协作者（纯内存，无 I/O）
      注册 6 条路由（ctx.effect，卸载即撤）
  → 浏览器半边 import('lib/client.js')
      apply(ctx) 用 cordis 动态注入等待 ['slots','uiSession']
        服务就位 → ClientStore 建立 → 注册 shell.overlay + sidebar.footer.action
        服务缺失 → 插件静默闲置（绝不 pending）
```

**分层初始化，安装期不做重活**：ClipRegistry 只在第一次被问到时扫描目录；
MediaServer 只在第一次被请求某个内置片段时才 import `clips.data.js` 并**只解那一个**；
`lib/clips.data.js` 是懒加载的（`await import`）。客户端启动只取一次 `videos.json`，
**不预取任何媒体字节**（`verify-install.mjs` 断言 `decodedClips===0`，以及产物里不存在
`force-cache`）。

**动态注入不是风格选择，是硬要求**：客户端加载器把任何非 `active` 的条目当致命错误
（`web boot: N entry did not activate` 会抛，整个 GUI 打不开）。静态 `inject` 在服务缺失时
让本插件 fiber 永远 pending，现场事故原文：

```
dsh-boot-animation: pending (waiting for service: uisession)
```

`scripts/verify-client-boot.mjs` 直接断言"产物里没有静态 `inject`"。

## 2. Clip lifecycle

```
扫描（首个请求时，一次）
  clip-id.js   → 每个片段一个 ClipId
  registry     → 只读元数据：id/name/ext/bytes/mtime；mp4 系另读 64KB 判断 faststart
  去重         → 仅对"size 相同"的组算 sha256（不可能相等的文件一个字节都不读）
  排序         → 内置按 clips.meta.js 的顺序（用 name 查表，绝不用活动数组下标），用户片段按 mtime 倒序
```

**身份只有一种**：

| 片段 | ClipId | 稳定期 |
|---|---|---|
| 内置 | `builtin:<name>` | 永久 |
| 文件 | `<stem>-<fnv8(规范化绝对路径)>` | 路径不变期间 |
| 伪 id | `active` | 仅用于"现在该播哪个"的路由别名 |

**禁止数组下标当身份**，也**禁止全局 `currentVideo`**：`Clip` 只有一个实例，id 由
`clip-id.js` 生成并被校验（`normalizeClipId` 拒绝分隔符、`..`、超长）。

用户的文件被移走/改名 → 旧 id 解析失败 → **回落到优先级链**，绝不报错。

## 3. Selection lifecycle

`$DSH_HOME/boot-animation/selection.json`，**只放设置，不放媒体路径**：

```json
{ "version": 2, "selectedClipId": "builtin:brand",
  "randomPlayback": false, "fitMode": "cover" }
```

```
read:    缓存(按 size@mtime 签名) → JSON.parse → migrate() → 需要时回写
migrate: 纯函数。{id} (v1) / 无版本号 / 未知版本 / null / 数组 / 字符串 → 合法 v2
         路径形状的值被 normalizeClipId 拒绝 → selectedClipId = null
损坏:    解析失败 → 用默认值 + 写回修复 + diagnostics 记 selection-unreadable/selection-reset
write:   只接受 selectedClipId/randomPlayback/fitMode；未知字段抛 ClipError
```

读取永不抛异常：选择文件坏掉只能导致"用户的挑选被忘记"，不能导致插件起不来。

## 4. Preview lifecycle

预览是**试听**，不是**挑选**。三者严格分开：

```
settings.selectedClipId    只由 select() 改（POST /select 落盘）
playback.previewClipId     最后一次 preview 的目标，纯展示用，不落盘
playback.clipId            播放器此刻指向的片段
```

`ClientStore.preview(clipId)` → `playClip(clipId,'preview')` + 记 `previewClipId`。
**绝不触碰 `settings`** → 试听 B 时 A 仍是你的选择。

片库每行有**两个**按钮：「▶ 预览」（播这一段）与「选它」（设为以后播放）。0.2.x 只有一个
点击动作同时干了这两件事，且播放路径无法指名片段，所以"预览"看起来总在播同一段。

预览时片库**不关闭**，可以连续试听 A/B/C/D。

## 5. Playback lifecycle

**唯一路径**，四种触发（新对话 / 钉住的会话 / 预览 / 随机）全部汇入：

```
trigger
  → 需要"现在该播谁"时问主机 GET /resolve.json?mode=active|random|selected
        （主机 ClipResolver 回答；随机也在主机决策，见 §8）
  → 已知 clipId（如预览、session-scoped pin）则直接用
  → ClientStore.playClip(clipId, reason)
        url = /dsh-boot-animation/media/<ClipId>?v=<该片段自己的 version>
        nonce += 1
  → BootOverlay 的 effect 依赖 [url, nonce]
        video.src = url; video.load(); video.play()
        playing → phase='playing'；超时 25s → 'stalled'；元素报错 → 'error'
```

`nonce` 让"连播同一段两次"也能重新触发（React 只看 `[url, nonce]`）。

## 6. Media route

```
GET /dsh-boot-animation/media/<ClipId>[?v=<version>]      ← 唯一正式资源
GET /dsh-boot-animation/boot.mp4                           ← 仅向后兼容：302 → 上面的地址
GET /dsh-boot-animation/resolve.json?mode=…                ← "现在该播谁"
GET /dsh-boot-animation/videos.json                        ← 片库 + 设置
POST /dsh-boot-animation/select                            ← 改设置
GET /dsh-boot-animation/status.json                        ← 诊断 + decodedClips
```

前缀路由**不能带尾斜杠**（`pathname !== prefix && !pathname.startsWith(prefix + '/')`），
否则 `.../media/` 会被测成 `.../media//`，每个媒体 URL 都 404 —— 这个坑踩过。

**媒体 URL 必须唯一对应一个片段**：每个片段有自己的地址、自己的 ETag、自己的 version。
`boot.mp4` 不再承载字节，只做 302，所以即使老客户端也不可能拿到"共享 URL 下的旧字节"。

## 7. Cache strategy

| 请求 | 应答 |
|---|---|
| `/media/<id>?v=<该片段自己的 version>` | `public, max-age=31536000, immutable` |
| `/media/<id>`（裸） | `no-cache`（带 ETag，未变则 304） |
| `/media/<id>?v=<别的片段的 version>` | `no-cache` ← **关键**：不匹配就不许永久缓存 |
| 任何失败（404/416/500） | `no-store` |
| 302 跳转本身 | `no-store` |

version 的来源只有一个：`Clip.version()`（内置 = sha256；文件 = `s<size>-t<mtime>`，
若该文件因 size 冲突被 hash 过则用 sha256）。**列表里公布的 version 与媒体端比较的 version
是同一个字符串**，否则 `?v=` 永不命中，每次播放都多一次往返。

Range：`206` + `content-range` + `accept-ranges`；后缀式、开区间、不可满足的 `416` 都覆盖。

一条被验证过的取舍：`no-store` 用在媒体上是最糟的（浏览器一字节都不能留 → 每次开片头重下整段
→ 黑屏），所以媒体用 `no-cache`/`immutable`。

## 8. Random strategy

随机决策在**主机**（`clip-resolver.js` + `random-controller.js`），不在浏览器：

- 老客户端也能获得一致行为；
- "不连续重复"需要记忆上一次 —— 只有主机看得到每一次请求；
- 客户端换页/刷新不会忘记上一条。

规则（`pickRandom(clips, lastId, rng)`，纯函数）：
**从候选里先剔除上一次，再随机取一个；若只剩一个片段，就返回它。**
`mode=random` 强制随机；`mode=active` 在 `randomPlayback` 开启时走随机，否则走选择。
随机与普通播放**共用同一个 PlaybackController**（`ClientStore.playClip`）。

测试：1000 次抽取 0 连续重复；`rng()===1` 被夹到末位；恒定 rng 仍不重复；单片段恒返回它。

## 9. Error boundary

五类，互不污染（`errors.js`，每个错误自带 `boundary`）：

| 边界 | 含义 | 容器 |
|---|---|---|
| plugin | 插件整体无法初始化 | `apply()` 注册路由处；成功后绝不再抛 |
| clip | 一个片段条目不可用 | registry 扫描/采纳单条；跳过并记事件 |
| media | 某个片段的字节取不到 | `MediaServer.serve()` 内；返回 `no-store` 的错误响应 |
| playback | 一次播放尝试失败 | 客户端 `phase='error'` + 可见状态行 |
| ui | 渲染/交互失败 | 组件内；不影响 store 与主机 |

**媒体失败永远不能升级成插件失败**：`/media/<坏 id>` → 404；内置字节读不到 → 500 且
`no-store` 并记 `media-error`（boundary=`media`）；之后 `/videos.json`、`/resolve.json`
照常可用（`verify-fallback.mjs` 逐条断言）。

其它 graceful fallback：选择指向已删除片段 → 回落优先级链并记 `selection-stale`；
零字节文件/非视频扩展名/同名目录 → 不列出；`DSH_BOOT_ANIMATION` 指向不存在 → 回落并记
`env-clip-error`。

## 10. Backward compatibility

客户端 pin 从 0.3.0 的单个裸字符串扩展时使用了**新 key**：
`dsh-boot-animation:session-clips` 保存 `sessionId -> ClipId`。旧的
`dsh-boot-animation:pinned` 仍只按裸字符串读取；新映射不会写进旧 key。
因此旧 pin 继续按 active 模式工作，而新 pin 可以逐会话固定片段；降级到旧客户端时
新 key 会被忽略，不会把旧客户端喂进不认识的 JSON 形状。

| 旧行为 | 现在 |
|---|---|
| `GET /boot.mp4` 直接给字节 | **302** 到 `/media/<activeClipId>?v=…`（老客户端照样能播，但拿到的是唯一地址） |
| `POST /select` body `{id}` | 仍然接受（等价于 `selectedClipId`） |
| `selection.json` `{id, at}` | 读取时迁移到 v2；`at` 丢弃；路径形状的值丢弃 |
| `$DSH_HOME/boot-animation/intro.mp4` | 仍在优先级链里（`legacy-dropin`） |
| `DSH_BOOT_ANIMATION=<路径>` | 仍生效，且该文件会被 `adopt` 成可寻址的片段 |
| `videos.json` 的 `activeId/activeVersion/videos[].id` | 原样保留，另加新字段 |
| `shell.overlay` / `sidebar.footer.action` | 未变（都是 list slot，只增不替） |
| Range / ETag / faststart | 未变（这些本来就对，只是搬进了 MediaServer） |
| 客户端 `fit` 存在 localStorage | 改为 `selection.json` 的 `fitMode`；迁移时若旧文件带 `fit` 会被读入 |

**未变的行为由既有测试守住**：`verify-routes.mjs`（5 片段/5 独立 artifact、失败不可缓存、
跨片段 ETag 必须 200）、`verify-blank.mjs`（13 种 host 形状）、`verify-client-boot.mjs`
（11 项 boot 安全）、`verify-letterbox.mjs`（真浏览器黑边）、`verify-boot-animation.mjs`
与 `verify-pin.mjs`（真 GUI 端到端，需要调试端口）。

## 不变量清单（改动前请读）

1. 客户端半边**不能有静态 `inject`**（会让整个 GUI 打不开）。
2. 片段身份**只能是 ClipId**，不能用数组下标、不能用 `currentVideo` 之类的模糊状态。
3. `selectedClipId` / `previewClipId` / `activePlaybackClipId` **三个字段不能合并**。
4. 播放路径只有一条：`playClip(clipId)` → `/media/<ClipId>?v=` → `load()` → `play()`。
5. 媒体 URL 必须唯一对应一个片段；`boot.mp4` 不得承载字节。
6. 列表公布的 `version` 必须等于媒体端比较的 `version`。
7. 失败响应必须 `no-store`；媒体成功响应不得 `no-store`。
8. 初始化分层：主机 apply 无 I/O；registry 懒扫描；媒体懒解码且**只解被请求的那一个**。
9. 选择文件损坏 → 修复并继续，绝不启动失败。
10. 媒体/片段错误不得升级为插件错误；DSH GUI 与主机的其它部分不受影响。

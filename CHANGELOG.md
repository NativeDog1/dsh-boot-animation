# 更新日志

本文件记录**用户可见**的变化。版本号按语义化版本取舍，每次升版的理由写在条目里。

> Changes that a user can see, one section per release. English one-liners are
> included so an English reader can scan the list.

## 0.4.1 — 2026-10-01

**修复：安装时的 `connection to github.com timed out after 5000ms` —— 并把这个错误的含义写进文档**
*Fix: the install-time github.com timeout, and document what that error actually means.*

客户在安装时遇到：

```
{"code":"operation-error","diagnostic":"dsh: connection to github.com timed out after 5000ms"}
```

查过之后，**这不是插件里的错误代码**：插件自己的 `fetch` 全部指向它自己的本地路由（相对地址），
超时常量是 25 秒的卡顿检测，与报错里的 5 秒无关；报错前缀 `dsh:` 说明是 DSH 在**拉取插件**时连不上 github.com。

我一开始以为可以靠删大文件解决，核对后发现那两个大文件（`dsh-boot-animation-0.2.4.tgz`、
`boot.mp4.original-backup`）**只存在于本地、从未被提交**，安装时根本没有传输它们 ——
所以「删掉后体积减少 12 MB」这个说法不成立，已在此更正（原来那句话是我没核对就写下的）。

安装真正传输的是仓库里**被跟踪**的内容：内嵌片头的 `lib/clips.data.js`（约 12 MB）与构建输入
`media/`（约 9 MB）。前者就是插件的功能本身（四段片头内嵌在代码里、不带独立视频文件），
后者用于重新生成前者 —— 两者都不宜为了安装体积而删除。所以这次**不是靠缩小体积修的**，
而是把「这个报错到底是什么意思、该怎么办」写清楚。

同时在 README 里补了「安装超时」一节：说明这个报错的含义、为什么与插件代码无关，以及三种处理方式
（重试 / 用代理 / 用本地路径安装）。以前这个报错在文档里没有任何解释，客户只能猜。

**本次没有改动任何运行时行为**：ClipId、媒体路由、选择与随机逻辑、客户端与服务端模块都保持原样；
只删了两个无关文件、补了文档、升了版本号（补丁号）。

## 0.4.0 — 2026-09-30

**新增：按会话固定片头 —— 全局选择之外再加一层，只对某一个会话生效**
*New: pin one conversation to one clip, on top of the global choice.*

来自 issue #3（@windyduan）的方向。只做了**会话级**，没有做 project 级：当前宿主对
project 身份的暴露不稳定，按提案里自己那条"拿不到信息就降级"的边界，加那一层只会
变成一堆兼容分支。

- 片库每行多一个按钮 **「仅本会话」**：只让当前这个会话播这一段。那一行变蓝并挂
  「本会话」徽章，面板顶部写明本会话固定播放哪一段，旁边是「取消（回到全局）」。
  「选它」改的是全局，「仅本会话」改的是这一个会话，两者互不覆盖。
- 优先级：**会话覆盖 → 随机 → 全局选择 → 环境变量 → `intro.mp4` → `videos/` → 内嵌内置片**。
  会话覆盖连"随机播放"也压得住 —— 钉住一个会话之后又被随手塞一段随机片，那不是
  "钉住"的意思；但显式 `mode=random` 仍然不被覆盖（那是调用方指名要随机）。
- 覆盖层进 `selection.json`（schema **v3**，新增 `conversationOverrides`），与全局选择
  同一个文件、同一套原子写与损坏自愈；v2 文件自动迁移（补一个空层）。键值两侧都按和
  全局选择一样的规则校验：**路径、`active` 别名、非字符串一律丢弃**，手改文件也无法
  从这张表塞进媒体路径。
- 表有上限（200），淘汰的是**最久没被设置**的会话而非任意一条；重新设置某个会话会把
  它移到最近使用的位置。
- 钉住指向的片段被移走/删除时**回落常规链**并记 `conversation-override-stale` ——
  绝不报错、绝不黑屏，也**不删除那条钉住**（文件回来就自动复活）。
- 只有**发问的那个会话**能知道自己的钉住：`videos.json` / `status.json` 只公布
  `conversationClipId`（连同 `conversationOverrideCount`、`sessionKnown`），
  绝不把整张表发给浏览器。
- **向后兼容**：不带 `?session=` 时每个回答都与 0.3.0 逐字节一致；`POST /select {id}`、
  `mode=active|random|selected` 的语义都没变。

接口：
- `GET /resolve.json?mode=active&session=<id>` —— 会话感知的"现在播谁"
- `GET /videos.json?session=<id>` / `GET /status.json?session=<id>` —— 带上本会话的 `conversationClipId`
- `POST /select {scope:'conversation', sessionId, id}` —— 钉住；`id: null` 取消

工程与测试：

- 新增 `verify:conversation`（70 项断言）：真实路由 + 真实构建产物，覆盖"只对自己生效 /
  不碰全局 / 压过随机但不压过 `mode=random` / 片段失效回落 / 不泄露其它会话 / 校验与上限"。
- `verify:selection` 跟随 schema v3 更新（新增 v2→v3 迁移与"路径无法经覆盖表混入"的断言）。
- `npm run check` 现为 **15 组**；`lib/` 已按新源码重新构建。
- 顺手修掉文档里已经过期的 `assets/boot.mp4` 描述（两处 README 与 LICENSE 的许可段落）——
  那段片源早已内嵌进 `lib/clips.data.js`，包内既没有 `assets/` 也不随包发 `videos/`。

## 0.3.0 — 2026-09-29

**架构级重构：一个片段一个 ClipId、一条播放路径、一个数据源**
*Architectural rewrite: one ClipId per clip, one playback path, one source of truth.*

0.2.x 的问题不是"少几个判断"，而是没有单一数据源：唯一的播放地址是 `/boot.mp4`
（含义是"当前 active 那个"），片库、选择、预览、播放、缓存各自持有状态。
详见新增的 **ARCHITECTURE.md**（十章）。

修掉的具体缺陷（每条都有对应的回归测试）：

- **四个片段显示不同、播放却是同一个**：唯一的播放 URL 是 `/boot.mp4`，主机端无视 URL、
  永远返回 active；片库的「预览」甚至无法指名片段。现在每个片段有自己的
  `/media/<ClipId>?v=<自己的 version>`，片库每行有独立的「▶ 预览」。
- **选了新片头、不刷新页面仍播旧的（F5 才好）**：`activeVersion` 是模块级全局只取一次，
  `src` 在挂载时被 `useState` 冻结，而旧片 active 时那个 URL 曾被应答为 `immutable`
  （一年），于是旧字节被无限复用。现在 url 随 `playClip` 变化、每个片段一个地址，
  且 `?v=` **只在本片段自己的 version 上**才允许 immutable。
- **预览结果总是一样**：预览不再等于"选择 + 播一次选中项"，试听 B 时 A 仍是你的选择。
- **安装/首屏卡顿**：① 首次请求内置片段时**四段全部 base64 解码** → 现在只解被请求的那一个
  （有界 LRU，`/status.json` 的 `decodedClips` 可观测）；② 列表对**每个用户文件**做全量
  sha256 → 现在只对 size 相同的组算 hash（不可能相等的文件一个字节都不读）；
  ③ 客户端挂载即预取整段视频 → 现在完全不预取。
- **随机播放**（新）：`randomPlayback` 开关；从所有可播放片段里随机取，
  **连续两次不会取到同一段**（除非只有一个）；随机与普通播放共用同一个播放路径。
- **状态不同步**：`selectedClipId` / `previewClipId` / `activePlaybackClipId` 严格区分，
  片库、设置、播放状态集中在 `ClientStore` 一个快照里。
- **selection.json**：schema v2（`version/selectedClipId/randomPlayback/fitMode`），
  只存设置、不存媒体路径；v1 `{id,at}` 自动迁移；文件损坏自动修复并继续，绝不启动失败。
- **错误边界**：plugin / clip / media / playback / ui 五类，媒体失败不得升级为插件失败。
- **可扩展性**：新增第 5、第 10 个视频不需要动播放逻辑；身份不再依赖数组下标。

工程与测试：

- 主机半边拆成 9 个模块（`src/host/*.js`，Node 原生 ESM，仍无需编译器）；
  客户端拆成 5 个模块（`src/client/*.ts`，tsdown 打包）。
- 构建改为纯 Node（`scripts/build.mjs`），不再要求 bash；新增 `verify:build`
  逐字节断言 `lib/` 与 `src/` 一致，并检查产物不陈旧。
- 测试整合进 `npm run check`：`verify:build / routes / selection / cache / blank /
  boot / preview / playback / random / fallback / install` 共 11 组。
- `boot.mp4` 保留为向后兼容，但改为 **302** 到具体片段地址，不再承载字节。

### 社区贡献：客户端生命周期修复（@windyduan, PR #2）

**修复：卸载后媒体仍播放、切换后预览仍使用旧片段、当前会话身份在新宿主形状下取不到**
*Fixed: media surviving unmount, stale preview content after selection changes, and current-session identity resolution on newer host shapes.*

- 覆盖层卸载时现在会 pause、归零、移除 `src` 并调用 `load()`，避免 HMR、禁用插件或 slot 重挂载后仍有声音。
- 切换片段后会清掉旧的 `activeVersion` 并重新解析；播放中的 `src` 仍保持冻结，黑帧防护不变。
- 当前会话身份按 session snapshot → `binding.key` → 旧 `props.sessionId` 的顺序解析，保留旧宿主兼容回退。
- 新增针对真实 `lib/client.js` 的 teardown、version refresh 和 session identity 回归检查，并保留 0.2.4 的 client-boot 检查。

## 0.2.3 — 2026-09-29

**修复：DSH 0.2.0 起「新对话自动播放」静默失效**
*Fixed: on DSH 0.2.0+ the "new conversation" auto-play never fired, silently.*

- DSH 0.2.0 把 `hooks.session` 换成了 `SessionFace`
  （`ISession & ObservableSnapshot<SessionSnapshot>`）：空白会话标志从直接挂在 binding 上的
  `blankBit` 移到了 **`getSnapshot().blank`**，旧字段变成 `private`。
- 读一个已经不存在的字段**不报错**，只返回 `undefined`，判断恒为假 ——
  所以症状不是崩溃或报错，而是**沉默**：没有日志、没有提示，就是不播。
- 现在两种形状都读（新字段优先；该键不存在或读取抛错时回落到 `blankBit`），
  所以 0.2.0 之前的主机不受影响。
- 同时修掉一个更隐蔽的问题：原逻辑只在 `sessionId` 变化的那一次渲染里判断空会话，
  而新标志来自**嵌套 snapshot**，可能晚一拍落定。现在**订阅那个 face 本身**，
  标志到达即触发（仍由「已播放」记录保证每个会话只播一次）。
- 新增 `scripts/verify-blank.mjs`：用 stub 的宿主模块加载器跑**真实产物** `lib/client.js`，
  覆盖 13 种宿主形状；已接入 `npm run check`。

## 0.2.2 — 2026-09-26

**修复：黑屏不再无声；媒体 URL 改为按内容寻址**
*Fixed: a black overlay can no longer be silent; the media URL is content-addressed.*

- 之前无法区分「没触发」和「触发了但画面全黑」：客户端什么都不说（`DEBUG=false`），
  而每次播放都用同一个固定 URL，背后字节当天变了三次。
- 挂载时解析一次片段的内容键（`videos.json` 新增 `activeVersion`）并钉进媒体 URL（`?v=`）。
  宿主对钉住的 URL 回 `public, max-age=31536000, immutable`，对裸 URL 或已过期版本回 `no-cache` ——
  重播直接命中浏览器缓存，一次请求都不用发。钉住也让每个片段各有独立缓存条目，
  避免浏览器把「片段改变前后」的 Range 拼起来。
- 覆盖层在挂载时**冻结 `src`**：`src` 若在挂载后变化会重启媒体加载，而 `play()` 的 effect
  不会重跑（就是本插件修过一次的黑屏）。
- 插件挂载时预取当前片段，首次播放不再从网络开始。
- **常开诊断**（走 `notify`，不受 `DEBUG` 门控）：元素实际用的 URL、到首帧的毫秒数、
  元素错误码、看门狗放弃。可见的状态行取代无声黑屏；元素报错现在会报告并等 8 秒，
  而不是立刻关闭。

## 0.2.1 — 2026-09-26

**性能：内嵌素材体积压缩 57%（20.4 MB → 8.7 MB）**
*Perf: embedded clips shrunk 57% (20.4 MB → 8.7 MB); npm package 21.5 MB → 9.1 MB.*

- 四段全部重编码为 h264 CRF 20 preset slow、yuv420p、aac 128k，并加 faststart；
  分辨率、帧率、时长不变（1280×720 24fps）。
- 与各自**原始文件**实测对比：SSIM 0.9879–0.9961、PSNR 44.0–47.7 dB —— 属于肉眼看不出差别的区间。
- `lib/clips.data.js` 27.15 MB → 11.53 MB；npm 包 21.5 MB → 9.1 MB，解包 28.6 MB → 12.2 MB。
- 原始文件保留在仓库之外（`~/dsh-dev/_clip-masters/`；刻意不放 `~/.dsh/boot-animation/`，
  那个目录会被宿主扫描并显示成「用户自己的片段」）。
- 重新内嵌后交叉核对：每个 base64 导出解码后与素材字节一致，四段都带 faststart。

## 0.2.0 — 2026-09-26

**新增：两段内置演示片头（awakening、startup），共四段**
*Added: two more built-in demo clips (awakening, startup) — four in total.*

- 新增 `media/deepseek-awakening-intro.mp4`（3.88 MB）与 `media/deepseek-startup-intro.mp4`（10.74 MB）。
- 两个源文件都没有 faststart，`scripts/embed-clips.mjs` 会**拒绝**这类输入；
  用 `ffmpeg -c copy -movflags +faststart` 无损重排后通过（已核验 `moov` 在 `mdat` 之前）。
- **为什么升 minor**：随包发布的内容变了。同一版本号下放两份不同内容，是发布事故的常见开头。
- README 更新为四段，并写上实测包体积。

## 0.1.0 — 2026-09-25

**首个可用版本** · *First usable release.*

- 打开**新对话**（每个会话一次）或**你钉住的会话**（每次打开）时，全屏播放一段片头动画。
- **片库**：列出所有能找到的片段，在界面里选择并记住；也能加自己的 mp4
  （丢进 `~/.dsh/boot-animation/videos/`，面板里点「预览当前」立刻确认）。
- 两段片头**内嵌进代码**（`lib/clips.data.js`，base64）：随包不再带独立视频文件，
  不会再有 `files` 字段漏写、安装副本过期、或发出一个没做 faststart 的容器这类问题。
- 媒体支持 **Range**；正常响应是 `no-cache` + ETag（重播 304 秒开），
  失败响应一律 `no-store`（否则一次 404 会被浏览器缓存住，修好也看不见）。
- 播放贴合方式可切换：**铺满屏幕**（`object-fit: cover`，默认，无黑边）/ **完整显示**。

# Remotely Save Yong — iPhone 实测步骤（移除 Pro + 同步稳定性）

> 本 fork 已改名 **Remotely Save Yong**（插件 id `remotely-save-yong`），可与官方 Remotely Save 并存。
> 本次两项改动：**① 移除全部 Pro 功能；② 修复 iPhone 同步视频时 Obsidian 重启（iOS 内存被杀）**。
> 改动只在 S3/OSS 后端与内存路径上生效；小文件与笔记走原路径。

## 0. 构建插件

在电脑上（仓库根目录）：

```bash
npm install            # 首次需要
npm run build          # 产出 main.js（webpack 生产构建，已验证可跑通）
```

> 构建侧已应用的仓库修正（与功能无关，无需你再操作）：`package.json` 补 `terser-webpack-plugin`；
> `webpack.config.js` 的 ts-loader 开 `transpileOnly`；`package.json` 加 `overrides: { "clean-stack": "5.2.0" }`。
> 详见 git 无关的工作记录。

## 1. 安装到 iPhone（可与官方版共存）

把构建产物放进**名为 `remotely-save-yong` 的文件夹**：

```
<vault>/.obsidian/plugins/
├── remotely-save/           ← 官方版（如仍想保留）
└── remotely-save-yong/      ← 本 fork
    ├── manifest.json
    ├── main.js
    └── styles.css
```

> ⚠️ 数据目录是 `.obsidian/plugins/remotely-save-yong/data.json`，**是全新空配置**，S3 设置需重填。
> ⚠️ 别让两个插件指向同一个远端 bucket/前缀（会争用元数据文件），要么用不同 `remoteBaseDir`，要么同一时间只启用一个。

## 2. 确认 Pro 已彻底移除

进 `Remotely Save Yong → 设置`：

- **远程服务下拉** 里应只剩：**S3、Dropbox、WebDAV、OneDrive（App Folder）、Webdis**。
  （Google Drive / OneDrive Full / Box / pCloud / Yandex Disk / Koofr / Azure Blob Storage **应全部消失**）
- **不应再有任何「Pro / 账户 / 登录 / 订阅」入口**。
- 「智能冲突处理（smart conflict）」与「清理重复文件」现在**免费可用**。

## 3. 确认同步不再触发 Pro 报错

- 之前同步会在 Console 打出 `POST app://obsidian.md/api/v1/oauth2/token` 并失败。
- 现在同步**不应再出现任何对 license 服务器的请求**，也不应有 `Failed to fetch`。

## 4. 验证 iPhone 内存修复（核心）

本次针对 iOS 内存做了三处修复：

1. **去掉整文件二次复制**：`writeFileLarge` 从 `new Blob([content])`（会复制一整份）改为零拷贝 `Uint8Array` 视图。
2. **大文件串行**：大文件（≥阈值）的「读取 + 上传」全局互斥，**同一时刻只处理一个大文件**；小文件仍按并发 5 跑。
3. **移动端降分片并发**：S3 `partsConcurrency` 默认在移动端为 **4**（桌面 20）。

测试步骤：

1. 准备：一个 **~100MB** 视频、一个 **~400MB** 视频，以及若干小笔记/图片。
2. 先同步小文件 → 应正常、无重启。
3. 同步单个 ~100MB，再单个 ~400MB → **观察 Obsidian 是否重启**（插件全部重载即为重启）。
4. 跑一次**首次全量**（含多个视频）→ 观察是否重启、能否跑完。
5. 上传大文件时打开**开发者控制台**，应看到每次请求的 `S3 request: <method> <url>` 日志（为便于定位保留）。
6. 上传完成后到 OSS 控制台核对对象 **size 与 ETag**（代码做了轻量校验）。

## 5. 观察项与判据

| 现象 | 说明 |
|---|---|
| 无重启、视频逐个上传 | ✅ 修复生效 |
| 状态栏出现 `uploading xx%` | 大文件走流式路径（含进度/重试/校验） |
| 仍偶发重启 | 说明单个文件已超过 iOS 内存上限；需进入下一步「原生/流式本地读取」 |
| 报错带具体文件名或 URL | 已加入的报错上下文，直接把原文发我 |

## 6. 已知边界（重要）

- **本地读取仍是整文件 ArrayBuffer**：Obsidian 移动端公开 API（`adapter.readBinary`）只能整文件读入内存。
  本次修复消除了「二次复制 + 多文件同时在内存」这两个最大放大项，使峰值≈单个最大文件。
  若**单个文件**超过设备内存上限（通常 >500MB 的老设备），仍可能被杀——那需要「原生/流式本地读取桥」，
  属本次范围之外的下一阶段。
- 若你的场景单个文件基本 <500MB，本次修复应能覆盖。

## 7. 失败排查

- 若构建报错：贴回完整输出。
- 若 S3 同步失败：先看 Console 的 `S3 request:` 日志，定位是哪个 method/URL。
- 若插件界面仍显示英文：**不是翻译缺失**（`src/langs/zh_cn.json` 的键与英文版完全对齐，打包产物里 `en`/`zh_cn`/`zh_tw` 三份都在），而是**语言检测**的问题。
  插件旧版只读 `moment.locale()`；而 Obsidian 仅在启动时「顺手」设一下它（`app.js` 里的
  `try { window.moment.locale(appLang) } catch {}`，异常被静默吞掉、也不重试），失败时
  Obsidian 自己的界面仍是中文（走 i18next + `localStorage["language"]`），插件却整页回退英文。
  现已改为三级回退：**`getLanguage()`（官方 API，Obsidian ≥ 1.8.7，读的就是界面语言那个值）
  → `moment.locale()` → `navigator.language`**；另外 `normalizeLocale()` 现在也能处理「自定义翻译文件的路径」这种取值。
  排查方式：
  1. 设置页顶部新增的「界面语言」手动选 **简体中文**（写入 `data.json` 的 `lang`，优先级高于自动检测）；
  2. 或在 iPhone 上跑诊断命令，看报告里的 `=== Language / i18n ===` 四项（见第 9 节）。

## 8. 追加修复：iOS「单个大文件」内存（重要）

### 背景
你反馈：进度到 ~76% 时 iPhone 白屏 → 「加载插件中…」（iOS 杀进程导致 Obsidian 重载）。
根因：**单个文件太大**。Obsidian 没有分段读取 API，`readBinary()` 会把整个文件读进 JS 堆；
一个几百 MB 的 `.mov` 就能顶爆 iOS WebView 的内存上限。此前的修复只解决了「多文件并发 + 二次复制」，
对**单个超大文件**无效。

### 本次改动（仅移动端生效）
大文件上传时改用 **`fetch(vault 资源路径) → Blob`** 作为上传源：
- Blob 由浏览器的 blob 存储承载（WebKit 上通常落盘），**不占 JS 堆**；S3 SDK 按 5MB 切片上传，JS 堆峰值只有分片大小。
- 失败或大小不符时**自动回退**到原来的 `readBinary`，不会把同步弄坏。
- **桌面端不改动**（内存充足，保持原路径，零回归）。

### 怎么验证
1. 覆盖 `main.js`、重启 Obsidian，重新同步那个 `IMG_7319.mov`。
2. **若不再白屏/重启** → 修复生效。
3. **若仍白屏** → 说明 iOS 下 `fetch` 的 Blob 依然占内存（论坛实测 iOS 会把整文件作为一个 chunk）。
   此时用**兜底**：设置里把 **「跳过大于 X 的文件」（skipSizeLargerThan）** 设为能稳定上传的上限（如 200MB），
   避免崩溃；超大文件用别的方式（相册/文件 App）传。

### 关掉对比
设置里关闭 **「大文件流式上传」**，即回到原 `readBinary` 路径，可用于 A/B 对比本次改动是否带来改善。

## 9. 新增：移动端文件 API 诊断 + 同步进度常驻

### 9.1 诊断命令（判定「能不能分段读」）

命令面板 → 搜 **「诊断：检查移动端文件分段读取能力」** → 运行。

> 运行后**先立刻弹一条短提示「诊断运行中…」，再弹出报告窗口**。
> - 只看到短提示、没有报告窗口 → 弹窗环节出问题，把现象告诉我；
> - **连短提示都没有** → 说明**新的 `main.js` 没被加载**（命令不存在）。请确认已覆盖到
>   `.obsidian/plugins/remotely-save-yong/main.js`，并在 **设置 → 社区插件** 里把
>   **Remotely Save Yong 关掉再开启**（或重启 Obsidian）。
> 诊断每步都有 8 秒超时，不会卡死；报告窗口边跑边填。

会在屏幕上弹出一个报告（因为 iPhone 上没有开发者控制台），内容包含：
- 设备/Capacitor 是否存在（`window.Capacitor`、`Plugins` 列表）；
- **语言/locale 实测值**（`=== Language / i18n ===`）：`navigator.language`、`localStorage["language"]`
  （Obsidian 界面语言的唯一来源）、`getLanguage()`、`moment.locale()`。
  后两者不一致（`getLanguage()` 是 `zh`、`moment.locale()` 却是 `en`）时，就是「Obsidian 界面中文、插件英文」那个场景，
  插件已改用前者优先（见第 7 节）；
- **`Capacitor.Plugins.Filesystem` 的全部方法名**（一次性枚举，重点看有没有 `uploadFile` / `downloadFile` / `readFileInChunks`）；
- Obsidian 内部 `adapter` 的能力（`getNativePath` / `appendBinary` / `fs.readBinary` 等）；
- 一次**真实的分段读取正确性测试**：写 64 字节临时文件 → 请求 `readFile(offset=56,length=8)` → 解码后核对**实际返回字节数**：
  - 返回 8 字节且内容正好是 56..63 → **真·分段读可用**；
  - 返回 64 字节（整文件）→ **假阳性**：旧版 Capacitor 忽略了 offset/length（需 8.1.0+），分段读并不可用；
- **`uploadFile` / `downloadFile` 真实实现探测**：不只是看方法是否存在，还会**真的调用一次**（向一个不可能连通的本地地址发请求），根据返回的错误判断是「未实现桩」还是「真的在工作」。
  - 报错里包含 `not implemented on iOS` → 方法只是占位符，**原生直传不可用**；
  - 网络/路径类错误 → 方法确实在工作，原生直传**可用**。

判读（报告末尾 `=== conclusion ===` 会直接给结论）：
- 出现 **`NATIVE UPLOAD AVAILABLE`** → 关键突破！可以走「把原生文件路径交给远端预签名 URL、由原生层直接推送字节」的方案，**文件完全不进 JS 内存**，大视频上传不会再崩。
- 出现 **`RANGED READ AVAILABLE`** → 可在 JS 里分块读再做分块/分片上传，内存占用低很多，但仍走 JS。
- 出现 **`NO STREAMING PATH`** → 平台确实不给任何流式通道（iOS 上 `uploadFile`/`downloadFile` 是未实现桩、`readFile` 忽略 offset/length），只能走保稳方案（`skipSizeLargerThan` + 上文的同步方向/冲突保护/版本控制）。

> 注意：
> - 上一版诊断曾把「返回整文件」误判成 `CHUNKED READ IS AVAILABLE`，本版已修正——必须核对实际返回字节数，8 字节才算真可用。
> - 上一版诊断还曾把「方法存在」误判成 `NATIVE UPLOAD AVAILABLE`；本版已修正——必须**真的调用一次**并 catch `not implemented` 才能确认。

把弹窗内容截图或长按复制发我即可。

### 9.2 诊断：原生直传冒烟测试（决定性实验）

**背景**：真机诊断已确认 iOS 上 `Filesystem.uploadFile` / `downloadFile` 存在，但**存在不等于已实现**。本命令用**真实的 S3/OSS 配置**做一次 1MiB 文件的完整闭环验证，是「原生直传是否真能用」的终审。

1. 写一个 1MiB 临时文件进 vault（磁盘上）；
2. 手写 SigV4 生成**预签名 PUT URL**（无新依赖）；
3. 调 `Filesystem.uploadFile(url, nativePath, PUT)` **原生直传**；
4. 用 SDK 回查远端：`HeadObject` 比对大小 + `GetObject` 前 16 字节比对内容；
5. 预签名 GET URL，调 `Filesystem.downloadFile` 原生下载回本地并比对；
6. 全部清理（本地临时文件 + 远端测试对象都会删除）。

命令面板 → 搜 **「诊断：原生直传冒烟测试」** → 运行（需要手机能联网、远端配置已填好）。

**判读（看 `=== verdict ===`）**：
- 步骤 3/4 全 OK 且 `content match: true` → **原生直传可行**！我可以据此把「大文件原生直传」实装进同步主链路：文件留在磁盘、原生层推流上传、JS 内存零占用 → 大视频上传不再崩。
- 步骤 3 报错且含 **`not implemented on iOS`** → `uploadFile` 只是占位函数，**原生直传在 iOS 上不可用**，与之前诊断的 `NO STREAMING PATH` 结论一致。只能走保稳方案。
- 步骤 3 报 400/SignatureMismatch → 说明这个 Capacitor 版本的 `uploadFile` 是 multipart 封装而非裸 body，此路不通，走保稳方案。
- 仅步骤 5（downloadFile）失败 → 无伤大雅，上传才是关键方向。

> 前提：当前远端必须是 S3/OSS 类型；其他远端（webdav 等）会直接提示不支持。

### 9.3 同步进度常驻

同步过程中会显示一个**常驻通知**（不会自动消失），实时更新：
- 第一行 `Syncing i/total`；
- 第二行 `decision 文件名`（如 `uploading Attachments/videos/2026/IMG_7319.mov`）。

同步结束后保留约 8 秒再消失。移动端状态栏信息仍保留不变。

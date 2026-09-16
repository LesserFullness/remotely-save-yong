# 最终方案：移除 Pro（纯免费全功能版）+ 修复 iPhone 同步重启

> 仓库：`D:/Projects/remotely-save-master`（fork，已改名 Remotely Save Yong）
> 目标：1) 去掉所有 Pro 功能且保证 S3 同步可用；2) 消除 iPhone 同步视频时 Obsidian 重启。

---

## 一、根因（已查证，非猜测）

### A. iPhone「重启」= iOS 内存超限杀进程（OOM），三处叠加

| # | 位置 | 问题 | 量级 |
|---|---|---|---|
| 1 | `src/fsS3.ts:777-779` `writeFileLarge` | 我 Phase 1 用 `new Blob([content])`，**整份复制**文件字节；而原 `_writeFileFromRoot`（:887）用 `new Uint8Array(content)` 是**零拷贝视图**。→ 大文件内存**翻倍** | 400MB 视频 ≈ 800MB |
| 2 | `src/main.ts:136` + `pro/src/sync.ts:1825` | 同步并发 `concurrency` 默认 **5**，且不区分文件大小。→ 最多 **5 个大文件同时在内存** | 5×400MB ≈ 2GB |
| 3 | `src/fsLocal.ts` `readBinary` | Obsidian 公开 API 无流式读，整文件进 ArrayBuffer（单文件本身即数百 MB） | 400MB |

> 结论：**#1 是我引入的回归，必须回退改正；#2 是长期存在的架构隐患；#3 是平台限制，Phase 1 内无法根除。**

### B. Pro 报错是另一条独立问题线（与内存无关）
`syncRun` 开头调用 `checkProRunnableAndFixInplace`（`pro/src/sync.ts:1960`）→ 发现过期 Pro 功能 → token 刷新 `POST app://obsidian.md/api/v1/oauth2/token` 失败 → 整个同步中断。退出 Pro 账户即可绕过。本次「移除 Pro」正是根治这条线。

---

## 二、任务一：移除 Pro（纯免费全功能版）

**原则**：删掉一切需要账户/服务器授权的东西；保留同步引擎与所有免费后端；把不依赖服务器的本地增强解锁为免费。

### 删除（Pro 专属后端 + 授权层）
- Pro 后端实现：`fsGoogleDrive.ts`、`fsOnedriveFull.ts`、`fsBox.ts`、`fsPCloud.ts`、`fsYandexDisk.ts`、`fsKoofr.ts`、`fsAzureBlobStorage.ts`
- 对应设置面板：`settingsGoogleDrive.ts`、`settingsOnedriveFull.ts`、`settingsBox.ts`、`settingsPCloud.ts`、`settingsYandexDisk.ts`、`settingsKoofr.ts`、`settingsAzureBlobStorage.ts`
- 辅助：`yandexApi.ts`、`koofrApi.d.ts`
- 授权/账户：`account.ts`、`settingsPro.ts` 中的账户逻辑（**整份移除**）
- 协议回调：`COMMAND_CALLBACK_PRO / _ONEDRIVEFULL / _BOX / _PCLOUD / _YANDEXDISK / _KOOFR` 及 `main.ts` 中对应的 `registerObsidianProtocolHandler`
- `main.ts` 中的「Pro 账户」设置入口、订阅/登录相关命令与 UI

### 保留（核心，绝不能删）
- 同步引擎：`pro/src/sync.ts`、`conflictLogic.ts`、`localdb.ts`、`clearDupFiles.ts`、`settingsClearDupFiles.ts`
- 免费后端：`src/fsS3.ts`（S3/OSS）、`fsWebdav.ts`、`fsLocal.ts`、`fsOnedrive.ts`（基础版）、`fsDropbox.ts`、`fsFake*.ts` 等
- 免费 OAuth（OneDrive 基础版 / Dropbox）所用的 `oauth2.ts`（按实际依赖保留）

### 解锁为免费（不依赖服务器，仅被门禁锁着）
- **智能冲突处理 `smart_conflict`**：移除 `checkProRunnableAndFixInplace` 对它的校验；设置里不再要求 Pro
- **清理重复文件 `clearDupFiles`**：同上
- 具体做法：删除 `sync.ts:1960` 的 Pro 检查调用；`account.ts` 整份移除后相关 import 一并清理

### 连带处理
- `src/fsGetter.ts`、`src/settings.ts`、`src/baseTypes.ts`（`SUPPORTED_SERVICES_TYPE`）移除被删服务分支
- 三语 i18n：删除对应文案（或保留无害，倾向清理）
- `webpack.config.js`：移除已无用服务的 `DefinePlugin` 常量（可选，保持干净）

---

## 三、任务二：修复 iPhone 同步重启

### 修复 1（最高优先，回退我引入的回归）
`src/fsS3.ts` `writeFileLarge`：把 `body = new Blob([content])` 改为**零拷贝**：
```ts
body = content instanceof Uint8Array ? content : new Uint8Array(content as ArrayBuffer);
```
删除 Blob 分支。保留进度回调 + 重试 + size/ETag 校验。**此项单独即可让大文件内存回到 1×。**

### 修复 2（消除「多文件同时在内存」）
在 `pro/src/sync.ts` 的 `uploadDownloads` 处理中，**对大文件强制串行**：
- 方案：在 `copyLogic.copyFile` 内对大文件（≥ 阈值）加一个**全局互斥（并发=1）**，使「读取+上传」同一时刻只进行一个；小文件仍按原并发 5 跑
- 效果：首次全量同步时，一批视频**逐个**处理，峰值内存 ≈ 单个最大文件，而非 5 个之和

### 修复 3（降低单文件内存水位，移动端）
- 移动端（`Platform.isMobile`）将 S3 的 `partsConcurrency` 默认降到 4（原 20），减少并发分片缓冲
- 上传完立即释放 `content` 引用（避免 `copyFile` 返回值被上层长期持有）

### 修复 4（兜底观测）
- 在大文件路径打点输出「文件大小 / 峰值内存」日志，便于你在 iPhone 上确认效果

> **说明**：修复方案聚焦「同一时刻只驻留 1 个大文件」。这能解决「<500MB × 多个」场景；若将来出现**单个 >500MB** 仍崩，则需 Phase 3「原生/流式本地读取桥」，非本次范围。

---

## 四、验证步骤（我无法在 iPhone 实测，需你配合）

1. 构建：`npm run build` → 产出 `main.js`
2. 安装：覆盖到 `<vault>/.obsidian/plugins/remotely-save-yong/`，重启 Obsidian
3. 确认 Pro 相关入口消失、S3 设置与同步正常
4. 单文件：同步 1 个 ~100MB、再 1 个 ~400MB 视频，观察是否重启
5. 批量：跑一次首次全量（含多个视频），观察是否重启、能否跑完
6. 若异常：把 DevTools Console 日志发我（含我新加的 `S3 request:` / 文件大小打点）

---

## 五、风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| 删除代码面大 | 涉及 pro/ 多个文件、设置、i18n、protocol handler | 以编译通过 + S3 冒烟为准，逐步删、每步构建 |
| 既有配置引用被删后端 | 老 data.json 里 `serviceType` 可能指向已删服务 | 加兜底：回退到默认或提示重选；你当前只用 S3，风险低 |
| 单文件过大仍崩 | Obsidian 无流式读，>500MB 单文件是硬边界 | 已列 Phase 3；本次先覆盖 <500MB |
| 我无法真机实测 | 所有改动需你验证 | 提供打点日志 + 步骤清单，快速迭代 |

---

## 六、交付物
- 源码改动（移除 Pro + 内存修复）
- 重新构建的 `main.js`
- 更新后的 `IPHONE_TEST_STEPS.md`
- 改动说明与回滚点

---

**确认此方案后我即开工。** 若某处取舍想调整（例如并发降到多少、是否保留某后端），直接告诉我。

# 圣经模块 · 准备工作记录（数据与节号）

日期：2026-11-15。目的：在写圣经模块之前，把「经文数据从哪来、对不对、节号怎么对齐」弄清楚。

## 1. 数据来源与授权

全部来自 eBible.org 发布的 USFM 包（`https://ebible.org/Scriptures/<id>_usfm.zip`）。授权以各包自带的 `copr.htm` 为准：

| 译本 | eBible id | 授权（包内声明） | 说明 |
|---|---|---|---|
| 新标点和合本（简体） | `cmn-cu89s` | Public Domain | 神版 |
| 新标点和合本（繁体） | `cmn-cu89t` | Public Domain | **上帝版**（「上帝」而非「神」），与简体是两个不同的文本，不只是字形转换 |
| World English Bible | `engwebp` | Public Domain | 「World English Bible」是 eBible.org 的商标：**改动经文正文就不能再叫这个名字**。我们只去掉标记，不改文字 |
| King James Version | `eng-kjv2006` | Public Domain | 1769 标准文本。英国有皇家特许：在英国印刷或进口纸质本需要许可，对其他地区无效 |

**不能内置的**：ESV、NIV 等有版权的译本，只能由用户自己导入（见第 5 节）。

## 2. 数据核对结果

用 `scripts/scripture-check.mjs` 逐卷逐章逐节核对：

- 四个译本都是 **66 卷、1189 章**。
- KJV **31102 节**，与公认总数一致，无空节。
- WEB 31103 节，有 5 节为空（这些节在较早抄本里没有，WEB 按校勘本省略）：LUK.17.36、ACT.8.37、ACT.15.34、ACT.24.7、ROM.16.25。
- 和合本 31021 条，其中 **70 条是合并节**（如 `GEN.24.29-30` 在和合本里印成一节）。
- 和合本简体与繁体的章节结构**完全一致**。

## 3. 节号不一致（对照视图要处理的）

和合本与英文译本，章内最大节号不同的有 5 处：

| 位置 | 和合本 | WEB | KJV | 原因 |
|---|---|---|---|---|
| JHN 7 | 52 节 | 53 节 | 53 节 | 7:53–8:11（行淫妇人段）：和合本放在 8 章 |
| ROM 14 / 16 | 23 / 27 | 26 / 25 | 23 / 27 | 末尾颂赞词的位置：WEB 放在 14:24–26，KJV 和和合本放在 16:25–27 |
| 3JN 1 | 15 | 14 | 14 | 和合本把最后一节分成两节 |
| REV 12 | 18 | 17 | 17 | 和合本把 12:18 放在 13:1 之前，英文本算作 13:1 |

另外，**章内最大节号相同、但中间有合并节**的情况不会出现在这张表里，要靠合并节（verse_end）处理。

**建议的做法**：以 KJV 的节号体系为统一坐标（Protestant 通行，与 OSIS 默认一致），做一张很小的「差异映射表」（上面这 5 处加和合本的 70 个合并节），多译本按节对齐时先经过映射。这张表只有几十行，可以手工校对。

## 4. 数据格式决定

- **卷 id**：用 USFM / Paratext 三字母代码（`GEN`、`JHN`、`1CO`…），语义地址写作 `JHN.3.16`、范围 `JHN.3.16-18`。
- **表结构**（`scripture.db`，只读）：
  - `versions(id, name, lang, is_bundled)`
  - `books(id, ord, testament, name_zh, abbr_zh, name_en, abbr_en, chapters)`
  - `verses(version_id, book_id, chapter, verse, verse_end, text)`：`verse = 0` 表示诗篇的标题（如「大卫的诗。」），`verse_end` 用于合并节。
  - `verses_fts`：FTS5 trigram 全文索引（中文不需要分词表）。
- 经文正文是纯文本，诗歌的行用 `\n` 分隔；脚注、交叉引用、Strong 编号在构建时丢弃（WEB、KJV 的源文件里有 Strong 编号，将来做原文词义可以另建表）。
- 中文里的多余空格已去掉（和合本源文件在「神」前面有全角空格）。

## 5. 体积与分发（已决定）

四个译本带全文索引做成一个库约 59 MB，太大。改为：**一个译本一个数据包**（gzip 压缩的 JSON，约 1.2–1.3 MB），全文索引在本机按需生成。

| 译本 | 安装包 | 来源 |
|---|---|---|
| 和合本（简体） | **内置** | 公版 |
| World English Bible | **内置** | 公版 |
| 和合本（繁体・上帝版）、KJV | 设置里下载 | 公版，放 GitHub Release（标签 `bible-data-v1`，附 `manifest.json`） |
| ESV 及其他有版权的译本 | **不内置、不分发** | 用户自己导入，只保存在用户本机 |

- 下载只在用户主动点击时发生，点之前写明来源与大小，只读取、不上传；清单里留「备用地址」字段，以后可加镜像。
- 必须保留「手动导入」：把数据包文件拷过去选择导入，不依赖网络（受限网络、内网环境）。
- 下载后校验 SHA-256，校验不过不启用。

### 有版权译本（ESV 等）

ESV 的版权方 Crossway 只允许免授权引用不超过 500 节，且不超过任何一卷的一半；整本放进安装包、仓库或下载包都需要书面授权。所以：

1. **A（先做）**：用户导入自己合法拥有的文件，在本机转换保存。支持 Zefania XML、OSIS XML、本应用的 JSON 数据包，以及用户的 ESV Digital Scripture Journal PDF。
2. B（以后）：用户填自己的 ESV API 密钥联网取经文（官方限非商业、每次不超过 500 节，本地缓存条款需核对官方文档）。
3. C：向 Crossway 申请书面授权后才可内置。

## 5.1 数据包格式 `marginalia-scripture-1`

```json
{ "format": "marginalia-scripture-1", "id": "cuv-hans", "name": "和合本（简体）", "lang": "zh-Hans",
  "license": "Public Domain", "source": "eBible.org cmn-cu89s",
  "books": { "GEN": [[1, 1, 1, "起初，神创造天地。"], ...], "PSA": [[23, 0, 0, "大卫的诗。"], ...], ... } }
```

行是 `[章, 节, 末节, 文本]`；`节 = 0` 是诗篇标题；`末节 > 节` 表示合并节。用户导入的译本可以只含部分卷（如只有新约）。`scripts/scripture-pack.mjs` 生成数据包和清单，用户导入的各种格式也转换成同一个结构后再写入本机。

## 6. 脚本

- `scripts/scripture-usfm.mjs`：USFM 解析与清理（共用）。
- `scripts/scripture-check.mjs`：核对和比较节号。
- `scripts/scripture-pack.mjs`：生成数据包与 `manifest.json`。
- `scripts/build-scripture.mjs`：把几个译本合成一个带全文索引的库（开发时用来试查询速度，不用于发布）。

下载的 USFM 原文件不进入仓库，只在构建时使用。

## 7. 还没做

- 差异映射表（第 3 节）。
- 引用识别用的中英文缩写表（和合本的 `abbr_zh` 在源文件里只有部分卷有，需要手工补全）。
- 外部译本导入（Zefania / OSIS / JSON，以及用户的 ESV 日志 PDF）。
- 虚拟文档接入阅读器的小原型。

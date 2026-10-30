# 第三方依赖许可证盘点

许可证元数据与本地 Worker 构建产物复核日期：2026-10-30。许可证数字来自当前 `package-lock.json` 中 635 个依赖包条目（不含根项目）的元数据。构建路径检查依据本次标准构建的 Vite `build.license` 模块来源报告，以及 `npm ls --omit=dev sharp caniuse-lite`。标准构建已接入许可材料生成，具体范围与尚未闭环的例外见下文。该清单是工程核对，不替代法律意见；更新依赖或改变分发方式时应重跑。

## 项目自身许可

项目代码采用 PolyForm Noncommercial License 1.0.0，见根目录 `LICENSE`；`package.json` 与 lockfile 均声明 `PolyForm-Noncommercial-1.0.0`。这限制项目代码的商业使用，但不替代、也不改变依赖各自的许可证。分发时必须保留随依赖提供的版权和许可声明，不可用项目许可证覆盖依赖许可证。

## 静态品牌资源

- USDGO 图标在本项目中的使用许可状态：**待确认**。当前保留图标及来源记录，不将来源确认等同于已获再分发授权；详细证据见下文。
- `public/bitcoin.svg` 使用 Wikimedia Commons 的 [Bitcoin.svg](https://commons.wikimedia.org/wiki/File:Bitcoin.svg)。Commons 将该图标标记为公有领域（简单图形/文字，不满足版权原创性门槛）；页面同时提醒 Bitcoin 标志可能在部分司法辖区受商标保护。项目仅将其用作 BTC 资产标识，不表示与 Bitcoin Foundation 或其他组织存在关联。
- `public/GitHub_Lockup_Black_Clearspace.svg` 是页脚指向项目源码仓库的 GitHub 组合标识。使用时参考 [GitHub 官方品牌规范](https://brand.github.com/foundations/logo)和[GitHub Logo Policy](https://docs.github.com/en/site-policy/other-site-policies/github-logo-policy)；该标识用于指示 GitHub 仓库，不表示 GitHub 认可本项目，也不表示项目许可证覆盖 GitHub 的名称或商标。
- `public/usdgo.svg` 是 USDGO 标识，页面将其用作资产图标。用户于 2026-10-21 确认来源为 [USDGO 官网](https://www.usdgo.com/)；具体原始素材 URL 尚未核实。已从官网页脚打开并读取 [Terms and Conditions](https://static.usdgo.com/static/assets/pdf/terms.pdf)（标注 January 2026）：第 4 条仅授予个人、信息用途的网站访问使用许可，未经同意不得修改、复制、抓取或制作网站衍生内容，相关标识权利属于 OSL Group 或其许可方。该条款不是对本项目再分发图标的明确授权；仅注明来源不能补足授权。公开分发前应取得适用许可，或经用户同意改用不复制官方标识的通用占位图形/资产文字；不能仅换个下载网站就认为权利问题已解决。这是发布风险处理建议，不是对具体使用是否构成侵权的法律定性。

## 实际打包的 JavaScript 与许可材料

Vite 原生许可报告依据实际输出 chunk 的模块来源识别包，而非将 lockfile 的 635 个条目全部计为浏览器分发物。当前客户端和 SSR 报告均含下表前 10 个包，RSC 服务端报告含 6 个包（其中 `jose` 不在客户端）；三者去重合计 11 个包。各包自身元数据均为 MIT；这不代表包内复制的第三方代码也可忽略其独立声明。

| 实际打包的包 | 版本 | 已找到的许可全文/版权记录 |
|---|---|---|
| `@unpic/core` | 1.0.3 | 安装包缺全文；对应源码标签的根 README 明确给出项目级 MIT 及 © Matt Kane 2023，同标签 `packages/react/LICENSE` 提供相符的 MIT 全文；可据此补齐项目级归属，不能声称安装包本身已附全文 |
| `@unpic/react` | 1.0.2 | 安装包 `LICENSE`，2023 Matt Kane |
| `@vitejs/plugin-rsc` | 0.5.38 | 安装包缺全文；已按 npm `gitHead` 找到对应源码提交的根 `LICENSE`，2019–present Yuxi (Evan) You and Vite contributors |
| `ipaddr.js` | 2.5.0 | 安装包 `LICENSE`，2011–2017 whitequark |
| `react`、`react-dom`、`react-server-dom-webpack` | 各 19.3.1 | 各包 `LICENSE`，Meta Platforms, Inc. and affiliates |
| `scheduler` | 0.28.0 | 安装包 `LICENSE`，Meta Platforms, Inc. and affiliates |
| `unpic` | 4.2.2 | 安装包及 npm `gitHead` 对应源码树未找到独立 LICENSE；元数据声明 MIT，完整版权文本仍待确认 |
| `vinext` | 1.3.1 | 安装包 `LICENSE`，2026 Cloudflare, Inc.；另有 `THIRD_PARTY_LICENSES.md` |
| `jose`（仅 RSC 服务端） | 6.2.14 | 安装包 `LICENSE.md`，2018 Filip Skokan |

版本对应证据：[`@unpic/core` 包元数据](https://github.com/ascorbic/unpic-img/blob/%40unpic/core%401.0.3/packages/core/package.json)、[同标签项目 README 的许可声明](https://github.com/ascorbic/unpic-img/blob/%40unpic/core%401.0.3/README.md#license)、[同标签 MIT 全文](https://github.com/ascorbic/unpic-img/blob/%40unpic/core%401.0.3/packages/react/LICENSE)、[Vite 插件对应提交的 LICENSE](https://github.com/vitejs/vite-plugin-react/blob/2e8512f98a4fc1b302af760c9d41900c2fa66d0a/LICENSE)、[`unpic` 对应源码提交](https://github.com/ascorbic/unpic/tree/eefd6174338cc1377f8f238b84af94f48acd6da4)。

[MIT 条款](https://opensource.org/license/mit)要求随软件副本或实质部分保留版权和许可声明；浏览器收到的打包代码也应纳入声明材料处理，不能仅在依赖元数据写 `MIT`。标准构建通过 `scripts/third-party-notices.mjs` 将各环境的实际包许可、已核实的版本绑定补充材料、Vinext 附带的第三方声明及字体 OFL 合并成 `third-party-notices.txt`。客户端文件随静态资源发布，可通过站点的 `/third-party-notices.txt` 读取；服务端与 SSR 产物也各保留本环境文件，服务端专用 `jose` 不混入客户端清单。`.vite/third-party-licenses.json` 保留原始包来源报告，不代替补齐后的文本文件。文件仅供读取，不新增页面提示或首屏请求。

`vinext/THIRD_PARTY_LICENSES.md` 另列出 `ua-parser-js` 的 MIT 声明及从 dotenv 16.3.1 改编解析器的 BSD 风格声明。当前检查未找到这两段代码进入应用输出的直接证据；不能把它们当成本项目新增依赖，也不能在以后采用相应功能时只保留 Vinext 自身的 MIT。提供完整 Vinext 分发物时应一并保留这些上游声明。

`licenses/unpic-img-MIT.txt` 与 `licenses/vite-plugin-react-MIT.txt` 保存上述已核对的上游全文；它们只用于代码中绑定的包版本及 MIT 标识，不自动套用到升级版本。Vite 原生报告只读取包许可文件，因此额外保留 Vinext 的 `THIRD_PARTY_LICENSES.md`，并附加 `licenses/geist-OFL.txt`。新增包缺少标识/全文、或已核对包升级后仍缺全文时，构建报错，要求重新核对，不静默省略。`unpic@4.2.2` 是明确保留的待确认例外：输出其原始 MIT 元数据和缺口说明，不借用 `@unpic/core` 的版权文本，也不声称整体许可材料已齐全。此例外仅限该版本及 MIT 标识。

`unpic` 完整版权声明的状态：**待确认**。其包元数据已声明 MIT，但当前安装包和对应源码 README 未找到完整版权声明；不能从作者网站的页脚年份推造代码版权文本，也不能挪用同作者另一个项目的 LICENSE 后宣布问题已解决。当前保留依赖；后续可先向上游询问/请求补齐该版本声明，再决定保留还是评估替代路径。对外提 issue、联系作者及替换依赖均需用户授权；在缺口闭环前不得标为许可材料齐备。

## 本地分发字体

`app/layout.tsx` 使用 Geist 与 Geist Mono。当前构建含 11 个 WOFF2 文件（Geist 5 个、Geist Mono 6 个）。解析其 WOFF2/OpenType `name` 表确认版本分别为 1.800 和 1.701；各文件保留了 2024 The Geist Project Authors 版权及 `https://openfontlicense.org` 链接，但没有许可全文字段（name ID 13），也没有 WOFF2 扩展元数据块。

Google Fonts 的 [Geist OFL](https://github.com/google/fonts/blob/main/ofl/geist/OFL.txt) 与 [Geist Mono OFL](https://github.com/google/fonts/blob/main/ofl/geistmono/OFL.txt)均为 SIL OFL 1.1，版权主体与字体内部记录相符。[OFL 第 2 条](https://openfontlicense.org/open-font-license-official-text/)要求分发时附带版权与许可，可使用单独文件或易于读取的嵌入元数据。现有字体已含版权与链接，但不能把链接视为已附带许可全文；已在 `licenses/geist-OFL.txt` 保留两者相同的版权及 OFL 全文，并自动合入上述可访问的许可文件。没有修改字体或将应用代码改为 OFL；未来更换字体时需复核并更新这份补充材料。

## Lockfile 许可证分布

| 许可证元数据 | 包数 | 初步处理 |
|---|---:|---|
| MIT | 504 | 通常保留版权与许可证文本 |
| Apache-2.0 | 46 | 保留许可证及 NOTICE（若上游提供） |
| MPL-2.0 | 28 | 当前均标记为开发依赖；分发相关文件或修改时保留 MPL 条款和声明 |
| ISC | 19 | 保留许可文本和版权声明 |
| BSD-2-Clause / BSD-3-Clause | 13 | 保留许可文本和免责声明 |
| LGPL-3.0-or-later 及组合声明 | 14 | 主要是 sharp 的平台绑定/libvips 预编译包；检查是否进入目标平台分发物，以及相应 LGPL 义务 |
| 其他（0BSD、BlueOak、CC-BY、CC0、Python-2.0、MIT OR Apache-2.0） | 11 | 按具体包保留归属与许可条件 |

数量按 lockfile 包条目统计，组合许可证按其原始表达式单独计数，不是去重后的许可证种类数。

## 需要重点注意的依赖路径

- 当前 lockfile 将 `sharp` 固定为 `0.35.5`；其平台可选依赖 `@img/sharp-libvips-*` 声明 `LGPL-3.0-or-later`。本次本地 Worker 构建产物中未找到 Sharp/libvips 文件或原生二进制；Server bundle 中出现的 `sharp` 字样属于 Next 图片优化配置，不能据此或仅凭文件名扫描断言该依赖绝不会被运行时加载。若改为 Node 服务、改变 Next 图片优化路径或将 `node_modules` 随发布物分发，须重新核实 LGPL 的动态替换、许可文本和源代码义务。
- `caniuse-lite@1.0.30001810` 声明 `CC-BY-4.0`，由 Next/Browserslist 工具链引用。本次构建产物中未发现其数据文件；若将数据本身或含数据的产物再分发，应按 CC-BY 要求提供归属。
- `MPL-2.0` 项目均在当前 lockfile 中标记为开发依赖。当前没有对这些包做本地修改；如果修改并分发受 MPL 覆盖的文件，应按 MPL 公开该文件的源代码并保留声明。
- 2026-10-30 本地 Worker 构建未发现 LGPL/libvips 或 CC-BY 数据文件；Vite 实际模块来源报告也未列出这些包。该结论仅适用于当前目标与代码路径，不证明其他交付方式下无需履行相应义务。标准构建保留原始许可报告及补齐后的可读文本，仍需核对产物内容与静态资源实际可访问性；不能仅凭生成文件成功认定所有例外已关闭。

## 结论与待办

基于 2026-10-30 的本地 Cloudflare Worker 构建检查，未发现要求项目整体改换许可证或替换依赖的明确冲突。已接入实际分发 JavaScript 已确认版权/许可材料及字体 OFL 全文的自动生成；`@unpic/core` 的项目级版权声明已有对应版本证据，`unpic` 的完整版权文本仍待确认，不能宣称盘点已闭环。USDGO 官网来源及其限制性条款已核实，但尚未取得适用于本项目分发该图标的明确许可，保持待确认。将应用移到 Node 主机、分发依赖包或改变构建方式时，应重新检查 Sharp/libvips、caniuse-lite 等依赖的义务。

这里的“未发现明确冲突”是有限范围的技术盘点，不构成对 PolyForm 与所有依赖许可证组合的正式法律意见。

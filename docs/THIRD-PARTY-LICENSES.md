# 第三方依赖许可证盘点

盘点日期：2026-10-07。许可证数字来自当前 `package-lock.json` 中 628 个依赖包的元数据，并与 `npm ls --omit=dev sharp`、本地 Worker 构建产物作了交叉检查。该清单是工程核对，不替代法律意见；更新依赖或改变分发方式时应重跑。

## 项目自身许可

项目代码采用 PolyForm Noncommercial License 1.0.0，见根目录 `LICENSE`；`package.json` 与 lockfile 均声明 `PolyForm-Noncommercial-1.0.0`。这限制项目代码的商业使用，但不替代、也不改变依赖各自的许可证。分发时必须保留随依赖提供的版权和许可声明，不可用项目许可证覆盖依赖许可证。

## Lockfile 许可证分布

| 许可证元数据 | 包数 | 初步处理 |
|---|---:|---|
| MIT | 496 | 通常保留版权与许可证文本 |
| Apache-2.0 | 46 | 保留许可证及 NOTICE（若上游提供） |
| MPL-2.0 | 28 | 当前均标记为开发依赖；分发相关文件或修改时保留 MPL 条款和声明 |
| ISC | 19 | 保留许可文本和版权声明 |
| BSD-2-Clause / BSD-3-Clause | 15 | 保留许可文本和免责声明 |
| LGPL-3.0-or-later 及组合声明 | 14 | 主要是 sharp 的平台绑定/libvips 预编译包；检查是否进入目标平台分发物，以及相应 LGPL 义务 |
| 其他（0BSD、BlueOak、CC-BY、CC0、Python-2.0、MIT OR Apache-2.0） | 10 | 按具体包保留归属与许可条件 |

数量按 lockfile 包条目统计，组合许可证按其原始表达式单独计数，不是去重后的许可证种类数。

## 需要重点注意的依赖路径

- 当前 lockfile 将 `sharp` 固定为 `0.35.5`；其平台可选依赖 `@img/sharp-libvips-*` 声明 `LGPL-3.0-or-later`。当前本地 Worker 构建产物中未找到 Sharp/libvips 文件或原生二进制；服务端代码仍包含 Sharp 名称引用，不能仅凭文件名扫描断言该依赖绝不会被运行时加载。若改为 Node 服务、改变 Next 图片优化路径或将 `node_modules` 随发布物分发，须重新核实 LGPL 的动态替换、许可文本和源代码义务。
- `caniuse-lite@1.0.30001810` 声明 `CC-BY-4.0`，由 Next/Browserslist 工具链引用。当前构建产物中未发现其数据文件；若将数据本身或含数据的产物再分发，应按 CC-BY 要求提供归属。
- `MPL-2.0` 项目均在当前 lockfile 中标记为开发依赖。当前没有对这些包做本地修改；如果修改并分发受 MPL 覆盖的文件，应按 MPL 公开该文件的源代码并保留声明。

## 结论与待办

基于当前本地 Cloudflare Worker 构建，没有发现 LGPL/libvips 原生库或 CC-BY 数据文件被打入部署产物；本次也没有发现要求项目整体改用其他许可证的明确冲突。运行时依赖图仍包含 Sharp/libvips 与 caniuse-lite，因此将应用移到 Node 主机、分发依赖包或改变构建方式时要重新检查。公开发布时保留各依赖随包许可证/NOTICE；若分发包含 LGPL 或 CC-BY 组件的构建物，再按该组件的具体条件提供声明和对应材料。

这里的“未发现明确冲突”是有限范围的技术盘点，不构成对 PolyForm 与所有依赖许可证组合的正式法律意见。

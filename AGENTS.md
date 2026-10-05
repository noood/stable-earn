# 项目协作指引

- 进行发布审查或发布操作前，先阅读 `docs/RELEASE-CHECKLIST.md`，按“代码与功能、UI 与样式、开源安全、开源文档”四个方面检查并记录结果；未检查的项目明确标为未验证，不要推断为通过。
- 修改界面前阅读 `docs/DESIGN-SYSTEM.md`；涉及状态文案、刷新、缓存或收益口径时同时阅读 `docs/DATA-STATES.md`。优先复用 CSS token 和共享组件。
- 仅在用户明确要求时部署、修改 Cloudflare/GitHub 远程设置或写入生产 D1；不得读取或输出 Secret 值。

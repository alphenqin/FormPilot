# ADR 0001：M0 独立工程与旧源码迁移

后续变更：用户于 2026-11-16 明确授权删除旧工程，`legacy/` 已移除；下文迁移记录描述 M0 交付时状态。当前实现见 [M1 决策](0002-m1-local-vault.md)。

日期：2026-11-16。技术方案已获用户确认，本次实施范围为 M0。

## 决策

建立 pnpm workspace 与独立 apps/web、apps/extension、apps/api。根目录不再运行旧展示工程。依赖精确声明并提交新锁文件，Node 固定为实际验证环境 24.11.1，pnpm 固定为 10.26.2；后续升级通过 CI 验证。

## 迁移清单

| 原位置                                    | 新位置                         | 处理                                                      |
| ----------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| src/、public/                             | legacy/src/、legacy/public/    | 完整保留旧 UI、图片和已有修改，不参与新构建               |
| extension/                                | legacy/extension/              | 完整保留旧扩展，不作为新扩展加载目录                      |
| src/extension-source.ts                   | legacy/src/extension-source.ts | 只作为历史源码保留，退出活动下载/打包链路                 |
| index.html、vite.config.ts、tsconfig.json | legacy/ 下同名文件             | 保留旧入口和配置；新工作区有独立入口与共享 strict TS 配置 |
| package.json、.env.example、metadata.json | legacy/ 下同名文件             | 保存旧依赖、示例和元数据；根目录替换为新工作区配置        |
| .git、docs/                               | 保持原位置                     | 保持远端及历史，需求文档保持为业务基线                    |

迁移只移动现有文件，不覆盖旧文件内容，不清除个人浏览器数据。原图片可能含旧品牌；新工作区使用 FormPilot 文字标识与 CSS 字母图形，未引用旧图片。

## M0 的具体取舍

- MV3 最低 Chromium 120，API 使用 http://127.0.0.1:4318，Web 精确允许 http://localhost:3000。manifest 的回环 host 模式涵盖所有端口，因此 worker 固定请求一个 API origin 且拒绝重定向；外部消息在 worker 再检查完整 origin，网页不能传入 URL。匹配规则参考 [Chrome 官方文档](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)。
- 网页外部消息只接受顶层 frame、精确 sender origin 和共享 schema。扩展 UI 生成一次性随机配对码，网页兑换标签页会话，不能发起任意请求或填写命令。会话保存在 chrome.storage.session，网页令牌只在内存；worker 内存不是会话权威。
- health 与 capabilities 不含个人数据，M0 不为其引入业务会话、SQLite 或模型 key；业务 API 尚未实现且返回 404。敏感数据协议与存储在 M1 起实现。
- 用 Fastify inject 做接口验证，以真实监听端口做 HTTP 集成验证，以真实 Chromium 加载构建扩展做浏览器验证。三者分别记录，不混称网站业务验收。
- 日志使用字段白名单生成结构化 JSON，不启用 Fastify 默认请求日志，避免输出 URL/header 等额外内容；部署日志收集器可直接读取 stdout。此为技术方案 Pino 日志选型的 M0 简化，不增加日志库封装。
- React Router、共享 UI、domain、browser-engine、local-store、PDF、SQLite 在其实际需要的阶段引入；M0 不建立未使用的业务空包。四个核心 API 的精确 schema 仍按 PRD 在 M3 冻结。
- content.js 仅预留按需注入构建入口，不注册 content_scripts，不扫描招聘网页。popup/options/sidepanel 在 M0 共用连接诊断界面。

## 验收边界

M0 只能证明工程可构建和基础通信可用，不代表简历解析、资料加密、表单扫描、AI 计划或自动填写完成。后续阶段仍按 ROADMAP 独立验收。

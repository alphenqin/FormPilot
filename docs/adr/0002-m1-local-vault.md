# ADR 0002：M1 本地加密资料库与异步解析

日期：2026-11-16。用户已授权删除 legacy 并开始 M1，指定 DeepSeek、https://api.deepseek.com、deepseek-flash。密钥仅写入 Git 忽略的服务端 .env；本文及客户端不保存密钥。

## 本地资料与加密

资料主入口为扩展 options.html，popup/sidepanel 提供进入工作空间的入口。网页桥接仍只开放 pair/ping，不传输敏感资料。M1 不新增第二份网页资料库。

Dexie 数据库 formpilot-vault 的版本 1 只存一条 workspace 加密快照。快照内包括原文件、文档块、证据、全部事实版本、经历实体、授权与任务检查点、解析用量。公开元数据只有格式版本、随机工作空间 ID、CAS revision、KDF 参数、salt、包装密钥和密文。读入后校验 schema、证据与引用，未知版本明确拒绝，M0 无资料需要迁移。

随机 256 位 data key 使用不可导出的 Web Crypto CryptoKey，仅在当前解锁页面内存持有。口令经 PBKDF2-SHA256 派生 wrapping key，按设备校准至目标约 180 ms，至少 600000、最多 2000000 次；每个 vault 随机 16 字节 salt。AES-GCM 使用随机 12 字节 IV；AAD 绑定工作空间、格式及数据 revision。更新口令只重新包装 data key。

加密在 IndexedDB 事务外完成，事务内比较 revision、工作空间和 wrapped key，防止并发覆盖以及旧窗口还原旧口令。锁定使用 epoch 保护进行中的异步解锁/保存，并通过 BroadcastChannel 通知其他窗口；页面关闭需重新解锁。明文 UI 状态清空不保证 JavaScript GC 的即时内存擦除，不构成设备恶意软件防护。

加密备份采用相同格式；恢复只允许空资料库，先校验口令、AAD、版本及引用，再写入。删除清空本地记录和内存，备份文件不会随之删除。每次保存重加密完整快照，适合当前最多 20 文档/50 MB 的本地 MVP；更大数据量需未来分记录存储，尚无大规模性能承诺。

## 文本与领域规则

PDF.js 内置 worker 在扩展本地提取文本，按页/UTF-16 文本偏移分块；TXT 要求 UTF-8。无文本、受密码保护、超大或损坏文件明确失败。首版不做 OCR 或复杂版面还原，不提供 PDF 渲染坐标高亮；定位依据页码、原文块、连续 quote 与块内偏移。

模型只返回 candidates，不能生成确认状态。模型引用仅能来自本次 blocks，quote 必须为连续原文，文本值必须可在 quote 中找到，日期不得拼接范围数字或增加精度。基础信息/求职意向使用各自单例实体，其他每段经历分别创建实体；跨文档经历由用户显式映射，映射后重新确认。冲突保留所有值，未解决的冲突不进入 confirmedFacts；时间倒置提示，跨经历重叠不直接判错。

事实修改保留原 fact_id、新增 fact_revision 和 profile_revision，用户修改标记 source_type=user、confirmation=pending，原证据保留但不会假称修改后的值来自原文。手动补充也必须确认。

## API 与会话（M1 草案）

| 方法与路径                            | 用途                                             |
| ------------------------------------- | ------------------------------------------------ |
| POST /v1/sessions                     | 本地访问令牌授权，为指定工作空间签发 30 分钟会话 |
| DELETE /v1/sessions/current           | 撤销该会话并清理它拥有的任务                     |
| POST /v1/profile/parse                | schema/授权/文本摘要校验后返回 202 任务句柄      |
| GET /v1/profile/parse/jobs/:job_id    | 仅任务所属会话可查询状态与短期结果               |
| DELETE /v1/profile/parse/jobs/:job_id | 中止并删除本会话任务及结果                       |

业务认证使用独立 FORMPILOT_API_TOKEN，扩展用户手动输入并立即清空输入框；换取的短期 token 放 chrome.storage.session，模型密钥始终在后端。此为单用户回环开发环境的授权，不是多用户生产认证。每次授权绑定 provider、model、policy_url、blocks_hash、用途和时间，服务端重算摘要。来源文本、原始文件名和模型输出均不进入日志。

启动前扩展加密保存 client_request_id 和完整授权，再保存服务器句柄。若页面关闭发生在句柄落盘前，可在授权有效期内用相同请求 ID 重试；同会话同 ID 同体不重复调用模型，同 ID 不同体返回 409。异步查询不依赖长寿命 MV3 worker 或唯一内存变量。服务重启/结果过期明确报错，不伪造已完成状态。

M1 选择在 API 内存保留最多 20 个任务、每会话最多 2 个并行任务，结果 TTL 五分钟，定时及访问时清理，任务超时 60 秒。资料不落服务端磁盘，因此 M1 不引入 SQLite/WAL 或服务端密文持久化。服务重启会丢失短期结果，扩展保留本地检查点并提示重新授权解析；这是与后续持久化业务任务的明确边界。完成结果本地落盘后立即请求删除服务端副本，不能清除供应商已按其政策处理的数据。

## 供应商与验证边界

DeepSeek 当前使用 JSON Output，而非声称其提供严格 JSON Schema 输出。由 TypeBox 与确定性领域规则再次校验；拒绝、超时、空结果、截断、虚构证据均明确失败，最多一次瞬时失败重试，不生成虚构事实。官方协议参考 [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)；隐私处理链接 [DeepSeek 政策](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)。未承诺供应商零保留，实际费用依供应商账单。

测试区分纯规则、受控供应商替身、真实 Chromium 与显式开启的付费真实 DeepSeek。技术验证使用完全虚构样本，不能替代 PRD 要求的至少一份有授权真实简历验收；未获得该样本前 M1 不标为最终验收通过。

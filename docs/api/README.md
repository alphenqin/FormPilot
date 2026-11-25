# FormPilot API v1 契约

冻结日期：2026-11-17。机器可读文件由共享 TypeBox schema 生成：`pnpm schema:generate`；`pnpm schema:check` 检查漂移。各文件的 `request`、`response`、`failure` 是可独立使用的 JSON Schema，外层是接口描述信息。

| 接口 | 请求与响应 Schema | 当前行为 |
| --- | --- | --- |
| `POST /v1/profile/parse` | [parse.json](v1/parse.json) | 202 创建异步解析任务，GET/DELETE `/v1/profile/parse/jobs/:id` 查询或清理；维持 M1 兼容 |
| `POST /v1/fill/plan` | [plan.json](v1/plan.json) | 200 返回五类决策、问题、实体绑定及版本摘要 |
| `POST /v1/fill/resolve` | [resolve.json](v1/resolve.json) | 200 返回新版本；清除旧批准；补答默认仅 task 范围 |
| `POST /v1/fill/verify` | [verify.json](v1/verify.json) | 校验已持久化执行报告与计划/批准逐项一致，200 返回 REVIEW；没有执行检查点不能自报成功 |

所有响应采用 `{request_id,data,error}`，失败 `data=null`，错误正文不含用户值。所有业务接口要求 `Authorization: Bearer <session_token>`。用 `.env` 中独立本地访问令牌 POST `/v1/sessions`，请求 `{workspace_id}` 获取最长 30 分钟会话。单用户本机模型，不是多租户身份服务。工作空间身份取自认证会话，不接受请求另指定 owner。

plan/resolve/approve/invalidate/verify 与执行接口同时要求 `Idempotency-Key` 与 `client_request_id` 相同。相同键和相同规范化请求去重，参数不同返回 `IDEMPOTENCY_CONFLICT`；重启时仍未完成的预留返回 `TASK_INTERRUPTED`，不会自动再次付费。发生状态变化后，历史请求重放返回当前状态，防止复活旧批准。解析仍使用 M1 请求内 `client_request_id` 去重。

plan 同意信息绑定整个请求负载的规范化 SHA-256（去除 consent），供应商、模型、政策地址必须与服务器匹配，授权五分钟内有效，扫描不超过 15 分钟。模型仅收到字段、分组和经历名称。确定性规则从已确认事实或用户任务答案选择值，模型输出只允许字段 path 与实体引用，不允许值或批准。

## 审核与状态辅助接口

- `GET /v1/fill/tasks/:task`：当前工作空间的最新计划；重启后用本地令牌重新建立同工作空间会话即可恢复。未找到或超过 24 小时返回 404。
- `POST /v1/fill/approve`：请求须包含 plan_id、expected_plan_revision、plan_digest、approved_field_ids、observed_profile_revision、observed_snapshot_ref 和十秒内 observed_at；只允许选中 fill 字段，任何 review 必须先处理。返回 READY 与服务端生成的批准记录。
- `POST /v1/fill/invalidate`：同一任务和计划版本，reason 为 PROFILE_CHANGED/PAGE_CHANGED/USER_CANCELLED；返回 DRAFT，清除批准。
- `DELETE /v1/sessions/current`：取消该会话的解析任务，清除所属工作空间的服务端计划与幂等记录。扩展“删除全部资料”在连接时调用，再删除本地密文；离线删除会明确提示服务端未确认清理。

resolve 支持 keep/replace/cancel/manual/edit/map_field/bind_entity；值修改仍受网页格式和精度约束。replace 仅接受当前原值冲突的精确候选，后续修改会再次要求确认。每个新计划分配新 plan_id、递增 plan_revision；state_revision 用于数据库 CAS，批准或失效也递增。旧 plan_id/revision、错 scope、未知字段/实体/问题均拒绝。

## 存储与错误

服务端使用 Node 24 内置 SQLite，`.runtime/formpilot.sqlite` 存放 AES-256-GCM 密文，身份索引使用带密钥 HMAC。每条记录有随机 IV、认证标签和绑定索引的 AAD。配置独立 64 位十六进制 `FORMPILOT_DATA_KEY`，不提供则关闭计划能力，health 与 M1 保持可用。保管密钥；更换密钥将不能恢复旧计划。记录有效期 24 小时，清理计时器约一分钟；已过期记录立即不可读取。扩展计划和历史随资料库加密备份；最多 30 个任务、每任务 40 个计划历史检查点与 20 个执行记录。SQLite v1 自动迁移至 v2 执行锁表。

主要错误：400 INVALID_REQUEST/CONSENT_REQUIRED，401 UNAUTHORIZED，403 SCOPE_DENIED，404 REFERENCE_NOT_FOUND，409 REVISION_CONFLICT/STALE_PLAN/IDEMPOTENCY_CONFLICT/TASK_INTERRUPTED/RULE_VIOLATION，503 STORAGE_UNAVAILABLE，409 EXECUTION_LOCKED/EXECUTION_EXPIRED/EXECUTION_INTERRUPTED。模型超时、拒绝、坏 JSON 或伪造引用导致 `degraded=true`，规则事实候选转 review；用户可输入任务值或转人工，不能静默批准模型值。

页面与资料只能由扩展观察，服务器校验客户端刚观察的引用与存储计划一致；它无法独立证明浏览器 DOM 未变化。M4 在页面内逐字段检查身份/结构/原值与资料版本，写后稳定回读；服务端仍不能独立证明企业网站保存。`application_submitted` 始终 false。


## M4 执行接口

辅助契约：[execution.json](v1/execution.json)。业务 session 鉴权、Idempotency-Key 与 client_request_id 一致；工作空间取自 session。

| 接口 | 行为 |
| --- | --- |
| `POST /v1/fill/executions/begin` | 用 plan_id/revision/digest、action（fill/retry/undo）、字段 ID、来源执行与刚观察的页面/资料引用申请 lease。服务端生成执行包；请求不能指定值。全工作空间只允许一个活动执行 |
| `POST /v1/fill/executions/checkpoint` | 绑定 execution_id/epoch/token/sequence。before 持久成功才写；after 记录实际值；completed/interrupted 保存最终报告。最终只能保留或降级已确认成功，不能升级失败 |
| `POST /v1/fill/executions/cancel` | 请求停止后续字段；已开始的字段仍须核对，不会自动撤销 |
| `POST /v1/fill/executions/interrupt` | 状态未知时标中断，actual=null、清除批准、释放锁；不虚构成功或重放 |
| `GET /v1/fill/tasks/:task/executions` | 获取当前工作空间最近 20 个加密执行检查点，供同步与人工审查 |

执行 lease 最长十分钟且不超过计划期限；扫描和页面权限仍须有效。执行状态为 WRITING，结束为 REVIEW；撤销或状态未知使计划回到 DRAFT 并清除批准。retry 仅允许有效旧批准下失败字段的新执行，undo 仅针对来源记录实际写入字段；浏览器还校验原页面内编辑历史。

verify 的 v1 请求/结果结构保持 M3 冻结形状，M4 将原 501 改为真实核验实现：报告必须与该次执行持久记录完全一致，逐项核对 before/target/actual、字段范围与批准，不接受客户端宣称成功。响应仅针对本次执行，历史记录不代表当前整张表的状态；回读成功仍不等于网站保存或提交申请。

执行检查点与 verify 请求上限为 8 MiB，仍限制至多 250 个字段及有界值；字段报告不含任意可执行脚本。begin 的状态变更、锁与幂等响应在同一 SQLite 事务提交。页面/标注变化的最终报告使批准失效，不能以旧报告继续核验或写入。

## M5.1 JD 异步解析

契约：[career.json](v1/career.json)。`POST /v1/career/jd/parse` 返回 202；`GET /v1/career/jd/jobs/:id` 查询，`DELETE` 取消/清理。业务 session 的工作空间隔离结果；同一资料库重新连接可恢复。要求 Idempotency-Key 等于 client_request_id，以及 5 分钟内的 jd_parse 授权、所选供应商/模型/政策和 hashJson({ source }) 摘要。请求上限 128 KiB，正文上限 20000 字符，同工作空间最多 2 个运行任务，服务内最多 20 个结果。

上游仅收到 text；严格校验原文引用，失败不会返回候选结果。服务端内存保存 5 分钟、默认解析超时 60 秒；重启不恢复或重付费，删除/撤销中止并拒绝迟到结果。个人匹配为浏览器本地规则，无服务端个人资料匹配接口。旧四项业务契约保持不变。

## M5.2 本地岗位简历

capabilities stage 更新为 M5.2，新增 resume_tailor_local 能力标记。简历生成、编排、审核和导出在浏览器本地执行，无新增 HTTP 接口。事实及原始材料不发送给 JD 模型；本地契约见 packages/contracts/src/resume.ts。career.resumes 为可选字段，旧资料和备份可由新版读取。原四项业务接口及 JD 异步接口保持兼容；服务端不保存岗位简历副本。

## M5.3 开放题异步生成

契约：[answers.json](v1/answers.json)。POST `/v1/career/answers/generate` 返回 202；GET/DELETE `/v1/career/answers/jobs/:id` 查询/取消；GET `/v1/career/answers/requests/:id` 按原 client_request_id 只读恢复，不启动模型。session 按工作空间隔离，同工作空间重新连接可查询；撤销会话清理相关任务。

Idempotency-Key 必须等于 client_request_id；answer_generate 授权绑定供应商、模型、政策、5 分钟时效及 hashJson(input)。请求上限 512 KiB，语义输入上限 120000 字符，选择 1～16 条事实、模型最多引用 6 条、草稿 6000 字符。每工作空间最多 2 个运行任务、服务端最多 20 个缓存任务；默认超时 60 秒、结果内存保留 5 分钟。日志仅保留原有白名单元数据。

服务端仅能验证客户端提供的引用和值是否一致，不能独立证明事实真实性或确认状态；扩展在发送和保存时核对本地事实，审核/导出重新检查当前版本。生成结果不含本人审核批准；本人编辑和审核完全在本地，未自动调用 M4 写入。capabilities stage 为 M5.3，新增 answer_generate。原四项与 JD API 保持兼容。

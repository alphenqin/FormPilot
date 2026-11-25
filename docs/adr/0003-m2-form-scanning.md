# ADR 0003：M2 按需扫描、页面作用域与会话恢复

日期：2026-11-16。用户授权继续 M2，并要求覆盖主流公司官方招聘站。M1 的真实简历验收保持待完成，不因推进 M2 自动视为通过。

## 入口与边界

Popup/sidepanel 提供目标标签页选择、开始/停止、预览、人工标注与定位。manifest 权限保持 activeTab、scripting、storage、sidePanel，持久 host 仍只有回环 API，没有 all_urls 或全站 content_scripts。用户在目标页面调用扩展后，由 Chrome 授予 activeTab 临时权限，见 [Chrome 官方说明](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)；scripting 只注入 frame 0 的隔离 world，见 [scripting 文档](https://developer.chrome.com/docs/extensions/reference/api/scripting)。未授权页面实际注入失败，网页 pair/ping 通道不开放扫描方法。

`packages/browser-engine` 只读页面原生控件与相关 label/ARIA/legend/选项/约束，不读 body 全文、cookie、整页 HTML 或其他网页存储。敏感控件在读值前过滤，文件控件不访问 files/name/value。自定义组合控件明确 manual，iframe 不递归、不跨 frame，open Shadow DOM 仅提示；closed Shadow DOM 无完整探测保证。三家官方站点只有 hostname 分类与公开入口证据，能力表不冒充实际申请表适配。

## 快照与定位

扫描会话由 worker 生成 task_id，绑定 tab_id、frame 0 和 15 分钟期限。内容运行时为当前文档生成 page_instance_id；URL 变化（含 SPA query/hash）更新页面身份。对外 route 去掉查询参数、普通 hash 与高熵/邮箱路径段，原始 href 只在页面隔离内存比较，不输出或保存。

DOM 元素通过 WeakMap 获得会话内稳定 field_id、locator_ref，radio 按原生 form/name 分组，重复标签不会复用 ID。定位仅使用当前文档元素引用，不接受网页/模型提供的 CSS 或脚本。执行定位前再次采集，严格校验 task/tab/frame/page/snapshot/fingerprint，节点替换即使 HTML id 相同也会生成新身份。

SHA-256 结构指纹包含字段身份、类型、标签、分组、约束、选项和适配器版本，不含 current_value 或人工标注。值变化创建新快照但不改变结构指纹；显式重扫或人工标注也创建新快照，旧定位引用拒绝。结构变化清除旧标注；装饰性 DOM 变化不改变有效快照。采集前后再次比较投影，页面持续变化时拒绝发布稳定快照。

MutationObserver 与 input/change 事件触发去抖重扫，800 ms 补偿检查无事件属性值/路由变化；预览约 1300 ms 读取。每次定位仍会重新核对，不依赖观察器事件恰好到达。高亮只滚动并添加短暂 pointer-events:none 覆盖层，不调用 focus/click/setter，不发 input/change，不修改原控件。

## 生命周期与隐私

worker 串行化授权/停止和导航清理，短消息有超时。chrome.storage.session 只存 task/tab/期限等元数据，字段值、快照和标注仅在内容脚本和预览内存。worker 停止后从元数据联系原页面恢复；完整页面导航/关闭清理授权，不把旧快照转移到新文档。会话结束清理观察器、定时器、引用和覆盖层。UI 使用请求代次，防止停止后迟到查询重新显示旧数据。

M2 不保存快照到 M1 资料库，也不调用 API/模型。M3 如需持久化任务、使用事实和发送字段，必须另外绑定已解锁工作空间与明确授权，不把扫描当作模型授权。

## 协议与容量

共享 scan schema 与现有外部 pair/ping schema 分离；内部方法为 scan.start/get/refresh/stop/locate/annotate，worker 到内容脚本增加 scan.initialize/read。来源精确校验扩展 ID、协议、路径，方法 payload 禁止意外属性；定位引用绑定完整作用域。错误区分权限、受限页、旧快照、页面变化、未知字段、过期及容量上限。

最多 250 字段、500 分组、每字段 200 选项，字段值 4096 字符、标签 200，采集预览约 1.5 MB。超限标明 incomplete/manual 或明确失败；complete 仅指受支持顶层采集是否触发限额，不代表整站、自定义控件或 iframe 已完整覆盖。M2 schema 是扫描契约，不提前冻结 M3 四个算法 API。

## 验证

纯函数/协议单测、三套真实浏览器 DOM 组件用例、实际构建扩展的端到端用例分别记录。扩展自动测试使用 manifest 原有回环 host 权限，没有给测试扩展追加外站权限；未授权 localhost origin 的拒绝路径单独测。实际外站 activeTab 人工动作和登录申请表不能由回环模板测试替代。真实站点公开页脚本仅只读检查，无账号、投递或表单提交。

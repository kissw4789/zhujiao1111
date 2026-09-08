# 苏E好学 · 助教系统项目文件（PROJECT.md）

> **任何 AI 接手本系统，第一步先读本文件。** 这里汇总了系统的全部现状、规则、可用工具与经验。
> 更新时间：2026-09-09（二期分层开发推进中，最新提交 1be6567）。本文件取代旧《系统全量交接文档.md》《运维避坑与速查手册.md》《业务流程与待办联动·学员分层设计方案.md》，旧文档已归档 `deploy_zhujiao/_archive/2026-09-08_legacy_docs/`，不再作为主入口。

---

## 一、系统定位与实时体量

**定位（老板钦定）**：助教本人的个人工作网站，一切从助教日常视角设计。纯助教服务导向，无营销电销逻辑。

**2026-09-08 云端实时口径（以当次拉取为准）**：

| 项 | 数字 | 说明 |
| :--- | :--- | :--- |
| 学员档案 | **326**（在读288/已结课32/待开课6） | 含 45 个 C- 前缀拆分档案 |
| 家庭 | 281 户 | families 表 |
| 报名流水 | **347** 条 | enrollments；在班口径 301 人次 / 去重 282 人 / 46 门班 |
| 班级视图 | 49 行 = 46 在班 + 3 空班 | classes 表 92 行 |
| 排课矩阵 | 94 项 | schedule_items |
| 订单 | 579 行 / 579 单 | 仅 2026暑+2026秋两季；全量历史底账见本地 Excel |
| 请假台账 | 4 条 | 第1讲缺课3人 + 金奕君事假；退费退班自动联动入台账 |
| 学情跟进 | 29 条（拓科跟进） | followups |
| 讲次反馈库 | 299 条（第1讲） | lesson_feedbacks，正文原汁原味 |
| 待办 | todos 表（216b032 已修复新增被劫持的致命 bug） | 可联动登记请假 |
| 首次报名时间 | 已修正 274 人 | min(最早报名开课, 最早订单支付) |

---

## 二、架构与部署

- **架构**：Vercel (Serverless 云函数 + 静态单页) + Supabase (免费云端 PostgreSQL)。**数据事实标准 = Supabase 云端**，本地 `data/*.json` 旧快照已废弃，严禁读取/依赖。
- **线上地址**：`https://zhujiao1111.vercel.app`
- **GitHub 仓库**：`https://github.com/kissw4789/zhujiao1111.git`（分支 `main`）
- **Supabase 后台**：`https://supabase.com/dashboard/project/sdrlxhfltyumcjvlqqlu`
- **本地代码目录**：`deploy_zhujiao/`（提交 GitHub 的主目录）
- **部署方式**：`git push origin main` 后 Vercel 约 15~20 秒自动上线。
- **代码分工（禁止回退为单文件）**：
  - 业务功能/界面：只改 `js/modules/dashboard.js`
  - 底层通讯/弹窗/工具：只改 `js/core.js`
  - 后端接口：只改 `api/[...route].js`（直连 Supabase REST）
  - `app.js` 仅十余行启动逻辑，严禁塞业务代码

---

## 三、数据模型（Supabase 云表）

| 表 | 说明 | 关键键 |
| :--- | :--- | :--- |
| `students` | 学员主档一人一档 | id, family_id, name, phone, grade, first_date |
| `families` | 家庭关系（二胎共用电话） | family_id, phone |
| `classes` | 班级主表 92 行 | id, class_name, teacher, campus, term |
| `enrollments` | 报名流水 347 条 | eid, student_id, class_name, is_void, active_in_latest |
| `schedule_items` | 排课时空坐标 94 项 | schedule_id, room, weekday, time_range |
| `orders` | 支付订单 579 单（仅暑秋） | id=order_no, child_id, amount, payment_status |
| `leaves` | 请假/退费消课台账 | lid, student_id, class_name, refund_amount |
| `followups` | 学情跟进/续班/拓科 | id(uuid), student_id, kind, note；subject/creator 在 raw |
| `op_logs` | 操作审计流水 | id, action, target, change |
| `lesson_feedbacks` | 讲次学情反馈库 299 条 | fid, student_id, lesson, status, content |
| `todos` | 助教个人待办 | tid, kind, due_date, status, link_leave_lid |
| `import_batches` / `raw_roster_rows` | 导入批次与原始行 | 已不再使用，保留 |
| `course_outlines` | 云端大纲（旧结构，未融合本地 175 讲） | id='main', payload |

---

## 四、业务规则与铁律

1. **以学员为基准，所有模块联动**：报名、班级、待办、请假、跟进、反馈任一变化，都实时反映到学员 360° 档案、首页看板、班级在班名单（均基于 enrollments 实时重算）。
2. **【老板 2026-09-08 指示 · 删除数据红线】**：
   - 凡涉及**删除学员 / 删除订单 / 删除档案**的操作，**必须老板拍板后才能执行**；
   - 若任务里删除项不确定，**先搁置到一边**；除非该任务本身只针对删除，否则**先完成所有其他任务**，把删除类任务留到最后，等老板拍板再改。
3. **学期口径**：2026秋为当期；`TERM` 已参数化——服务端按北京时间月份自动推导（3-5春/6-8暑/9-11秋/12-2寒），`TERM_OVERRIDE` 环境变量可钉住过渡期；前端 `curTermLabel` 同口径。**换季无需改代码**。
4. **待办提醒能力（当前状态）**：站内提醒（逾期立即 + 下班前按提醒时刻）+ Vercel Cron 每天北京 10:00 与 17:00 检查未办并触发提醒；**微信推送通道（Server酱/企业微信群机器人）老板尚未确定方案，暂不配置环境变量**，仅保留"有待办提醒"能力即可。
5. **敏感信息红线**：学员姓名/电话类数据、快照、_archive 永不进 git（`.gitignore` 已覆盖）。
6. **家长学情反馈格式**（手机端适配·永久执行）：每条反馈独立包裹在 ```text``` 代码块；维持头部+【本讲内容】【课堂表现】【课后建议】【课后作业】四模块；尊重老师原话不删减；严禁机械报数。
7. **执行铁律**：脚本报错禁止中途放弃，立即改为 `cat << 'EOF' > script.py` 写入独立文件自愈执行，必须跑到最终结果。

---

## 五、可用工具脚本索引（tools/ 目录）

> 规范：运行前先 `$env:PYTHONIOENCODING='utf-8'`；云端脚本统一走代理 `127.0.0.1:7897`。
> 2026-09-08 新增 `_lib.py` 公共库，**新写云端脚本一律引用它，禁止再复制登录/请求模板**。

### 5.1 云端公共库与三件套（最常用）
| 脚本 | 用途 | 用法 |
| :--- | :--- | :--- |
| `_lib.py` | **云端访问公共库**（登录、req、bootstrap重试、student_detail、dump_json） | `import _lib; _lib.login(); code,b=_lib.bootstrap()` |
| `_cloud_full_audit.py` | 云端全量盘点：登录→bootstrap→各表条数+状态分布→落盘 `_cloud_snapshot.json` | `python _cloud_full_audit.py` |
| `_analyze_snapshot.py` | 对快照细算（在读去重、缴费、反馈结构） | `python _analyze_snapshot.py` |
| `_cloud_retry.py` | 云端健康三次采样（应对偶发 500） | `python _cloud_retry.py` |

### 5.2 部署验证
| 脚本 | 用途 |
| :--- | :--- |
| `_verify_deploy.py` | push 后轮询验证 Vercel 新版是否上线（检查"在册"字段） |
| `_verify_v2.py` | 工作台 V2 部署验证（新字段/反馈端点/待办自检） |
| `_final_v2_check.py` | V2 终验（反馈进度/档案查询/待办全链路/提醒） |
| `_final_check.py` | 最终验证（临时端点已撤/bootstrap 健康/累计缴费正常） |

### 5.3 数据核对与去重诊断
| 脚本 | 用途 |
| :--- | :--- |
| `_excel_audit.py` | Excel 盘点（内置 read_only 假象修复） |
| `_deep_audit3.py` / `_deep_audit4.py` | 订单 xlsx vs 云端口径对比 |
| `_dup_diagnose.py` / `_dup_diagnose2.py` | 诊断 enrollments/orders 重复模式与 first_date |
| `_orders_check.py` | 云端订单核对 |
| `_non_autumn_orders.py` | 列出云端非暑秋历史订单 |
| `_classes_diff.py` / `_outlines_diff.py` | 班级/大纲与本地知识库对比 |
| `_cloud_probe.py` / `_cloud_probe2.py` | 云端探测（字段结构） |

### 5.4 反馈库
| 脚本 | 用途 |
| :--- | :--- |
| `_upload_feedbacks.py` | 299 反馈上传云端（质检→批量bulk→验证），`--go` 实际执行 |
| `_fb_inspect.py` | 反馈库质检 |
| `_fix_quyiming*.py` | 瞿奕铭串行污染修复（**已完成案例，勿重跑**） |
| `_fix_qijiayi.py` | 齐家奕修复（**已完成，勿重跑**） |

### 5.5 双人名拆分/归一化（历史运维，勿随意重跑）
`_split_plan.py`、`_split_run.py`、`_split_actions.py`、`_absorb_run.py`、`_export_merged_names.py`、`_resolve7_prepare.py`、`_resolve7_run.py`、`_purge_exec.py`、`_dedupe_run.py` —— 均为 9/8 一次性的档案拆分/归一化执行脚本，**结果已落库并验证，勿重跑**。

### 5.6 知识库构建（本地，与线上大纲无关）
`build_real_*_kb.py`、`batch_rebuild_kb.py`、`auto_rebuild_all_kb.py`、`extract_*`、`write_standard_lesson*.py`、`scan_*` 等 —— 构建本地 `课程知识库/` 的 175 讲 Markdown。云端 `course_outlines` 尚未融合（方案待老板拍板：替换 or 映射）。

### 5.7 反馈批量制作（本地）
`generate_all_feedbacks.py`、`batch_build_feedbacks.py`、`parse_xiaoming_batch.py`、`check_299_audit.py`、`dump_feedbacks.py` 等 —— 本地反馈文本处理。

### 5.8 数据导入（一次性的迁移工具）
`prepare_supabase_import.py`、`upload_to_supabase.js` —— Supabase 初始迁移，已使用过，不再需要。

---

## 六、标准作业流程（照此走）

1. **先读本文件**（PROJECT.md）→ 数字以当次实时拉取为准（`python tools\_lib.py` 自检或 `_cloud_full_audit.py`）。
2. **改动上线四连**（缺一不可）：
   ```bash
   cd deploy_zhujiao
   git add <明确指定文件>     # 禁止 git add .（tools/data 有敏感产物）
   git commit -m "feat/fix: 简要描述"
   git push origin main       # 沙箱内需提权执行（见踩坑#3B）
   python tools\_verify_deploy.py   # 验证线上真的生效
   ```
3. **删除类任务**（删学员/删订单）：先出清单 → 老板拍板 → 最后执行。
4. **SOP 改接口**:改 `api/[...route].js`；改界面:改 `js/modules/dashboard.js`；新增云表:需老板在 Supabase SQL Editor 执行一次 DDL，代码侧必须带"表不存在自动降级"保护（参考 todos/feedbacks 的 catch 写法）。

---

## 七、踩坑与经验（运维速查）

1. **PowerShell 中文乱码**：跑 Python 前先 `$env:PYTHONIOENCODING='utf-8'`；脚本一律 write 工具写成 `.py` 文件再执行，**禁止 `python -c "…中文…"` 单行**。
2. **Excel 空表假象**：`openpyxl read_only=True` 可能读出 0 行，换 `read_only=False` 重读确认。
3. **git 推送两连坑**：`schannel` 凭证失败 → 已配置 `http.sslBackend openssl` + 代理 `127.0.0.1:7897`，勿改回；沙箱内 push 抱 `CreateFileMapping Win32 error 5` → **提权执行**即可。
4. **云端偶发 500**：`JWT issued at future`（PGRST303）= 冷启动/时钟抖动，**重试即恢复，勿深挖**。
5. **`nul` 保留名文件**：脚本重定向误产物，`cmd /c 'del /f /q "\\?\C:\助教系统\nul"'` 删除。
6. **外网必须走代理**：GitHub/Vercel/Supabase 均经 `127.0.0.1:7897`。
7. **Vercel 504 ≠ 失败**：网关超时但后端可能已跑完；大数据量写操作必须分批（每批 ≤50），按返回 remaining 循环。
8. **二次导入必产生重复行**：eid 含 `-CLS-` 是报名副本、id 形如 `ORD-哈希` 是订单副本——再遇重复先按此识别。
9. **bootstrap 不含 orders**：查订单只能走 `/api/student?id=` 逐个学员（订单是家庭电话匹配展示，见下）。
10. **订单归属口径**：`orderBelongsToStudent` 按 child_id / 源ID / **电话**匹配 → 二胎家庭同一笔订单会同时归到两个孩子名下（运维手册已注明"按家庭合计展示"），对账按家庭/去重口径，勿按单人累加。
11. **临时端点教训（血泪）**：临时运维端点上线后必须"用完即删"并当场验证删除生效。216b032 之前 `api/[...route].js` 里 `/api/todo/record` 被残留的去重逻辑劫持，导致**新增待办静默失败长达一天**——撤除去重端点时没有清干净同名路由块。以后凡"撤除/删除"操作，必须 grep 确认无同名残留。

---

## 八、二期进度（PRD：助教工作台问题修复与学员分层跟进 · 2026-09-09）

> 主 PRD = 工作区根目录《二期PRD_助教工作台问题修复与学员分层跟进_2026-09-09.md》（其余三份旧二期 PRD 已归档 `_archive/2026-09-09_prd_cleanup/`，不再作为执行依据）。

### 8.1 已完成（提交链 1be6567 ← b01743a ← 70e62b9 ← fbae58a，均已推送上线）

1. **后端分层计算**：`segmentStudent()` 服务端统一算 S/A/B/C（结构性+风险事件规则、分值与 PRD 第五章一致），bootstrap 返回 326 人 `segmentation` 数组（9/9 实测 S=43 / A=118 / B=153 / C=12）。
2. **人工覆盖接口** `POST /api/student/segment`：保存/清除 segment_code、risk_tags、segment_note，自动层级永不被覆盖。
3. **系统动作同步接口** `POST /api/segmentation/actions/sync`：source_key 幂等去重（格式 `seg:{studentId}:{rule}:{yyyy-mm}`），S/A 级每周触达+风险动作自动落待办。
4. **前端花名册**：层级徽章列、风险标签摘要列、层级筛选下拉。
5. **前端首页**：KPI 改为 在读/S级/A级/逾期动作；新增"今日优先跟进"卡片（逾期→S→A 排序）。
6. **前端学员档案**：基础信息卡底部"跟进画像"区 + "编辑分层"弹窗（跟随系统/S/A/B/C/NONE、备注、清除覆盖）。
7. **学员搜索自动带班、请假日期自动推导、转介绍模块、bootstrap 12s 内存缓存**等前置功能（更早提交）。
8. **云端数据库迁移已执行生效**：`students` 已有 segment_code/risk_level/risk_tags/segment_note/segment_updated_at 列，`todos.source_key` 已建（bootstrap 持续返回分层字段即证据）。本地迁移文件 `supabase/2026-09-08_助教分层与动作幂等_一键迁移.sql` 尚未 git 提交（见 8.3）。

### 8.2 未完成 / 待验证（接手者从这里继续）

> 2026-09-09 更新：二期 PRD（问题修复+学员分层跟进）核心功能已完成并云端实测通过，交付报告见 `_archive/2026-09-09_二期PRD执行交付报告/交付报告.md`。下表原"未完成"项多数已完成：

| # | 事项 | 说明 |
| :--- | :--- | :--- |
| 1 | PRD §2.1-A 的 20 项问题修复 | ✅ 多数已完成（北京时间/订单归属/转介绍回填/错误降级/路由/URL解码/API超时/学期隔离/反馈fid）+ 学员编辑语义、报名编辑外键学期待回归细测 |
| 2 | 家庭档案摘要（PRD §8.5） | ✅ 已实现（S/A人数+未完成动作+待确认提示） |
| 3 | 跟进页分层/风险筛选与统计（PRD §8.3） | ✅ 已实现（flwSeg 筛选 + 层级列 + S/A统计） |
| 4 | 前端触发动作同步 | ⏳ 仍待定：`/api/segmentation/actions/sync` 目前手动/脚本触发，是否加 cron 待老板拍板（见交付报告第八节） |
| 5 | 移动端适配验证（PRD §8.6） | ⏳ 未系统验证（弹窗防误触已修，窄屏表格滚动待真机确认） |
| 6 | 验收脚本改造 | ⏳ PRD §13.7 的 PASS/FAIL 脚本化未做（当前用临时 python 脚本实测，未入 tools/） |
| 7 | 双人家庭归位遗留 | 维持上次结论（见左）：王羿澄/王柯锦已对调，云端 4 档案待老板拍板归档 |
| 8 | 反馈 fid 唯一键 | ✅ fid 已含 class_name；同学科同班多讲次重复录入的回归诊断未做 |

### 8.3 下一步建议顺序

1. 提交迁移 SQL 入 git（`git add supabase/2026-09-08_助教分层与动作幂等_一键迁移.sql`，见 §6 第 4 条红线：迁移文件必须可追溯）。
2. P0 稳定性修复：北京时间统一 → 错误降级区分 → 按钮防重复 → actions/sync 计数修正（写入失败误计入"新增"的 bug 在 `api/[...route].js` 983 行附近）。
3. 补齐 PRD §8.3/§8.5 前端消费 + sync 触发时机。
4. 按 PRD §13 改造验收脚本。

---

## 九、已修复记录（commit 216b032 · 2026-09-08 上线验证）

> 原第八节内容下移至此。

1. **致命 BUG**：`/api/todo/record` 第一个处理块是误留的"清重复行"逻辑（dry_run 劫持），真正的待办创建逻辑永远不可达 → 新增待办/联动登记请假全部静默失败。**已删除误留块，待办系统全部复活**（线上实测：新增待办返回 tid、联动请假落 leaves 台账、完成/取消留痕）。
2. **撤除临时端点**：`/api/admin/split_merged` 已移除（线上验证 400 提示"暂不支持"）。
3. **学期参数化**：`TERM` 硬编码 `2026秋` → 按北京时间月份自动推导 + 环境变量 `TERM_OVERRIDE` 钉住。
4. **退费退班 → leaves 台账联动**：`/api/enrollment/refund` 退班时自动写入 leaves（reason 前缀"退费退班："）。
5. **编辑学员同步**：改名/改电话时自动同步 enrollments、lesson_feedbacks、families、orders 的冗余字段，保持全局同口径。
6. **跟进类型统一**：登记弹窗类型从 5 类扩为 9 类（家长沟通/课堂表现/错题答疑/请假补课/阶段学情/首课反馈/拓科跟进/续班沟通/其他），与筛选一致。
7. **微信提醒文案**：更新为 10:00+17:00 双推送说明（推送通道本身待定，暂不配置）。
8. **新增公共库 `tools/_lib.py`**：云端三件套复用，杜绝重复模板脚本。

**验证结果（线上实测可逆测试）**：看板 301/46/282 稳定；新增待办 ✓；待办联动请假（leaves 4→5→4）✓；退费写台账（leaves→6→还原4）✓；报名作废/恢复联动看板与班级人数 ✓；调班联动原班/目标班人数 ✓；编辑学员联动档案与花名册 ✓。

---

## 十、待办与待老板拍板事项

| 事项 | 状态 | 说明 |
| :--- | :--- | :--- |
| **32 个 C- 前缀档案**（不在读但挂历史订单） | ⏸ **等老板拍板** | 明细已生成根目录 `C-档案明细_老板核对.md`（2026-09-08 归档清理时移至工作区根目录）；方案 A 保持不动（推荐）/ B 隐藏归档 / C 合并订单后删除（需逐条确认金额归属）。**删除必须老板拍板后执行** |
| **20 个双人名档案处理意见** | ⏸ **等老板拍板** | 见根目录《双人名学员档案_人工核对清单.md》，20 条处理意见空白，回"拆/留/改X/归档"即可 |
| 知识库融合 | ⏸ 老板暂停 | 本地 175 讲 vs 云端旧大纲，方案待定（替换 or 映射） |
| 微信推送通道 | ⏸ 老板待定 | 待办提醒能力已有；通道方案（Server酱/企业微信群）确定后再配环境变量 |
| 二期开发（09-09 PRD） | 🚧 **开发中** | 主 PRD =《二期PRD_助教工作台问题修复与学员分层跟进_2026-09-09.md》，当前进度见本文件第八节；旧三份二期 PRD 已归档 `_archive/2026-09-09_prd_cleanup/` |

---

## 十一、附：文件与目录地图

- `deploy_zhujiao/` → 源码主目录（git）
  - `api/[...route].js` 后端；`js/core.js` 内核；`js/modules/dashboard.js` 业务
  - `supabase/schema.sql` 建表 SQL；`vercel.json` 部署 + crons
  - `tools/` 常用工具脚本（`_*` 不进 git；`_lib.py` 公共库；双人家庭归位一次性执行脚本 9 个与留痕 JSON 已归档 `_archive/2026-09-09_family_relocation_exec/`；更早的 87 个一次性脚本在 `_archive/2026-09-08_workspace_cleanup/tools_archive/`）
  - `data/` 本地核对报告与反馈产物（敏感产物 gitignore）
  - `_archive/` 历史留档（gitignore）
- 根目录：`AGENTS.md`（工作规范）、`C-档案明细_老板核对.md`（32 空档明细，待拍板）、《双人名学员档案_人工核对清单.md》（待拍板）、`二期PRD_助教工作台问题修复与学员分层跟进_2026-09-09.md`（主 PRD）、`课程知识库/`（本地175讲）、`教师反馈内容/`（反馈原件）、`讲义/`、数据源 Excel
- 工作区级 `_archive/`（`C:\助教系统\_archive\`）：2026-09-09 已收拢旧二期 PRD（`2026-09-09_prd_cleanup/`）与根目录中间产物（`2026-09-09_root_intermediates/`：gen_final_plan4.py、build_check_xlsx.py、__pycache__、双人家庭标注清单/核对表、第9题演示 HTML）
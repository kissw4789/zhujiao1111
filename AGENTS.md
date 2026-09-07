# 苏E好学 · 助教工作台工作区规范与系统上下文 (AGENTS.md)

本文件专为 **Z-Code** 及后续 AI 助手维护本项目定制。AI 在进入本工作区后必须首先阅读并完全遵守本文件规则。

---

## 一、 系统架构与真实运行事实 (最高优先级)

1. **彻底脱离本地单机环境**：
   - 本系统已全面升级为 **“Vercel Serverless + Supabase 云端 PostgreSQL”** 架构。
   - **严禁**再去读取、修改或依赖原先本地已废弃的 `data/*.json` 或 `state.json`。
   - 数据源唯一事实标准：**Supabase 云端数据库**。

2. **核心仓库与部署映射**：
   - **GitHub 真实远程仓库**：`https://github.com/kissw4789/zhujiao1111.git`（主分支：`main`）
   - **线上生产访问地址**：`https://zhujiao1111.vercel.app`
   - **本地代码目录**：`deploy_zhujiao/`（所有针对系统的改动一律在此目录下进行）
   - **自动部署规则**：只要向 `main` 分支执行 `git push`，Vercel 会在 15~20 秒内自动完成编译并更新线上环境。

3. **前端代码架构准则（严禁回退）**：
   - **禁止全盘通读与重写大单文件**：系统已完成模块解耦，任何人或 AI 修改代码时必须精准定位：
     - **业务功能/界面交互**：只修改 `deploy_zhujiao/js/modules/dashboard.js`
     - **底层通讯/弹窗/通用工具**：只修改 `deploy_zhujiao/js/core.js`
     - **极简引导入口**：`deploy_zhujiao/app.js` 仅保留十余行启动逻辑，严禁将业务代码写回此处。
   - **敏感信息安全红线**：禁止在前端页面中引入包含真实学生电话/姓名的静态 JS 文件（如已废弃的 `data_js/*.js`），所有数据必须通过后端 API 安全流转。

4. **后端接口与数据规范**：
   - 后端路由单一入口：`deploy_zhujiao/api/[...route].js`（直连 Supabase REST API）。
   - 环境变量保护：`SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 仅在服务端环境变量中运行，禁止泄露到前端代码或 Git 仓库。

---

## 二、 业务模型与数据字典对照

云端当前包含 321 名学员档案（在读275/已结课40/待开课6）、281 户家庭、672 条报名记录（2026秋在读657/待开课15，在班587人次/去重272人）、92 行班级（前端看板口径46门在班班级）、94 项排课矩阵与 752 行/579 单订单（已支付661/已取消91，仅保留2026暑期+2026秋两季——非暑秋18行已于2026-09-07清理，更早全量历史底账见本地Excel），数据表设计如下：

| 表名 | 作用说明 | 关键主键/关联键 |
| :--- | :--- | :--- |
| `students` | 学员核心主档（一人一档） | `id` (主键), `family_id`, `name`, `phone`, `grade` |
| `families` | 家庭关系表（解决二胎共用电话） | `family_id` (主键), `phone`, `source_name` |
| `classes` | 秋季班级表（92行，看板口径46门在班） | `id` (主键), `class_name`, `teacher`, `campus`, `term` |
| `enrollments` | 学员报读流水记录（672条） | `eid` (主键), `student_id`, `class_name`, `term`, `is_void` |
| `schedule_items` | 教室与时空排课矩阵（94项） | `schedule_id` (主键), `room`, `weekday`, `time_range`, `teacher` |
| `orders` | 学费支付订单（752行/579单，仅暑秋两季） | `id` (主键), `order_no`, `amount`, `payment_status` |
| `leaves` | 在线请假与退费消课台账 | `lid` (主键), `student_id`, `class_name`, `refund_amount` |
| `followups` | 助教学情跟进/续班/拓科记录 | `id` (UUID), `student_id`, `kind`, `status`, `note` |
| `op_logs` | 助教操作审计日志 | `id` (自增), `action`, `target`, `logged_at` |

---

## 三、 助教服务业务铁律

1. **纯助教服务导向**：系统严格聚焦于学员档案、课表教室调度、消课请假、学情记录。严禁擅自添加电销、扩科转化、推销话术等无关逻辑。
2. **学期口径对齐**：秋季学期编码必须统一严格归一化为 `2026秋`。
3. **多端响应式要求**：所有新增界面必须保持在桌面端与手机移动端均能清晰查看课表和花名册。

---

## 四、 极速开发与交接工作流

当接手本项目的开发需求时，按以下规范闭环执行：
1. **精准阅读**：仅读取与需求直接关联的文件（改界面读 `js/modules/dashboard.js`；改接口读 `api/[...route].js`）。
2. **本地验证**：确保 JS/Node 语法检查通过。
3. **提交上线**：
   ```bash
   cd deploy_zhujiao
   git add .
   git commit -m "feat/fix: 简要描述更新内容"
   git push origin main
   ```
4. **线上确认**：访问 `https://zhujiao1111.vercel.app` 验收最终效果。

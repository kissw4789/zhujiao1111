# -*- coding: utf-8 -*-
"""
PRD 静态检查（prd_static_check.py）
===================================
覆盖 PRD §15 可静态断言的部分 + 代码结构红线：
- node --check 三个 JS 文件（api/core/dashboard）
- 断言：费用分类（退费）不出现在待办生成与页面（§15.2-6 / §17.6）
- 断言：没有残留直接 location.hash 赋值（§9 统一导航）
- 断言：#todo 直链与 onTodoRoute 存在（§9.4）
- 断言：请求输入包含 requestId/version 幂等字段（§17.3）
- 断言：迁移 SQL 文件存在且含 todo_events 表（§12 / 交付物2）

用法：python prd_static_check.py
退出码：0=全部 PASS；1=有任何 FAIL
"""
import os
import re
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # deploy_zhujiao/
RESULTS = []


def check(name, ok, detail=''):
    RESULTS.append((name, bool(ok), detail))
    mark = 'PASS' if ok else 'FAIL'
    print('[%s] %s%s' % (mark, name, (' - ' + detail) if detail else ''))


def node_check(path):
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    return r.returncode == 0


def read(p):
    try:
        with open(os.path.join(BASE, p), 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        return ''


def main():
    print('=== PRD 静态检查 ===')

    # 1. JS 语法
    for p in ['api/[...route].js', 'js/core.js', 'js/modules/dashboard.js']:
        check('node --check %s' % p, node_check(os.path.join(BASE, p)))

    api = read('api/[...route].js')
    dash = read('js/modules/dashboard.js')
    core = read('js/core.js')
    idx = read('index.html')

    # 2. 费用分类不出现（§15.2-6 / §17.6）
    bad_kind = re.search(r"TODO_KINDS\s*=\s*\[[^\]]*退费", dash)
    check('费用分类不出现（无 TODO_KINDS 退费）', not bad_kind)
    check('index.html 无退费类型下拉选项', not re.search(r'<option>退费</option>', idx))
    # 费用待办仍可查（排除范围）：后端不删除 arrears 遗留
    check('后端费用待办仅停用生成不删除（保留查询维权）', 'arrears' in api and '规则已调整，系统自动清理' not in api.replace('arrears', ''))

    # 3. 统一导航（§9）：dashboard 无直接 location.hash 赋值（history.replaceState 允许）
    bad_hash = re.findall(r'location\.hash\s*=', dash)
    check('dashboard.js 无直接 location.hash 赋值', not bad_hash, str(bad_hash))

    # 4. #todo 直链（§9.4）：路由解析 + 页面 + 渲染
    check('core.route 支持 todo 路由', 'onTodoRoute' in core and "startsWith('todo')" in core)
    check('index.html 有待办中心页面容器 p-todo', 'id="p-todo"' in idx)
    check('dashboard 导出 onTodoRoute', 'M.onTodoRoute = onTodoRoute' in dash)

    # 5. 五态状态机（§17.1 / §6）
    for s in ['待处理', '处理中', '已暂缓', '已完成', '已取消']:
        check('后端含状态 %s' % s, s in api)

    # 6. 幂等与版本（§17.3 / §12.4）
    check('后端包含 requestId 幂等', 'request_id' in api and 'requestId' in api)
    check('前端分级保存携带 requestId/version', 'requestId: reqId' in dash)

    # 7. 迁移 SQL（交付物2）
    sql = read('supabase/2026-09-09_统一待办工作流_一键迁移.sql')
    check('迁移 SQL 存在', os.path.exists(os.path.join(BASE, 'supabase/2026-09-09_统一待办工作流_一键迁移.sql')))
    check('迁移 SQL 含 todo_events', 'todo_events' in sql)
    check('迁移 SQL 含课历表', 'course_calendar_dates' in sql)
    check('迁移 SQL 含调课/转班表', 'schedule_adjustments' in sql and 'schedule_transfers' in sql)
    check('迁移 SQL 含分级幂等列', 'segment_version' in sql and 'segment_request_id' in sql)

    # 8. Cron 先对账后提醒 + 防重入（§17.5 / E17）
    check('Cron 含对账（reconcileTodos）', 'reconcileTodos(cd0' in api)
    check('Cron 含防重入锁', '__cronLastRunTs' in api and '1分钟内已执行' in api)
    check('同步失败不假装成功', 'syncFailed' in api)

    # 9. 家庭核对轮次（E13）
    check('家庭核对带轮次键 r{round}', 'assignment_review:r' in api)

    print()
    fails = [r for r in RESULTS if not r[1]]
    print('总计 %d 项：PASS %d / FAIL %d' % (len(RESULTS), len(RESULTS) - len(fails), len(fails)))
    for _, _, d in fails:
        print('  FAIL 明细:', d)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
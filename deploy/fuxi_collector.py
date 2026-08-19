#!/usr/bin/env python3
"""
伏羲系统 - QC渠道加好友数据自动采集脚本（纯 requests 版）

用法：
  python3 fuxi_collector.py                    # 抓取并输出到 data/fuxi_data.json
  python3 fuxi_collector.py --output xxx.json  # 指定输出路径
  python3 fuxi_collector.py --upload           # 同时上传到妙搭文件存储
  python3 fuxi_collector.py --days 30          # 指定拉取天数

接口说明（对齐伏羲真实 payload 结构）：
  - position: 42（加好友数据页面位置）
  - analysisDimensions: 分析维度数组
      PUT_PLAN_NAME              投放计划名
      SECOND_CHANNEL_PROVIDER_NAME  二级渠道提供方
      SOURCE                      来源
      GRADE_NAME                  年级
      PUT_DATE                    投放日期
  - analysisFields: 分析指标数组
      ADD_FRIEND_COUNT                   加好友数
      DELETE_FRIEND_COUNT_IN48_HOUR     48小时删好友数
      NOT_DELETE_FRIEND_COUNT_IN48_HOUR 48小时留存数
      （还有更多，按需要增加）

流程：
  1. POST 登录接口，获取 session cookie + sn-token
  2. POST 加好友数据接口，拉取近N天、QC渠道、全维度数据
  3. 整理数据：提取主播名、按日期/年级/主播聚合
  4. 输出 JSON 文件（看板可直接读取）
"""

import sys
import os
import json
import time
import argparse
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
import httpx
from datetime import datetime, timedelta, timezone

# 北京时间（UTC+8）：云端 runner 运行在 UTC，必须显式指定，否则日期/更新时间会差 8 小时
BJ_TZ = timezone(timedelta(hours=8))

# ========== 配置 ==========
FUXI_BASE = "https://fuxi.umeng100.com"
LOGIN_URL = f"{FUXI_BASE}/xianzhi/channel/open/distribution/channel/login"
TOKEN_URL = f"{FUXI_BASE}/xianzhi/channel/sn/token/getToken"
DATA_URL = f"{FUXI_BASE}/xianzhi/channel/open/auth/distribution/launchData/v2/addFriendData"

USERNAME = os.environ.get("FUXI_USERNAME", "h-shichangbu-kaituozu")
PASSWORD = os.environ.get("FUXI_PASSWORD")
if not PASSWORD:
    raise SystemExit("缺少环境变量 FUXI_PASSWORD，请先设置伏羲账号密码（export FUXI_PASSWORD=xxx）")

DAYS = 14  # 默认拉14天，保证近7天数据完整（周末/节假日可能缺数据）

# ===== 真实字段映射 =====
# 分析维度枚举（与伏羲后台对齐）
DIM_PUT_PLAN = "PUT_PLAN_NAME"              # 投放计划名
DIM_SECOND_CHANNEL = "SECOND_CHANNEL_PROVIDER_NAME"  # 二级渠道提供方
DIM_SOURCE = "SOURCE"                       # 来源
DIM_GRADE = "GRADE_NAME"                    # 年级
DIM_PUT_DATE = "PUT_DATE"                   # 投放日期

# 分析指标枚举（与伏羲后台对齐）
FIELD_ADD_FRIEND = "ADD_FRIEND_COUNT"                    # 加好友数
FIELD_DELETE_48H = "DELETE_FRIEND_COUNT_IN48_HOUR"      # 48h删好友数
FIELD_RETAIN_48H = "NOT_DELETE_FRIEND_COUNT_IN48_HOUR"  # 48h留存数

# 返回数据中对应的字段名（驼峰命名）
KEY_MAP = {
    DIM_PUT_PLAN: "putPlanName",
    DIM_SECOND_CHANNEL: "secondChannelProviderName",
    DIM_SOURCE: "source",
    DIM_GRADE: "gradeName",
    DIM_PUT_DATE: "putDate",
    FIELD_ADD_FRIEND: "addFriendCount",
    FIELD_DELETE_48H: "deleteFriendCountIn48Hour",
    FIELD_RETAIN_48H: "notDeleteFriendCountIn48Hour",
}

HEADERS = {
    "Content-Type": "application/json;charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://fuxi.umeng100.com/",
}


# ========== 工具函数 ==========
def ts(date_obj):
    """日期转毫秒时间戳（当天0点或23:59:59）"""
    return int(date_obj.timestamp() * 1000)


def normalize_date(date_str):
    """统一日期为 MM-DD 格式"""
    if not date_str:
        return ""
    s = str(date_str).strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d", "%m-%d", "%m/%d"):
        try:
            d = datetime.strptime(s, fmt)
            return f"{d.month:02d}-{d.day:02d}"
        except ValueError:
            continue
    # 如果是时间戳（毫秒）
    try:
        d = datetime.fromtimestamp(int(s) / 1000)
        return f"{d.month:02d}-{d.day:02d}"
    except (ValueError, TypeError):
        pass
    return s


def extract_anchor(channel):
    """从二级渠道提取主播名（-分隔最后一段）"""
    if not channel:
        return "未知"
    parts = [p for p in str(channel).replace("_", "-").split("-")
             if p.strip() and not p.strip().isdigit()]
    return parts[-1].strip() if parts else str(channel)


# ========== 伏羲 API 调用 ==========
def login(session):
    """登录伏羲系统，返回 session"""
    print(f"[1/4] 登录伏羲系统 ({USERNAME})...", file=sys.stderr)
    resp = session.post(
        LOGIN_URL,
        json={"loginAccount": USERNAME, "password": PASSWORD},
        headers=HEADERS,
        timeout=15,
    )
    resp.raise_for_status()
    body = resp.text
    if "<code>700</code>" in body or "<code>200</code>" in body:
        print(f"[1/4] 登录成功", file=sys.stderr)
        return True
    # 提取错误信息
    import re
    m = re.search(r"<msg>(.*?)</msg>", body)
    msg = m.group(1) if m else body[:100]
    print(f"[1/4] 登录失败: {msg}", file=sys.stderr)
    return False


def get_sn_token(session):
    """获取 sn-token（后续请求 header 用）"""
    resp = session.get(TOKEN_URL, headers=HEADERS, timeout=10.0)
    if "<code>200</code>" in resp.text:
        import re
        m = re.search(r"<data>(.*?)</data>", resp.text)
        if m:
            token = m.group(1)
            HEADERS["sn-token"] = token
            return token
    return None


def build_payload(start_ts, end_ts, page_num=1, page_size=500,
                  query_ids=None, dims=None):
    """构建请求 payload"""
    dims = dims or [DIM_PUT_DATE, DIM_SECOND_CHANNEL, DIM_GRADE]
    return {
        "position": 42,
        "putDateRange": [start_ts, end_ts],
        "courseEndDateRange": [],
        "planName": "",
        "analysisDimensions": dims,
        "analysisFields": [
            FIELD_ADD_FRIEND,
            FIELD_DELETE_48H,
            FIELD_RETAIN_48H,
        ],
        "download": False,
        "field": "",
        "order": None,
        "pageDto": {
            "pageNum": page_num,
            "pageSize": page_size,
        },
        "queryIds": query_ids or [],
        "secondChannelProviderName": "",
        "source": "",
    }


def parse_xml_data(body):
    """解析伏羲 XML 响应，提取所有 <data> 节点为 dict 列表"""
    import re
    rows = []
    for m in re.finditer(r"<data>(.*?)</data>", body, re.DOTALL):
        xml = m.group(1)
        row = {}
        for fm in re.finditer(r"<(\w+)>(.*?)</\1>", xml, re.DOTALL):
            row[fm.group(1)] = fm.group(2)
        rows.append(row)
    return rows


def fetch_add_friend_data(session, days=None, channel_keyword="KOC"):
    """拉取加好友数据（递归下钻树形结构，近N天）

    伏羲接口返回树形数据，analysisDimensions 指定层级顺序，
    每层节点通过 queryIds 下钻到下一层。
    """
    print("[2/4] 拉取加好友数据...", file=sys.stderr)

    days = days or DAYS
    today = datetime.now(BJ_TZ)
    start_date = today - timedelta(days=days - 1)
    start_ts = ts(start_date.replace(hour=0, minute=0, second=0, microsecond=0))
    end_ts = ts(today.replace(hour=23, minute=59, second=59, microsecond=999))

    dims = [DIM_PUT_DATE, DIM_SECOND_CHANNEL, DIM_GRADE]

    def drill(query_ids, level, depth=0):
        """递归下钻，返回叶子节点列表"""
        if level >= len(dims):
            return []

        all_rows = []
        page = 1
        while True:
            payload = build_payload(start_ts, end_ts, page_num=page, page_size=500,
                                    query_ids=query_ids, dims=dims)
            try:
                resp = session.post(DATA_URL, json=payload, headers=HEADERS, timeout=20.0)
            except Exception as e:
                print(f"[2/4]   {'  '*depth}请求异常 (page={page}): {e}", file=sys.stderr)
                break

            rows = parse_xml_data(resp.text)
            # 跳过汇总行（空dimension的）
            dim_rows = [r for r in rows if r.get("dimension")]
            if not dim_rows:
                break
            all_rows.extend(dim_rows)
            if len(dim_rows) < 500:
                break
            page += 1

        result = []
        for row in all_rows:
            # 渠道维度：过滤含关键字的
            if (dims[level] == DIM_SECOND_CHANNEL
                    and channel_keyword
                    and channel_keyword.upper() not in row.get("name", "").upper()
                    and channel_keyword.upper() not in row.get("secondChannelProviderName", "").upper()):
                continue

            has_children = row.get("hasChildren") == "true"
            if has_children and level + 1 < len(dims):
                qid = row.get("queryId", "")
                if qid:
                    child_rows = drill(query_ids + [qid], level + 1, depth + 1)
                    # 把当前层的维度信息合并到子节点
                    for cr in child_rows:
                        if dims[level] == DIM_PUT_DATE:
                            cr.setdefault("putDate", row.get("addFriendDate", row.get("name", "")))
                        elif dims[level] == DIM_SECOND_CHANNEL:
                            cr.setdefault("secondChannelProviderName",
                                          row.get("secondChannelProviderName", row.get("name", "")))
                        elif dims[level] == DIM_GRADE:
                            cr.setdefault("gradeName", row.get("gradeName", row.get("name", "")))
                        result.append(cr)
            else:
                # 叶子节点，补充当前维度的字段
                leaf = dict(row)
                if dims[level] == DIM_PUT_DATE:
                    leaf.setdefault("putDate", row.get("addFriendDate", row.get("name", "")))
                elif dims[level] == DIM_SECOND_CHANNEL:
                    leaf.setdefault("secondChannelProviderName",
                                    row.get("secondChannelProviderName", row.get("name", "")))
                elif dims[level] == DIM_GRADE:
                    leaf.setdefault("gradeName", row.get("gradeName", row.get("name", "")))
                result.append(leaf)

        return result

    leaf_rows = drill([], 0)
    print(f"[2/4] 共获取 {len(leaf_rows)} 条叶子数据", file=sys.stderr)
    return leaf_rows if leaf_rows else None


# ========== 数据整理 ==========
def _get(row, *keys, default=0):
    """从 row 中尝试多个 key，第一个命中就返回"""
    for k in keys:
        v = row.get(k)
        if v is not None and v != "":
            return v
    return default


def _to_int(v):
    """安全转 int"""
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return 0


def process_raw_data(raw_rows):
    """整理原始数据，提取主播名、按日期/年级/主播聚合（支持多指标）"""
    print("[3/4] 整理数据...", file=sys.stderr)

    detail = []
    for row in raw_rows:
        # 提取维度（优先用真实 key，兼容旧命名）
        date_val = _get(row, "putDate", "date", "日期", default="")
        channel = _get(row, "secondChannelProviderName", "secondChannel",
                       "secondChannelName", "二级渠道", default="")
        grade = _get(row, "gradeName", "grade", "年级", "学段", default="未知")
        plan = _get(row, "putPlanName", "planName", "plan_name", "投放计划", default="")
        source = _get(row, "source", "来源", default="")

        # 提取指标
        add_count = _to_int(_get(row, "addFriendCount", "加好友数", "好友数", default=0))
        delete_48h = _to_int(_get(row, "deleteFriendCountIn48Hour", "48h删好友数",
                                  "删好友数", default=0))
        retain_48h = _to_int(_get(row, "notDeleteFriendCountIn48Hour", "48h留存数",
                                  "留存数", default=0))

        # 只保留含 KOC 关键字的渠道
        channel_str = str(channel)
        if "KOC" not in channel_str.upper():
            continue

        date = normalize_date(date_val)
        anchor = extract_anchor(channel_str)
        grade_str = str(grade) if grade else "未知"

        if add_count <= 0 and retain_48h <= 0:
            continue

        detail.append({
            "date": date,
            "channel": channel_str,
            "anchor": anchor,
            "grade": grade_str,
            "plan": str(plan) if plan else "",
            "source": str(source) if source else "",
            "addCount": add_count,
            "delete48h": delete_48h,
            "retain48h": retain_48h,
            # 兼容旧字段名（看板可能还在用 count）
            "count": add_count,
        })

    if not detail:
        print("[3/4] 警告: 筛选后无数据", file=sys.stderr)
        return None

    # 收集维度
    dates = sorted(set(r["date"] for r in detail))
    grades = sorted(set(r["grade"] for r in detail if r["grade"] and r["grade"] != "未知"))
    anchors = sorted(set(r["anchor"] for r in detail))

    # 每日趋势（加好友数 + 留存数）
    daily_map_add = {}
    daily_map_retain = {}
    daily_map_delete = {}
    for r in detail:
        d = r["date"]
        daily_map_add[d] = daily_map_add.get(d, 0) + r["addCount"]
        daily_map_retain[d] = daily_map_retain.get(d, 0) + r["retain48h"]
        daily_map_delete[d] = daily_map_delete.get(d, 0) + r["delete48h"]
    daily = []
    for d in dates:
        add = daily_map_add.get(d, 0)
        retain = daily_map_retain.get(d, 0)
        delete = daily_map_delete.get(d, 0)
        retain_rate = round(retain / add * 100, 1) if add > 0 else 0
        daily.append({
            "date": d,
            "count": add,          # 兼容旧字段
            "addCount": add,
            "retain48h": retain,
            "delete48h": delete,
            "retainRate48h": retain_rate,
        })

    # 年级统计（今日/昨日）- 多指标
    today = dates[-1]
    yesterday = dates[-2] if len(dates) >= 2 else today
    grade_today_add = {g: 0 for g in grades}
    grade_ytd_add = {g: 0 for g in grades}
    grade_today_retain = {g: 0 for g in grades}
    grade_ytd_retain = {g: 0 for g in grades}
    for r in detail:
        if r["date"] == today and r["grade"] in grade_today_add:
            grade_today_add[r["grade"]] += r["addCount"]
            grade_today_retain[r["grade"]] += r["retain48h"]
        if r["date"] == yesterday and r["grade"] in grade_ytd_add:
            grade_ytd_add[r["grade"]] += r["addCount"]
            grade_ytd_retain[r["grade"]] += r["retain48h"]

    # 主播统计（今日/昨日）- 多指标
    anchor_today_add = {a: 0 for a in anchors}
    anchor_ytd_add = {a: 0 for a in anchors}
    anchor_today_retain = {a: 0 for a in anchors}
    anchor_ytd_retain = {a: 0 for a in anchors}
    for r in detail:
        if r["date"] == today:
            anchor_today_add[r["anchor"]] += r["addCount"]
            anchor_today_retain[r["anchor"]] += r["retain48h"]
        if r["date"] == yesterday:
            anchor_ytd_add[r["anchor"]] += r["addCount"]
            anchor_ytd_retain[r["anchor"]] += r["retain48h"]

    # KPI 计算
    today_add = daily_map_add.get(today, 0)
    ytd_add = daily_map_add.get(yesterday, 0)
    total_add = sum(daily_map_add.values())
    total_retain = sum(daily_map_retain.values())
    total_delete = sum(daily_map_delete.values())
    avg_7d = round(total_add / len(dates)) if dates else 0

    # 48h 整体留存率
    overall_retain_rate = round(total_retain / total_add * 100, 1) if total_add > 0 else 0
    today_retain_rate = (round(daily_map_retain.get(today, 0) / today_add * 100, 1)
                         if today_add > 0 else 0)

    # 环比估算（上一周期同长度）
    half = len(dates) // 2
    if half > 0:
        prev_total = sum(daily_map_add.get(d, 0) for d in dates[:half])
        prev_est = prev_total * (len(dates) / half) if prev_total > 0 else total_add * 0.9
    else:
        prev_est = total_add * 0.9
    total7d_delta = round(total_add - prev_est)
    total7d_delta_pct = f"{(total7d_delta / prev_est * 100):.1f}" if prev_est > 0 else "0.0"

    today_delta = today_add - ytd_add
    today_delta_pct = f"{(today_delta / ytd_add * 100):.1f}" if ytd_add > 0 else "0.0"

    day_before = dates[-3] if len(dates) >= 3 else yesterday
    db_add = daily_map_add.get(day_before, 0)
    ytd_delta = ytd_add - db_add
    ytd_delta_pct = f"{(ytd_delta / db_add * 100):.1f}" if db_add > 0 else "0.0"

    # 明细按加好友数降序
    detail.sort(key=lambda x: x["addCount"], reverse=True)

    result = {
        "meta": {
            "source": "fuxi_api",
            "updateTime": datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M:%S"),
            "dateRange": f"{dates[0]} 至 {dates[-1]}",
            "days": len(dates),
            "totalRecords": len(detail),
            "channelFilter": "KOC",
        },
        "dates": dates,
        "today": today,
        "yesterday": yesterday,
        "updateTime": datetime.now(BJ_TZ).strftime("%Y-%m-%d %H:%M"),
        "dateRangeText": f"{dates[0]} 至 {dates[-1]}（{len(dates)} 天）",
        "kpi": {
            # 加好友数
            "today": today_add,
            "todayDelta": today_delta,
            "todayDeltaPct": today_delta_pct,
            "total7d": total_add,
            "total7dDelta": total7d_delta,
            "total7dDeltaPct": total7d_delta_pct,
            "yesterday": ytd_add,
            "ytdDelta": ytd_delta,
            "ytdDeltaPct": ytd_delta_pct,
            "avg7d": avg_7d,
            # 48h 留存
            "todayRetain48h": daily_map_retain.get(today, 0),
            "totalRetain48h": total_retain,
            "totalDelete48h": total_delete,
            "retainRate48h": overall_retain_rate,
            "todayRetainRate48h": today_retain_rate,
        },
        "daily": daily,
        "grade": {
            "today": grade_today_add,        # 兼容旧字段
            "yesterday": grade_ytd_add,      # 兼容旧字段
            "todayAdd": grade_today_add,
            "yesterdayAdd": grade_ytd_add,
            "todayRetain": grade_today_retain,
            "yesterdayRetain": grade_ytd_retain,
            "grades": grades,
        },
        "anchor": {
            "today": anchor_today_add,       # 兼容旧字段
            "yesterday": anchor_ytd_add,     # 兼容旧字段
            "todayAdd": anchor_today_add,
            "yesterdayAdd": anchor_ytd_add,
            "todayRetain": anchor_today_retain,
            "yesterdayRetain": anchor_ytd_retain,
            "anchors": anchors,
        },
        "detail": detail,
    }

    print(f"[3/4] 整理完成: {len(detail)} 条明细, {len(dates)} 天, "
          f"{len(grades)} 年级, {len(anchors)} 主播", file=sys.stderr)
    return result


# ========== 上传到妙搭文件存储 ==========
def _load_miaoda_env():
    """返回当前进程环境变量（None 表示使用默认环境）。

    之前用文件同步 token 的方案已废弃 —— 妙搭 AUTHN_CODE 按会话/进程分配，
    每个 bash 子进程拿到的 token 都不同，文件里存的是另一个进程的 token 无效。
    正确做法：直接使用当前进程继承的环境变量，依赖 watchdog 定期自重启刷新。
    """
    return None


def upload_to_miaoda(file_path):
    """上传数据文件到妙搭文件存储（通过 miaoda deploy patch）

    每次上传前从 data/miaoda_env.sh 读取最新 token（env_sync.sh 每5分钟刷新一次），
    遇到 401 重试前也会重新读取，确保 token 始终是最新的。
    """
    print("[4/4] 上传到妙搭文件存储...", file=sys.stderr)

    # 相对路径（相对于项目根目录）
    rel_path = os.path.relpath(file_path, BASE_DIR)
    rel_path_safe = rel_path.replace("'", "'\\''")  # 单引号转义

    max_retry = 3
    for attempt in range(1, max_retry + 1):
        try:
            result = subprocess.run(
                ["bash", "-c",
                 f"cd '{BASE_DIR}' && miaoda deploy patch --update '{rel_path_safe}'"],
                capture_output=True,
                text=True,
                timeout=90,
            )
            if result.returncode == 0:
                print(f"[4/4] 上传成功 (第{attempt}次尝试)", file=sys.stderr)
                if result.stderr:
                    print(result.stderr.strip(), file=sys.stderr)
                return True
            else:
                is_401 = "401" in (result.stderr + result.stdout)
                print(f"[4/4] 上传失败 (code={result.returncode}, 第{attempt}次尝试)",
                      file=sys.stderr)
                if attempt < max_retry:
                    wait_sec = attempt * 5
                    if is_401:
                        print("  检测到 401，等待下次重试时自动加载新 token...",
                              file=sys.stderr)
                    print(f"  等待 {wait_sec}s 后重试...", file=sys.stderr)
                    time.sleep(wait_sec)
                    continue
                # 最后一次失败，打印完整错误
                print(result.stderr, file=sys.stderr)
                print(result.stdout, file=sys.stderr)
                return False
        except Exception as e:
            print(f"[4/4] 上传异常 (第{attempt}次尝试): {e}", file=sys.stderr)
            if attempt < max_retry:
                time.sleep(attempt * 5)
            else:
                return False
    return False


# ========== 主函数 ==========
def main():
    parser = argparse.ArgumentParser(description="伏羲QC渠道加好友数据采集")
    parser.add_argument("--output", "-o", default="data/fuxi_data.json",
                        help="输出 JSON 文件路径")
    parser.add_argument("--upload", action="store_true",
                        help="上传到妙搭文件存储（miaoda deploy）")
    parser.add_argument("--tos-output", default="",
                        help="同时写入 TOS 挂载目录路径（如 /home/workspace/koc-data/fuxi_data.json）")
    parser.add_argument("--dry-run", action="store_true",
                        help="不实际调用接口，生成模拟数据（测试用）")
    parser.add_argument("--days", type=int, default=DAYS,
                        help=f"拉取天数，默认 {DAYS} 天")
    parser.add_argument("--channel", default="KOC",
                        help="筛选二级渠道关键字，默认 KOC")
    args = parser.parse_args()

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    if args.dry_run:
        print(f"[dry-run] 生成模拟数据（{args.days}天）...", file=sys.stderr)
        dashboard_data = _gen_mock_data(days=args.days)
    else:
        session = httpx.Client()

        # 1. 登录
        if not login(session):
            print("登录失败，退出", file=sys.stderr)
            sys.exit(1)

        # 2. 获取 sn-token
        token = get_sn_token(session)
        if token:
            print(f"[1/4] sn-token 已获取", file=sys.stderr)

        # 3. 拉取数据
        raw = fetch_add_friend_data(session, days=args.days,
                                    channel_keyword=args.channel)
        if raw is None:
            print("[错误] 未能调通数据接口", file=sys.stderr)
            print("       请按以下步骤排查：", file=sys.stderr)
            print("       1. 用浏览器登录伏羲，打开加好友数据页面", file=sys.stderr)
            print("       2. 按 F12 打开开发者工具 → Network 标签", file=sys.stderr)
            print("       3. 在页面上操作一次查询，找到 addFriendData 请求", file=sys.stderr)
            print("       4. 把 Request Payload 里的 JSON 结构对照更新脚本", file=sys.stderr)
            sys.exit(2)

        if not raw:
            print("无数据返回", file=sys.stderr)
            sys.exit(3)

        # 4. 整理数据
        dashboard_data = process_raw_data(raw)
        if not dashboard_data:
            print("数据整理后为空", file=sys.stderr)
            sys.exit(4)

    # 5. 输出
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(dashboard_data, f, ensure_ascii=False, indent=2)

    print(f"✅ 数据已保存到: {args.output}", file=sys.stderr)
    print(f"   更新时间: {dashboard_data['updateTime']}", file=sys.stderr)
    print(f"   数据范围: {dashboard_data['dateRangeText']}", file=sys.stderr)
    print(f"   今日加好友: {dashboard_data['kpi']['today']}", file=sys.stderr)
    print(f"   近7天总计: {dashboard_data['kpi']['total7d']}", file=sys.stderr)

    # 6. 上传
    # 写入 TOS 挂载目录（如果指定了），比 miaoda deploy 更稳定
    if args.tos_output:
        try:
            import shutil
            os.makedirs(os.path.dirname(args.tos_output) or ".", exist_ok=True)
            shutil.copy2(args.output, args.tos_output)
            print(f"✅ 已同步到 TOS: {args.tos_output}", file=sys.stderr)
        except Exception as e:
            print(f"[警告] TOS 同步失败: {e}", file=sys.stderr)

    if args.upload:
        upload_to_miaoda(args.output)


def _gen_mock_data(days=7):
    """生成模拟数据（测试用）- 与真实 API 字段对齐"""
    dates = []
    today = datetime.now(BJ_TZ)
    for i in range(days - 1, -1, -1):
        d = today - timedelta(days=i)
        dates.append(f"{d.month:02d}-{d.day:02d}")

    grades = ["高一", "高二", "高三"]
    anchors = ["李老师", "王老师", "张老师", "刘老师", "陈老师",
               "赵老师", "周老师", "吴老师", "孙老师", "郑老师"]
    plans = ["暑期引流-基础班", "暑期引流-提升班", "暑期引流-冲刺班"]
    sources = ["抖音", "快手", "视频号"]

    anchor_weights = [1.2, 1.05, 0.95, 0.88, 0.8, 0.72, 0.65, 0.58, 0.52, 0.45]
    grade_weights = [0.85, 1.1, 1.05]

    import random
    random.seed(42)

    def date_factor(di):
        """日期趋势因子"""
        # 前期稳定，后期上升
        base = 0.85 + (di / max(days - 1, 1)) * 0.35
        # 加一点波动
        return base * (0.92 + random.random() * 0.16)

    detail = []
    for di, d in enumerate(dates):
        for ai, a in enumerate(anchors):
            for gi, g in enumerate(grades):
                base = 40
                add_count = round(base * anchor_weights[ai] * grade_weights[gi]
                                  * date_factor(di) * (0.8 + random.random() * 0.4))
                if add_count <= 0:
                    continue
                # 48h留存率约 70%~85%
                retain_rate = 0.7 + random.random() * 0.15
                retain = round(add_count * retain_rate)
                delete = add_count - retain

                detail.append({
                    "putDate": d,
                    "secondChannelProviderName": f"QC-{ai+1:02d}-{a}",
                    "gradeName": g,
                    "putPlanName": plans[(ai + gi) % len(plans)],
                    "source": sources[ai % len(sources)],
                    "addFriendCount": add_count,
                    "deleteFriendCountIn48Hour": delete,
                    "notDeleteFriendCountIn48Hour": retain,
                })

    return process_raw_data(detail)


if __name__ == "__main__":
    main()

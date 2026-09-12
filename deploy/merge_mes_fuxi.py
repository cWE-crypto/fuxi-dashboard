"""
合并 MES（market.baijia.com 企微获客链接）+ 伏羲（fuxi.umeng100.com）两个数据源
产出统一加好友看板 JSON，前端一次加载即可看到双源汇总。

合并策略：
- detail 明细：两源直接拼接，每行带 source 字段（MES / 伏羲），方便定位来源
- daily/anchor/groups 维度：按相同 date+anchor 维度聚合 addCount / retain48h / delete48h
- KPI：按真实日期重新计算（today / yesterday / 近 7 天）
- 来源分布：单独输出 sourceBreakdown 字段（按日按源分布）
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# 项目根目录：脚本在 migrate/deploy/，向上两级
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "data"


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: dict) -> None:
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def normalize_detail_row(row: dict, source: str) -> dict:
    """统一两个数据源的 detail 行结构，补齐字段"""
    out = {
        "date": row.get("date", ""),
        "channel": row.get("channel", ""),
        "anchor": row.get("anchor", ""),
        "count": int(row.get("count") or row.get("addCount") or 0),
        "addCount": int(row.get("addCount") or row.get("count") or 0),
        "retain48h": int(row.get("retain48h") or 0),
        "delete48h": int(row.get("delete48h") or 0),
        "retainRate48h": float(row.get("retainRate48h") or 0),
        "source": source,
    }
    # 渠道/年级/组别：MES 有 group/contentType，伏羲有 grade
    out["group"] = row.get("group", "")
    out["contentType"] = row.get("contentType", "")
    out["grade"] = row.get("grade", "")
    out["plan"] = row.get("plan", "")
    return out


def merge_detail(mes: dict, fuxi: dict) -> list[dict]:
    rows = []
    for r in mes.get("detail", []):
        rows.append(normalize_detail_row(r, "MES"))
    for r in fuxi.get("detail", []):
        rows.append(normalize_detail_row(r, "伏羲"))
    # 按日期倒序 + 数量倒序
    rows.sort(key=lambda x: (x["date"], x["count"]), reverse=True)
    return rows


def aggregate_daily(detail: list[dict]) -> list[dict]:
    bucket = defaultdict(lambda: {"count": 0, "retain48h": 0, "delete48h": 0,
                                   "mesCount": 0, "fuxiCount": 0})
    for r in detail:
        d = r["date"]
        bucket[d]["count"] += r["count"]
        bucket[d]["retain48h"] += r["retain48h"]
        bucket[d]["delete48h"] += r["delete48h"]
        if r["source"] == "MES":
            bucket[d]["mesCount"] += r["count"]
        elif r["source"] == "伏羲":
            bucket[d]["fuxiCount"] += r["count"]
    out = []
    for d in sorted(bucket.keys()):
        c = bucket[d]["count"]
        rate = round(bucket[d]["retain48h"] / c * 100, 1) if c > 0 else 0
        out.append({
            "date": d,
            "count": c,
            "addCount": c,
            "retain48h": bucket[d]["retain48h"],
            "delete48h": bucket[d]["delete48h"],
            "retainRate48h": rate,
            "mesCount": bucket[d]["mesCount"],
            "fuxiCount": bucket[d]["fuxiCount"],
        })
    return out


def aggregate_groups(detail: list[dict], dates7d: list[str], today: str, yesterday: str) -> list[dict]:
    """按 group 字段聚合，无 group 的行归到「伏羲未分组」"""
    groups_map = defaultdict(list)
    for r in detail:
        gname = r.get("group") or "伏羲未分组"
        groups_map[gname].append(r)

    out = []
    for idx, (gname, rows) in enumerate(sorted(groups_map.items())):
        leader_match = re.search(r"[（(](.+?)[)）]", gname)
        leader = leader_match.group(1) if leader_match else ""

        today_count = sum(r["count"] for r in rows if r["date"] == today)
        yesterday_count = sum(r["count"] for r in rows if r["date"] == yesterday)
        d7_count = sum(r["count"] for r in rows if r["date"] in dates7d)

        # 组内主播明细
        anchor_set = sorted({r["anchor"] for r in rows})
        anchor_detail = {}
        for a in anchor_set:
            anchor_detail[a] = {
                "today": sum(r["count"] for r in rows if r["date"] == today and r["anchor"] == a),
                "yesterday": sum(r["count"] for r in rows if r["date"] == yesterday and r["anchor"] == a),
                "d7": sum(r["count"] for r in rows if r["date"] in dates7d and r["anchor"] == a),
            }

        out.append({
            "key": f"g{idx}",
            "name": gname,
            "leader": leader,
            "today": today_count,
            "yesterday": yesterday_count,
            "d7": d7_count,
            "anchors": anchor_set,
            "anchorDetail": anchor_detail,
        })

    return out


def aggregate_anchors(detail: list[dict], dates7d: list[str], today: str, yesterday: str) -> dict:
    anchor_set = sorted({r["anchor"] for r in detail})
    today_map = {}
    yesterday_map = {}
    d7_map = {}
    today_add = {}
    yesterday_add = {}
    d7_add = {}
    today_retain = {}
    yesterday_retain = {}
    d7_retain = {}

    for a in anchor_set:
        a_rows = [r for r in detail if r["anchor"] == a]
        today_map[a] = sum(r["count"] for r in a_rows if r["date"] == today)
        yesterday_map[a] = sum(r["count"] for r in a_rows if r["date"] == yesterday)
        d7_map[a] = sum(r["count"] for r in a_rows if r["date"] in dates7d)
        today_add[a] = sum(r["count"] for r in a_rows if r["date"] == today)
        yesterday_add[a] = sum(r["count"] for r in a_rows if r["date"] == yesterday)
        d7_add[a] = sum(r["count"] for r in a_rows if r["date"] in dates7d)
        today_retain[a] = sum(r["retain48h"] for r in a_rows if r["date"] == today)
        yesterday_retain[a] = sum(r["retain48h"] for r in a_rows if r["date"] == yesterday)
        d7_retain[a] = sum(r["retain48h"] for r in a_rows if r["date"] in dates7d)

    return {
        "today": today_map,
        "yesterday": yesterday_map,
        "d7": d7_map,
        "todayAdd": today_add,
        "yesterdayAdd": yesterday_add,
        "d7Add": d7_add,
        "todayRetain": today_retain,
        "yesterdayRetain": yesterday_retain,
        "d7Retain": d7_retain,
        "anchors": anchor_set,
    }


def aggregate_grade(detail: list[dict], dates7d: list[str], today: str, yesterday: str) -> dict:
    """合并后年级维度：优先用 grade 字段（伏羲有），MES 没年级也按「未分类」汇总"""
    grade_set = sorted({r.get("grade", "") for r in detail if r.get("grade")})
    grade_today = {}
    grade_yesterday = {}
    grade_d7 = {}
    for g in grade_set:
        grade_today[g] = sum(r["count"] for r in detail if r["date"] == today and r.get("grade") == g)
        grade_yesterday[g] = sum(r["count"] for r in detail if r["date"] == yesterday and r.get("grade") == g)
        grade_d7[g] = sum(r["count"] for r in detail if r["date"] in dates7d and r.get("grade") == g)
    return {
        "today": grade_today,
        "yesterday": grade_yesterday,
        "d7": grade_d7,
        "grades": grade_set,
    }


def compute_kpi(detail: list[dict], dates7d: list[str], today: str, yesterday: str) -> dict:
    today_total = sum(r["count"] for r in detail if r["date"] == today)
    yesterday_total = sum(r["count"] for r in detail if r["date"] == yesterday)
    prev_day = _shift_date(yesterday, -1)
    day_before_total = sum(r["count"] for r in detail if r["date"] == prev_day)
    total7d = sum(r["count"] for r in detail if r["date"] in dates7d)
    prev7d_start = _shift_date(dates7d[0], -7) if dates7d else ""
    prev7d_end = _shift_date(dates7d[-1], -7) if dates7d else ""
    total_prev7d = sum(
        r["count"] for r in detail
        if prev7d_start and prev7d_end and prev7d_start <= r["date"] <= prev7d_end
    )
    today_delta = today_total - yesterday_total
    ytd_delta = yesterday_total - day_before_total
    total7d_delta = total7d - total_prev7d
    return {
        "today": today_total,
        "todayDelta": today_delta,
        "todayDeltaPct": _pct(today_delta, yesterday_total),
        "yesterday": yesterday_total,
        "ytdDelta": ytd_delta,
        "ytdDeltaPct": _pct(ytd_delta, day_before_total),
        "total7d": total7d,
        "total7dDelta": total7d_delta,
        "total7dDeltaPct": _pct(total7d_delta, total_prev7d),
        "avg7d": round(total7d / 7) if dates7d else 0,
        "todayRetain48h": sum(r["retain48h"] for r in detail if r["date"] == today),
        "yesterdayRetain48h": sum(r["retain48h"] for r in detail if r["date"] == yesterday),
        "totalRetain48h": sum(r["retain48h"] for r in detail if r["date"] in dates7d),
        "totalDelete48h": sum(r["delete48h"] for r in detail if r["date"] in dates7d),
        "todayDelete48h": sum(r["delete48h"] for r in detail if r["date"] == today),
        "retainRate48h": round(sum(r["retain48h"] for r in detail if r["date"] in dates7d)
                                / max(1, total7d) * 100, 1),
        "todayRetainRate48h": round(sum(r["retain48h"] for r in detail if r["date"] == today)
                                    / max(1, today_total) * 100, 1),
    }


def source_breakdown(detail: list[dict]) -> dict:
    """按 source 拆分总览，方便用户一眼看清各源贡献"""
    by_source_total = defaultdict(int)
    by_source_retain = defaultdict(int)
    by_source_date = defaultdict(lambda: defaultdict(int))
    for r in detail:
        s = r["source"]
        by_source_total[s] += r["count"]
        by_source_retain[s] += r["retain48h"]
        by_source_date[s][r["date"]] += r["count"]
    return {
        "totals": dict(by_source_total),
        "retain": dict(by_source_retain),
        "byDate": {s: dict(d) for s, d in by_source_date.items()},
    }


def _shift_date(date_str: str, days: int) -> str:
    """对 MM-DD 字符串按真实年份做日偏移（自动跨年）"""
    try:
        today = _dt.date.today()
        d = _dt.date(int(today.year), int(date_str[:2]), int(date_str[3:5]))
        d = d + _dt.timedelta(days=days)
        return f"{d.month:02d}-{d.day:02d}"
    except Exception:
        return ""


def _pct(delta: int, base: int) -> str:
    if base <= 0:
        return "0.0"
    return f"{delta / base * 100:.1f}"


def build_combined(mes: dict, fuxi: dict) -> dict:
    detail = merge_detail(mes, fuxi)

    # 真实日期（前端会再算一次，这里给个初值）
    today = _dt.date.today()
    yesterday = today - _dt.timedelta(days=1)
    today_str = f"{today.month:02d}-{today.day:02d}"
    yest_str = f"{yesterday.month:02d}-{yesterday.day:02d}"

    # 近 7 天日期数组（基于 today 真实日期）
    dates7d = []
    for i in range(6, -1, -1):
        d = today - _dt.timedelta(days=i)
        dates7d.append(f"{d.month:02d}-{d.day:02d}")

    daily = aggregate_daily(detail)
    groups = aggregate_groups(detail, dates7d, today_str, yest_str)
    anchors = aggregate_anchors(detail, dates7d, today_str, yest_str)
    grade = aggregate_grade(detail, dates7d, today_str, yest_str)
    kpi = compute_kpi(detail, dates7d, today_str, yest_str)
    breakdown = source_breakdown(detail)

    all_dates = sorted({r["date"] for r in detail})

    return {
        "meta": {
            "source": "mes_plus_fuxi",
            "sources": ["MES", "伏羲"],
            "updateTime": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "dateRange": f"{all_dates[0]} 至 {all_dates[-1]}" if all_dates else "",
            "days": len(all_dates),
            "totalRecords": len(detail),
            "mesRecords": sum(1 for r in detail if r["source"] == "MES"),
            "fuxiRecords": sum(1 for r in detail if r["source"] == "伏羲"),
            "channelFilter": "MES + 伏羲",
        },
        "dates": all_dates,
        "today": today_str,
        "yesterday": yest_str,
        "dates7d": dates7d,
        "updateTime": _dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "dateRangeText": f"{dates7d[0]} 至 {dates7d[-1]}（近 7 天）",
        "kpi": kpi,
        "daily": daily,
        "groups": groups,
        "anchor": anchors,
        "grade": grade,
        "sourceBreakdown": breakdown,
        "detail": detail,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="合并 MES + 伏羲看板数据")
    parser.add_argument("--mes", default=str(DATA_DIR / "mes_data.json"), help="MES 数据 JSON 路径")
    parser.add_argument("--fuxi", default=str(DATA_DIR / "fuxi_data.json"), help="伏羲数据 JSON 路径")
    parser.add_argument("--out", default=str(DATA_DIR / "combined_data.json"), help="合并后输出路径")
    args = parser.parse_args(argv)

    mes = load_json(Path(args.mes))
    fuxi = load_json(Path(args.fuxi))
    combined = build_combined(mes, fuxi)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(out_path, combined)

    # 控制台摘要
    m = combined["meta"]
    print("=" * 60)
    print(f" 合并产出：{out_path}")
    print(f"   数据源：{m['source']}（{', '.join(m['sources'])}）")
    print(f"   日期范围：{m['dateRange']}（{m['days']} 天）")
    print(f"   明细条数：{m['totalRecords']}（MES {m['mesRecords']} + 伏羲 {m['fuxiRecords']}）")
    print(f"   近 7 天加好友：{combined['kpi']['total7d']}")
    print(f"   今日加好友：{combined['kpi']['today']}  昨日加好友：{combined['kpi']['yesterday']}")
    print(f"   主播数：{len(combined['anchor']['anchors'])}  组数：{len(combined['groups'])}")
    print("   来源贡献：")
    for s, v in combined["sourceBreakdown"]["totals"].items():
        print(f"     - {s}：{v} 条加好友")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
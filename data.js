/**
 * 伏羲投放看板 - 加好友数据（示例数据）
 * 
 * 数据结构说明：
 * - 时间范围：近7天（含今天）
 * - 筛选条件：二级渠道包含 "QC"
 * - 透视维度：日期 × 年级 × 主播
 * 
 * 真实数据接入：将此文件中的 DASHBOARD_DATA 替换为伏羲系统导出的数据即可
 * 主播名提取规则：二级渠道名以 "-" 分隔，取最后一段
 */
(function() {
  // 生成近7天日期（含今天）
  function getLast7Days() {
    const days = [];
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      days.push(`${m}-${day}`);
    }
    return days;
  }

  const dates = getLast7Days();
  const grades = ['高一', '高二', '高三'];
  
  // 主播名（模拟QC渠道末尾的主播名）
  const anchors = [
    '李老师', '王老师', '张老师', '刘老师',
    '陈老师', '赵老师', '周老师', '吴老师',
    '孙老师', '郑老师'
  ];

  // 伪随机数（带种子），确保每次刷新略有波动但整体趋势一致
  function seededRandom(seed) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }

  // 生成某一天某位主播某个年级的加好友数
  function genCount(dateIdx, anchorIdx, gradeIdx, variant) {
    // 基础量级：主播权重、年级权重、日期趋势
    const anchorWeights = [1.2, 1.05, 0.95, 0.88, 0.8, 0.72, 0.65, 0.58, 0.52, 0.45];
    const gradeWeights = [0.85, 1.1, 1.05]; // 高二最多
    const dateTrend = [0.9, 0.95, 1.0, 1.02, 0.98, 1.05, 1.12]; // 近两天上升
    
    const base = 45; // 基础量级
    const seed = dateIdx * 100 + anchorIdx * 10 + gradeIdx + variant * 1000;
    const rand = 0.75 + seededRandom(seed) * 0.5; // 0.75 ~ 1.25
    
    return Math.round(base * anchorWeights[anchorIdx] * gradeWeights[gradeIdx] * dateTrend[dateIdx] * rand);
  }

  // 生成明细数据
  function generateDetail(variant) {
    const rows = [];
    for (let di = 0; di < dates.length; di++) {
      for (let ai = 0; ai < anchors.length; ai++) {
        for (let gi = 0; gi < grades.length; gi++) {
          const count = genCount(di, ai, gi, variant);
          if (count > 0) {
            rows.push({
              date: dates[di],
              dateIndex: di,
              channel: `QC-${String(ai + 1).padStart(2, '0')}-${anchors[ai]}`,
              anchor: anchors[ai],
              grade: grades[gi],
              count: count
            });
          }
        }
      }
    }
    return rows;
  }

  // 生成上一周期数据（用于环比）
  function generatePrevCycle(variant) {
    let total = 0;
    for (let di = 0; di < 7; di++) {
      for (let ai = 0; ai < anchors.length; ai++) {
        for (let gi = 0; gi < grades.length; gi++) {
          total += Math.round(genCount(di, ai, gi, variant) * 0.88);
        }
      }
    }
    return total;
  }

  // 计算各维度聚合
  function computeAggregates(detail) {
    // 每日总计
    const dailyMap = {};
    detail.forEach(r => {
      dailyMap[r.date] = (dailyMap[r.date] || 0) + r.count;
    });
    const daily = dates.map(d => ({ date: d, count: dailyMap[d] || 0 }));

    // 年级维度（今日/昨日）
    const today = dates[dates.length - 1];
    const yesterday = dates[dates.length - 2];
    const gradeToday = {};
    const gradeYtd = {};
    grades.forEach(g => {
      gradeToday[g] = detail.filter(r => r.date === today && r.grade === g).reduce((s, r) => s + r.count, 0);
      gradeYtd[g] = detail.filter(r => r.date === yesterday && r.grade === g).reduce((s, r) => s + r.count, 0);
    });

    // 主播维度（今日/昨日）
    const anchorToday = {};
    const anchorYtd = {};
    anchors.forEach(a => {
      anchorToday[a] = detail.filter(r => r.date === today && r.anchor === a).reduce((s, r) => s + r.count, 0);
      anchorYtd[a] = detail.filter(r => r.date === yesterday && r.anchor === a).reduce((s, r) => s + r.count, 0);
    });

    return { daily, gradeToday, gradeYtd, anchorToday, anchorYtd };
  }

  let variant = 0;

  function buildDashboardData() {
    variant++;
    const detail = generateDetail(variant);
    const aggs = computeAggregates(detail);
    const today = dates[dates.length - 1];
    const yesterday = dates[dates.length - 2];
    const dayBefore = dates[dates.length - 3];

    const todayTotal = aggs.daily[aggs.daily.length - 1].count;
    const ytdTotal = aggs.daily[aggs.daily.length - 2].count;
    const dayBeforeTotal = aggs.daily[aggs.daily.length - 3].count;
    const total7d = aggs.daily.reduce((s, d) => s + d.count, 0);
    const prevTotal = generatePrevCycle(variant);

    // 昨日同期（用于今日实时对比 - 模拟）
    const ytdSamePeriod = Math.round(ytdTotal * 0.92); // 假设当前时刻昨日已完成92%

    return {
      // 时间信息
      dates: dates,
      today: today,
      yesterday: yesterday,
      updateTime: formatNow(),
      dateRangeText: `${dates[0]} 至 ${dates[6]}`,

      // KPI
      kpi: {
        today: todayTotal,
        todayDelta: todayTotal - ytdSamePeriod,
        todayDeltaPct: ((todayTotal - ytdSamePeriod) / ytdSamePeriod * 100).toFixed(1),
        total7d: total7d,
        total7dDelta: total7d - prevTotal,
        total7dDeltaPct: ((total7d - prevTotal) / prevTotal * 100).toFixed(1),
        yesterday: ytdTotal,
        ytdDelta: ytdTotal - dayBeforeTotal,
        ytdDeltaPct: ((ytdTotal - dayBeforeTotal) / dayBeforeTotal * 100).toFixed(1),
        avg7d: Math.round(total7d / 7)
      },

      // 每日趋势
      daily: aggs.daily,

      // 年级统计
      grade: {
        today: aggs.gradeToday,
        yesterday: aggs.gradeYtd,
        grades: grades
      },

      // 主播排名
      anchor: {
        today: aggs.anchorToday,
        yesterday: aggs.anchorYtd,
        anchors: anchors
      },

      // 明细（按加好友数降序）
      detail: detail.sort((a, b) => b.count - a.count)
    };
  }

  function formatNow() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  window.DASHBOARD_DATA = buildDashboardData();
  window.buildDashboardData = buildDashboardData;
})();

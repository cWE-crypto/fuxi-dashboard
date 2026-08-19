/**
 * 投放加好友数据看板 - 主逻辑
 */
(function() {
  let data = window.DASHBOARD_DATA;
  let trendChart = null;
  let gradeTab = 'today';
  let anchorTab = 'today';
  let trendMetric = 'add'; // add / retain / rate
  let groupTab = 'today';
  let uploadedDetail = null; // 已上传的原始明细数据

  // 标记当前数据源
  let isRealData = false;
  let dataSource = 'sample'; // sample / upload / fuxi / json / bookmarklet / share
  let autoRefreshTimer = null;
  const AUTO_REFRESH_INTERVAL = 2 * 60 * 1000; // 2分钟
  // 伏羲代理API地址（本地运行时配置）
  const FUXI_API_BASE = localStorage.getItem('fuxi_api_base') || 'http://localhost:8765';
  // JSON 数据文件路径（TOS 挂载点同步，比 miaoda deploy 更稳，不受 token 过期影响）
  const JSON_DATA_URL = 'data/fuxi_data.json';

  // 分类色板（与CSS变量一致）
  const COLORS = {
    brand: '#2563eb',
    brandLight: '#93c5fd',
    brandBg: 'rgba(37, 99, 235, 0.08)',
    success: '#16a34a',
    danger: '#dc2626',
    grade: {
      '高一': '#2563eb',
      '高二': '#7c3aed',
      '高三': '#0891b2'
    },
    anchor: [
      '#2563eb', '#0891b2', '#7c3aed', '#db2777',
      '#ea580c', '#65a30d', '#0d9488', '#c026d3',
      '#0369a1', '#b91c1c'
    ],
    grid: '#e2e8f0',
    textPrimary: '#1e293b',
    textSecondary: '#64748b',
    textTertiary: '#94a3b8'
  };

  /* ---------- 工具函数 ---------- */
  function fmt(n) {
    return Math.round(n).toLocaleString('zh-CN');
  }

  function fmtPct(n) {
    return (n > 0 ? '+' : '') + n + '%';
  }

  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast';
    if (type) el.classList.add('toast-' + type);
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  function formatNow() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 解析日期字符串，统一为 MM-DD 格式
  function normalizeDate(str) {
    if (!str) return '';
    let s = str.trim();
    // 去除引号
    s = s.replace(/^"|"$/g, '');
    // 2024-07-30 或 2024/07/30
    let m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (m) return `${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
    // 07-30 / 07/30
    m = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (m) return `${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    // 7月30日
    m = s.match(/(\d{1,2})月(\d{1,2})日/);
    if (m) return `${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    return s;
  }

  // 解析 CSV（支持引号、BOM）
  function parseCSV(text) {
    // 去除 BOM
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    
    const rows = [];
    let cur = [];
    let field = '';
    let inQuotes = false;
    
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i+1] === '"') { field += '"'; i++; }
          else { inQuotes = false; }
        } else {
          field += c;
        }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { cur.push(field); field = ''; }
        else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else { field += c; }
      }
    }
    if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
    
    return rows.filter(r => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
  }

  // 从表头行推断字段列索引
  function detectColumns(headerRow) {
    const cols = {};
    headerRow.forEach((h, idx) => {
      const name = h.trim().toLowerCase();
      // 日期
      if (/日期|date|时间|day/i.test(h) && !cols.date) cols.date = idx;
      // 二级渠道
      if (/二级渠道|渠道|channel/i.test(h) && !cols.channel) cols.channel = idx;
      // 主播（可能没有，需从渠道提取）
      if (/主播|达人|博主|anchor/i.test(h) && !cols.anchor) cols.anchor = idx;
      // 年级
      if (/年级|grade|学段/i.test(h) && !cols.grade) cols.grade = idx;
      // 加好友数
      if (/加好友|好友数|新增好友|friend|数量/i.test(h) && !cols.count) cols.count = idx;
    });
    return cols;
  }

  // 从二级渠道中提取主播名（以-分隔的最后一段）
  function extractAnchor(channel) {
    if (!channel) return '未知';
    const parts = channel.split(/-|_/);
    // 去掉空段和纯数字段，取最后一个有意义的段
    const meaningful = parts.filter(p => p.trim() && !/^\d+$/.test(p.trim()));
    return meaningful.length ? meaningful[meaningful.length - 1].trim() : channel;
  }

  // 从明细数据构建完整看板数据
  function buildDashboardFromDetail(detail) {
    if (!detail || detail.length === 0) return null;

    // 收集所有日期并排序
    const dateSet = new Set(detail.map(r => r.date));
    const dates = Array.from(dateSet).sort();
    
    // 按日期聚合
    const dailyMap = {};
    detail.forEach(r => {
      dailyMap[r.date] = (dailyMap[r.date] || 0) + r.count;
    });
    const daily = dates.map(d => ({ date: d, count: dailyMap[d] || 0 }));

    const today = dates[dates.length - 1];
    const yesterday = dates.length >= 2 ? dates[dates.length - 2] : today;
    const dayBefore = dates.length >= 3 ? dates[dates.length - 3] : yesterday;

    // 按年级聚合（今日/昨日）
    const gradeSet = new Set(detail.map(r => r.grade).filter(g => g && g !== '未知'));
    const grades = Array.from(gradeSet);
    const gradeToday = {};
    const gradeYtd = {};
    grades.forEach(g => {
      gradeToday[g] = detail.filter(r => r.date === today && r.grade === g).reduce((s, r) => s + r.count, 0);
      gradeYtd[g] = detail.filter(r => r.date === yesterday && r.grade === g).reduce((s, r) => s + r.count, 0);
    });

    // 按主播聚合（今日/昨日）
    const anchorSet = new Set(detail.map(r => r.anchor));
    const anchors = Array.from(anchorSet);
    const anchorToday = {};
    const anchorYtd = {};
    anchors.forEach(a => {
      anchorToday[a] = detail.filter(r => r.date === today && r.anchor === a).reduce((s, r) => s + r.count, 0);
      anchorYtd[a] = detail.filter(r => r.date === yesterday && r.anchor === a).reduce((s, r) => s + r.count, 0);
    });

    // 上一周期计算（用可用数据估算）
    const total7d = daily.reduce((s, d) => s + d.count, 0);
    const halfLen = Math.floor(dates.length / 2);
    let prevTotal = 0;
    for (let i = 0; i < Math.min(halfLen, dates.length); i++) {
      prevTotal += daily[i].count || 0;
    }
    // 若天数相同则直接比，否则按比例估算
    const prevEst = prevTotal > 0 && halfLen > 0 ? prevTotal * (dates.length / halfLen) : total7d * 0.9;
    const total7dDelta = total7d - prevEst;
    const total7dDeltaPct = prevEst > 0 ? (total7dDelta / prevEst * 100).toFixed(1) : '0.0';

    const todayTotal = dailyMap[today] || 0;
    const ytdTotal = dailyMap[yesterday] || 0;
    const dayBeforeTotal = dailyMap[dayBefore] || 0;

    // 今日 vs 昨日同期（如果昨天全天数据都有，用昨天全天对比）
    const todayDelta = todayTotal - ytdTotal;
    const todayDeltaPct = ytdTotal > 0 ? (todayDelta / ytdTotal * 100).toFixed(1) : '0.0';

    const ytdDelta = ytdTotal - dayBeforeTotal;
    const ytdDeltaPct = dayBeforeTotal > 0 ? (ytdDelta / dayBeforeTotal * 100).toFixed(1) : '0.0';

    return {
      dates: dates,
      today: today,
      yesterday: yesterday,
      updateTime: formatNow(),
      dateRangeText: `${dates[0]} 至 ${dates[dates.length - 1]}（${dates.length} 天）`,
      kpi: {
        today: todayTotal,
        todayDelta: todayDelta,
        todayDeltaPct: todayDeltaPct,
        total7d: total7d,
        total7dDelta: Math.round(total7dDelta),
        total7dDeltaPct: total7dDeltaPct,
        yesterday: ytdTotal,
        ytdDelta: ytdDelta,
        ytdDeltaPct: ytdDeltaPct,
        avg7d: Math.round(total7d / dates.length)
      },
      daily: daily,
      grade: {
        today: gradeToday,
        yesterday: gradeYtd,
        grades: grades.length > 0 ? grades : ['未知']
      },
      anchor: {
        today: anchorToday,
        yesterday: anchorYtd,
        anchors: anchors
      },
      detail: detail.slice().sort((a, b) => b.count - a.count)
    };
  }

  // 更新数据源徽章
  function updateDataSourceBadge() {
    const badge = document.getElementById('dataSourceBadge');
    const text = badge.querySelector('.ds-text');
    if (dataSource === 'fuxi') {
      badge.classList.add('real', 'fuxi');
      badge.classList.remove('bookmarklet', 'json');
      text.textContent = '伏羲实时数据';
    } else if (dataSource === 'json') {
      badge.classList.add('real', 'json');
      badge.classList.remove('fuxi', 'bookmarklet', 'share');
      text.textContent = '自动采集数据';
    } else if (dataSource === 'bookmarklet') {
      badge.classList.add('real', 'bookmarklet');
      badge.classList.remove('fuxi', 'share');
      text.textContent = '伏羲抓取数据';
    } else if (dataSource === 'share') {
      badge.classList.add('real', 'share');
      badge.classList.remove('fuxi', 'bookmarklet');
      text.textContent = '分享数据快照';
    } else if (dataSource === 'upload') {
      badge.classList.add('real');
      badge.classList.remove('fuxi', 'bookmarklet', 'share');
      text.textContent = '已导入真实数据';
    } else {
      badge.classList.remove('real', 'fuxi', 'bookmarklet', 'share');
      text.textContent = '示例数据';
    }
  }

  /* ---------- 文件上传处理（支持 CSV + XLSX） ---------- */
  window.handleFileUpload = function(event) {
    const file = event.target.files[0];
    if (!file) return;

    const btn = document.getElementById('refreshBtn');
    btn.classList.add('loading');
    btn.disabled = true;

    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'xlsx' || ext === 'xls') {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const dataArr = new Uint8Array(e.target.result);
          const workbook = XLSX.read(dataArr, { type: 'array' });
          // 取第一个 sheet
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
          processDataRows(rows, file.name);
        } catch (err) {
          showToast('Excel 解析失败：' + err.message);
          resetRefreshBtn();
        }
      };
      reader.onerror = function() {
        showToast('文件读取失败');
        resetRefreshBtn();
      };
      reader.readAsArrayBuffer(file);
    } else {
      // CSV
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          let text = e.target.result;
          const rows = parseCSV(text);
          if (rows.length < 2) {
            // 可能是 GBK 编码
            const reader2 = new FileReader();
            reader2.onload = function(e2) {
              try {
                const text2 = e2.target.result;
                const rows2 = parseCSV(text2);
                processDataRows(rows2, file.name);
              } catch (err) {
                showToast('文件解析失败：' + err.message);
                resetRefreshBtn();
              }
            };
            reader2.readAsText(file, 'GBK');
            return;
          }
          processDataRows(rows, file.name);
        } catch (err) {
          showToast('文件解析失败：' + err.message);
          resetRefreshBtn();
        }
      };
      reader.onerror = function() {
        showToast('文件读取失败');
        resetRefreshBtn();
      };
      reader.readAsText(file, 'UTF-8');
    }

    event.target.value = '';
  };

  function processDataRows(rows, fileName) {
    if (rows.length < 2) {
      showToast('文件数据不足');
      resetRefreshBtn();
      return;
    }

    const header = rows[0];
    const cols = detectColumns(header);

    if (cols.date === undefined || cols.channel === undefined || cols.count === undefined) {
      showToast('未能识别必要字段（日期/二级渠道/加好友数），请检查文件格式');
      resetRefreshBtn();
      return;
    }

    // 解析数据行
    const detail = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;
      
      const rawDate = row[cols.date];
      // Excel 日期可能是数字（序列号）或字符串
      let date;
      if (typeof rawDate === 'number') {
        // Excel 序列号转日期
        const d = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
        date = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      } else {
        date = normalizeDate(String(rawDate || ''));
      }
      
      const channel = String(row[cols.channel] || '').trim();
      const rawCount = row[cols.count];
      const count = typeof rawCount === 'number' ? Math.round(rawCount) : parseInt(String(rawCount).replace(/[,，]/g, ''), 10) || 0;
      
      if (!date || !channel || count <= 0) continue;
      
      // 只保留 KOC 渠道
      if (!/KOC/i.test(channel)) continue;
      
      let grade = cols.grade !== undefined ? String(row[cols.grade] || '').trim() : '';
      if (!grade) grade = '未知';
      
      let anchor = cols.anchor !== undefined ? String(row[cols.anchor] || '').trim() : '';
      if (!anchor) anchor = extractAnchor(channel);

      detail.push({ date, channel, anchor, grade, count });
    }

    if (detail.length === 0) {
      showToast('未找到符合条件的KOC渠道数据');
      resetRefreshBtn();
      return;
    }

    // 保存原始明细 + 构建看板数据
    uploadedDetail = detail;
    const newData = buildDashboardFromDetail(detail);
    if (!newData) {
      showToast('数据构建失败');
      resetRefreshBtn();
      return;
    }

    data = newData;
    isRealData = true;
    dataSource = 'upload';
    try { localStorage.setItem('koc_data_source', 'upload'); } catch(e) {}
    updateDataSourceBadge();
    renderAll();
    resetRefreshBtn();
    showToast(`已导入 ${detail.length} 条数据（${data.dates.length} 天）`);
  }

  // ========== LZ-string 轻量压缩（用于 URL 分享） ==========
  const LZString = (function() {
    const keyStrBase64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    const baseReverseDic = {};
    function getBaseValue(alphabet, character) {
      if (!baseReverseDic[alphabet]) {
        baseReverseDic[alphabet] = {};
        for (let i = 0; i < alphabet.length; i++) {
          baseReverseDic[alphabet][alphabet.charAt(i)] = i;
        }
      }
      return baseReverseDic[alphabet][character];
    }
    function compressToBase64(input) {
      if (input == null) return '';
      const res = _compress(input, 6, function(a) { return keyStrBase64.charAt(a); });
      switch (res.length % 4) {
        case 0: return res;
        case 1: return res + '===';
        case 2: return res + '==';
        case 3: return res + '=';
      }
    }
    function decompressFromBase64(input) {
      if (input == null) return '';
      if (input === '') return null;
      return _decompress(input.length, 32, function(index) {
        return getBaseValue(keyStrBase64, input.charAt(index));
      });
    }
    function _compress(uncompressed, bitsPerChar, getCharFromInt) {
      if (uncompressed == null) return '';
      let i, value,
          context_dictionary = {},
          context_dictionaryToCreate = {},
          context_c = '',
          context_wc = '',
          context_w = '',
          context_enlargeIn = 2,
          context_dictSize = 3,
          context_numBits = 2,
          context_data = [],
          context_data_val = 0,
          context_data_position = 0,
          ii, len;
      for (ii = 0, len = uncompressed.length; ii < len; ii += 1) {
        context_c = uncompressed.charAt(ii);
        if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
          context_dictionary[context_c] = context_dictSize++;
          context_dictionaryToCreate[context_c] = true;
        }
        context_wc = context_w + context_c;
        if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
          context_w = context_wc;
        } else {
          if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
            if (context_w.charCodeAt(0) < 256) {
              for (i = 0; i < context_numBits; i++) {
                context_data_val = (context_data_val << 1);
                if (context_data_position == bitsPerChar - 1) {
                  context_data_position = 0;
                  context_data.push(getCharFromInt(context_data_val));
                  context_data_val = 0;
                } else { context_data_position++; }
              }
              value = context_w.charCodeAt(0);
              for (i = 0; i < 8; i++) {
                context_data_val = (context_data_val << 1) | (value & 1);
                if (context_data_position == bitsPerChar - 1) {
                  context_data_position = 0;
                  context_data.push(getCharFromInt(context_data_val));
                  context_data_val = 0;
                } else { context_data_position++; }
                value = value >> 1;
              }
            } else {
              value = 1;
              for (i = 0; i < context_numBits; i++) {
                context_data_val = (context_data_val << 1) | value;
                if (context_data_position == bitsPerChar - 1) {
                  context_data_position = 0;
                  context_data.push(getCharFromInt(context_data_val));
                  context_data_val = 0;
                } else { context_data_position++; }
                value = 0;
              }
              value = context_w.charCodeAt(0);
              for (i = 0; i < 16; i++) {
                context_data_val = (context_data_val << 1) | (value & 1);
                if (context_data_position == bitsPerChar - 1) {
                  context_data_position = 0;
                  context_data.push(getCharFromInt(context_data_val));
                  context_data_val = 0;
                } else { context_data_position++; }
                value = value >> 1;
              }
            }
            context_enlargeIn--;
            if (context_enlargeIn == 0) {
              context_enlargeIn = Math.pow(2, context_numBits);
              context_numBits++;
            }
            delete context_dictionaryToCreate[context_w];
          } else {
            value = context_dictionary[context_w];
            for (i = 0; i < context_numBits; i++) {
              context_data_val = (context_data_val << 1) | (value & 1);
              if (context_data_position == bitsPerChar - 1) {
                context_data_position = 0;
                context_data.push(getCharFromInt(context_data_val));
                context_data_val = 0;
              } else { context_data_position++; }
              value = value >> 1;
            }
          }
          context_enlargeIn--;
          if (context_enlargeIn == 0) {
            context_enlargeIn = Math.pow(2, context_numBits);
            context_numBits++;
          }
          context_dictionary[context_wc] = context_dictSize++;
          context_w = String(context_c);
        }
      }
      if (context_w !== '') {
        if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
          if (context_w.charCodeAt(0) < 256) {
            for (i = 0; i < context_numBits; i++) {
              context_data_val = (context_data_val << 1);
              if (context_data_position == bitsPerChar - 1) {
                context_data_position = 0;
                context_data.push(getCharFromInt(context_data_val));
                context_data_val = 0;
              } else { context_data_position++; }
            }
            value = context_w.charCodeAt(0);
            for (i = 0; i < 8; i++) {
              context_data_val = (context_data_val << 1) | (value & 1);
              if (context_data_position == bitsPerChar - 1) {
                context_data_position = 0;
                context_data.push(getCharFromInt(context_data_val));
                context_data_val = 0;
              } else { context_data_position++; }
              value = value >> 1;
            }
          } else {
            value = 1;
            for (i = 0; i < context_numBits; i++) {
              context_data_val = (context_data_val << 1) | value;
              if (context_data_position == bitsPerChar - 1) {
                context_data_position = 0;
                context_data.push(getCharFromInt(context_data_val));
                context_data_val = 0;
              } else { context_data_position++; }
              value = 0;
            }
            value = context_w.charCodeAt(0);
            for (i = 0; i < 16; i++) {
              context_data_val = (context_data_val << 1) | (value & 1);
              if (context_data_position == bitsPerChar - 1) {
                context_data_position = 0;
                context_data.push(getCharFromInt(context_data_val));
                context_data_val = 0;
              } else { context_data_position++; }
              value = value >> 1;
            }
          }
          context_enlargeIn--;
          if (context_enlargeIn == 0) {
            context_enlargeIn = Math.pow(2, context_numBits);
            context_numBits++;
          }
          delete context_dictionaryToCreate[context_w];
        } else {
          value = context_dictionary[context_w];
          for (i = 0; i < context_numBits; i++) {
            context_data_val = (context_data_val << 1) | (value & 1);
            if (context_data_position == bitsPerChar - 1) {
              context_data_position = 0;
              context_data.push(getCharFromInt(context_data_val));
              context_data_val = 0;
            } else { context_data_position++; }
            value = value >> 1;
          }
        }
        context_enlargeIn--;
        if (context_enlargeIn == 0) {
          context_enlargeIn = Math.pow(2, context_numBits);
          context_numBits++;
        }
      }
      value = 2;
      for (i = 0; i < context_numBits; i++) {
        context_data_val = (context_data_val << 1) | (value & 1);
        if (context_data_position == bitsPerChar - 1) {
          context_data_position = 0;
          context_data.push(getCharFromInt(context_data_val));
          context_data_val = 0;
        } else { context_data_position++; }
        value = value >> 1;
      }
      while (true) {
        context_data_val = (context_data_val << 1);
        if (context_data_position == bitsPerChar - 1) {
          context_data.push(getCharFromInt(context_data_val));
          break;
        } else context_data_position++;
      }
      return context_data.join('');
    }
    function _decompress(length, resetValue, getNextValue) {
      let dictionary = [],
          next, enlargeIn = 4, dictSize = 4, numBits = 3,
          entry = '',
          result = [],
          data = { val: getNextValue(0), position: resetValue, index: 1 };
      for (let i = 0; i < 3; i += 1) { dictionary[i] = i; }
      let bits = 0, maxpower = Math.pow(2, 2), power = 1;
      while (power != maxpower) {
        let resb = data.val & data.position;
        data.position >>= 1;
        if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
      }
      switch (next = bits) {
        case 0:
          bits = 0;
          maxpower = Math.pow(2, 8);
          power = 1;
          while (power != maxpower) {
            let resb = data.val & data.position;
            data.position >>= 1;
            if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
          }
          c = String.fromCharCode(bits); break;
        case 1:
          bits = 0;
          maxpower = Math.pow(2, 16);
          power = 1;
          while (power != maxpower) {
            let resb = data.val & data.position;
            data.position >>= 1;
            if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
          }
          c = String.fromCharCode(bits); break;
        case 2: return '';
      }
      dictionary[3] = c;
      let w = c, c, c2;
      result.push(c);
      while (true) {
        if (data.index > length) return '';
        bits = 0;
        maxpower = Math.pow(2, numBits);
        power = 1;
        while (power != maxpower) {
          let resb = data.val & data.position;
          data.position >>= 1;
          if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
          bits |= (resb > 0 ? 1 : 0) * power;
          power <<= 1;
        }
        switch (c = bits) {
          case 0:
            bits = 0;
            maxpower = Math.pow(2, 8);
            power = 1;
            while (power != maxpower) {
              let resb = data.val & data.position;
              data.position >>= 1;
              if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
              bits |= (resb > 0 ? 1 : 0) * power;
              power <<= 1;
            }
            dictionary[dictSize++] = String.fromCharCode(bits); c = dictSize - 1; enlargeIn--; break;
          case 1:
            bits = 0;
            maxpower = Math.pow(2, 16);
            power = 1;
            while (power != maxpower) {
              let resb = data.val & data.position;
              data.position >>= 1;
              if (data.position == 0) { data.position = resetValue; data.val = getNextValue(data.index++); }
              bits |= (resb > 0 ? 1 : 0) * power;
              power <<= 1;
            }
            dictionary[dictSize++] = String.fromCharCode(bits); c = dictSize - 1; enlargeIn--; break;
          case 2: return result.join('');
        }
        if (enlargeIn == 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
        if (dictionary[c]) { entry = dictionary[c]; }
        else {
          if (c === dictSize) entry = w + w.charAt(0);
          else return null;
        }
        result.push(entry);
        dictionary[dictSize++] = w + entry.charAt(0);
        enlargeIn--;
        w = entry;
        if (enlargeIn == 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
      }
    }
    return { compressToBase64, decompressFromBase64 };
  })();

  // ========== 分享链接相关 ==========
  // 将当前明细数据编码到 URL hash，生成分享链接
  function generateShareLink() {
    if (!uploadedDetail || uploadedDetail.length === 0) {
      showToast('当前没有真实数据，无法分享');
      return null;
    }
    try {
      const payload = {
        v: 1,
        detail: uploadedDetail,
        fetchTime: data.updateTime,
        dates: data.dates,
        kocType: KOC_TYPE
      };
      const jsonStr = JSON.stringify(payload);
      const compressed = LZString.compressToBase64(jsonStr);
      // URL 安全的 base64
      const safe = compressed.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const link = window.location.origin + window.location.pathname + '#d=' + safe;
      return link;
    } catch(e) {
      console.error('生成分享链接失败:', e);
      showToast('生成分享链接失败');
      return null;
    }
  }

  // 从 URL hash 读取并渲染数据
  function loadFromHash() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('#d=')) return false;
    try {
      const safe = hash.replace('#d=', '');
      // 恢复 base64 填充
      let b64 = safe.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';
      
      const jsonStr = LZString.decompressFromBase64(b64);
      if (!jsonStr) return false;
      
      const payload = JSON.parse(jsonStr);
      if (!payload.detail || payload.detail.length === 0) return false;
      
      uploadedDetail = payload.detail;
      const newData = buildDashboardFromDetail(payload.detail);
      if (!newData) return false;
      
      data = newData;
      isRealData = true;
      dataSource = 'share';
      
      if (payload.kocType) KOC_TYPE = payload.kocType;
      if (payload.fetchTime) data.updateTime = payload.fetchTime;
      
      updateDataSourceBadge();
      return true;
    } catch(e) {
      console.warn('从 URL 加载数据失败:', e);
      return false;
    }
  }

  window.shareDashboard = function() {
    const link = generateShareLink();
    if (!link) return;
    
    // 显示分享弹窗
    const modal = document.getElementById('shareModal');
    const input = document.getElementById('shareLinkInput');
    const tip = document.getElementById('shareDataTip');
    
    input.value = link;
    tip.textContent = `共 ${uploadedDetail.length} 条明细数据，${data.dates ? data.dates.length : 0} 天`;
    modal.classList.add('show');
    
    // 自动选中
    setTimeout(() => { input.select(); }, 100);
  };

  window.copyShareLink = function() {
    const input = document.getElementById('shareLinkInput');
    input.select();
    try {
      document.execCommand('copy');
      showToast('链接已复制，发给同事就能看');
    } catch(e) {
      showToast('复制失败，请手动复制');
    }
  };

  window.hideShareModal = function() {
    document.getElementById('shareModal').classList.remove('show');
  };

  // 监听 hash 变化（比如从书签跳转过来）
  window.addEventListener('hashchange', function() {
    if (loadFromHash()) {
      renderAll();
      showToast('已加载分享数据');
    }
  });

  /* ---------- 从伏羲系统自动拉取 ---------- */
  // 从伏羲系统拉取数据（可被自动刷新调用，内部判断按钮状态）
  function doFetchFromFuxi(silent) {
    const btn = document.getElementById('fuxiBtn');
    if (!silent) {
      btn.classList.add('loading');
      btn.disabled = true;
    }

    const url = `${FUXI_API_BASE}/api/fetch`;
    
    return fetch(url, {
      method: 'GET',
      mode: 'cors'
    })
    .then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(result => {
      if (!result.detail || result.detail.length === 0) {
        throw new Error('返回数据为空');
      }
      
      // 转换格式
      const detail = result.detail.map(r => ({
        date: r.date,
        channel: r.channel,
        anchor: r.anchor,
        grade: r.grade,
        count: r.count
      }));
      
      uploadedDetail = detail;
      const newData = buildDashboardFromDetail(detail);
      if (!newData) throw new Error('数据构建失败');
      
      data = newData;
      isRealData = true;
      dataSource = 'fuxi';
      try { localStorage.setItem('koc_data_source', 'fuxi'); } catch(e) {}
      updateDataSourceBadge();
      renderAll();
      if (!silent) showToast(`从伏羲拉取成功，共 ${detail.length} 条数据`);
      return detail;
    })
    .catch(err => {
      console.error('伏羲拉取失败:', err);
      if (!silent) {
        const msg = err.message.includes('Failed to fetch') 
          ? '无法连接伏羲代理，请确认本地代理服务已启动（http://localhost:8765）'
          : '拉取失败：' + err.message;
        showToast(msg);
      }
      throw err;
    })
    .finally(() => {
      if (!silent) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    });
  }

  window.fetchFromFuxi = function() {
    doFetchFromFuxi(false);
  };

  /* ---------- 自动刷新 ---------- */
  let autoRefreshCountdown = null;
  let nextRefreshSec = 0;

  function startAutoRefreshCountdown() {
    if (autoRefreshCountdown) clearInterval(autoRefreshCountdown);
    nextRefreshSec = AUTO_REFRESH_INTERVAL / 1000;
    updateCountdownText();
    autoRefreshCountdown = setInterval(() => {
      nextRefreshSec -= 1;
      if (nextRefreshSec <= 0) {
        nextRefreshSec = AUTO_REFRESH_INTERVAL / 1000;
      }
      updateCountdownText();
    }, 1000);
  }

  function stopAutoRefreshCountdown() {
    if (autoRefreshCountdown) {
      clearInterval(autoRefreshCountdown);
      autoRefreshCountdown = null;
    }
    const text = document.getElementById('autoRefreshText');
    if (text) text.textContent = '自动刷新';
  }

  function updateCountdownText() {
    const text = document.getElementById('autoRefreshText');
    if (!text) return;
    const m = Math.floor(nextRefreshSec / 60);
    const s = Math.floor(nextRefreshSec % 60);
    text.textContent = `自动刷新中（${m}:${s.toString().padStart(2, '0')}）`;
  }

  window.toggleAutoRefresh = function() {
    const toggle = document.getElementById('autoRefreshToggle');
    const on = toggle && toggle.checked;
    const text = document.getElementById('autoRefreshText');

    if (on) {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = setInterval(() => {
        // JSON数据源下静默刷新，不打扰用户
        if (dataSource === 'json') {
          fetchJsonDataSilent();
        } else {
          window.handleRefresh();
        }
        nextRefreshSec = AUTO_REFRESH_INTERVAL / 1000;
      }, AUTO_REFRESH_INTERVAL);
      showToast('已开启自动刷新（每2分钟）');
      startAutoRefreshCountdown();
    } else {
      if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
      }
      showToast('已关闭自动刷新');
      stopAutoRefreshCountdown();
    }
    // 保存偏好
    try {
      localStorage.setItem('koc_auto_refresh', on ? '1' : '0');
    } catch(e) {}
  };

  // 恢复自动刷新偏好
  function applyAutoRefreshSetting() {
    try {
      const pref = localStorage.getItem('koc_auto_refresh');
      const toggle = document.getElementById('autoRefreshToggle');
      const text = document.getElementById('autoRefreshText');
      if (pref === '1' && toggle) {
        toggle.checked = true;
        if (autoRefreshTimer) clearInterval(autoRefreshTimer);
        autoRefreshTimer = setInterval(() => {
          if (dataSource === 'json') {
            fetchJsonDataSilent();
          } else {
            window.handleRefresh();
          }
          nextRefreshSec = AUTO_REFRESH_INTERVAL / 1000;
        }, AUTO_REFRESH_INTERVAL);
        startAutoRefreshCountdown();
      }
    } catch(e) {}
  }

  async function fetchJsonDataSilent() {
    try {
      const resp = await fetch(JSON_DATA_URL + '?t=' + Date.now() + '&v=' + Date.now(), {
        method: 'GET',
        cache: 'no-cache',
        headers: { 'Cache-Control': 'no-cache, no-store' }
      });
      if (!resp.ok) return;
      const jsonData = await resp.json();
      if (!jsonData || !jsonData.detail || jsonData.detail.length === 0) return;

      if (jsonData.kpi && jsonData.daily && jsonData.grade && jsonData.anchor) {
        data = jsonData;
        // 优先用后端采集时间，没有就用本地拉取时间兜底
        data.updateTime = (jsonData.meta && jsonData.meta.updateTime) || jsonData.updateTime || formatNow();
      } else {
        data = buildDashboardFromDetail(jsonData.detail);
      }
      uploadedDetail = jsonData.detail || [];
      rebuildStatsByRealDate();
      renderAll();
    } catch(e) {
      // 静默失败，不打扰用户
    }
  }
  function restoreDataSourcePref() {
    // 优先级1：URL hash 里的分享数据
    if (loadFromHash()) {
      showToast('已加载分享数据');
      return;
    }
    
    try {
      // 优先级2：书签工具刚传来的数据（URL有标记）
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('source') === 'fuxi_bookmarklet') {
        const raw = localStorage.getItem('koc_bookmarklet_data');
        if (raw) {
          const payload = JSON.parse(raw);
          if (payload.detail && payload.detail.length > 0) {
            uploadedDetail = payload.detail;
            const newData = buildDashboardFromDetail(payload.detail);
            if (newData) {
              data = newData;
              isRealData = true;
              dataSource = 'bookmarklet';
              localStorage.setItem('koc_data_source', 'bookmarklet');
              updateDataSourceBadge();
              showToast(`已从伏羲抓取 ${payload.detail.length} 条数据`);
              return;
            }
          }
        }
      }

      // 优先级3：JSON 数据源（后端自动采集输出）
      // 默认尝试加载真实数据，加载失败自动回退到示例数据
      const savedSource = localStorage.getItem('koc_data_source');
      if (savedSource === 'json' || !savedSource) {
        fetchJsonData(true).then(ok => {
          if (ok) {
            // 加载成功，记录偏好
            try { localStorage.setItem('koc_data_source', 'json'); } catch(e) {}
            // 真实数据下默认开启自动刷新（用户没关过就开）
            const autoPref = localStorage.getItem('koc_auto_refresh');
            const toggle = document.getElementById('autoRefreshToggle');
            if (autoPref !== '0' && toggle && !toggle.checked) {
              toggle.checked = true;
              window.toggleAutoRefresh();
            } else if (autoPref === '1' && toggle && !toggle.checked) {
              toggle.checked = true;
              window.toggleAutoRefresh();
            }
          }
        });
        return;
      }
      
      // 优先级4：伏羲代理数据源
      if (savedSource === 'fuxi') {
        doFetchFromFuxi(true).catch(() => {});
      }
    } catch(e) {
      console.warn('恢复数据源失败:', e);
    }
  }

  function resetRefreshBtn() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.remove('loading');
    btn.disabled = false;
  }

  /* ---------- 数据源：JSON 文件（后端采集输出） ---------- */
  async function fetchJsonData(silent) {
    if (!silent) {
      const btn = document.getElementById('refreshBtn');
      btn.classList.add('loading');
      btn.disabled = true;
    }

    try {
      const resp = await fetch(JSON_DATA_URL + '?t=' + Date.now(), {
        method: 'GET',
        cache: 'no-cache'
      });
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status);
      }
      const jsonData = await resp.json();
      if (!jsonData || !jsonData.detail || jsonData.detail.length === 0) {
        throw new Error('数据为空');
      }

      // 如果 JSON 已经有完整看板结构就直接用，否则从明细重建
      if (jsonData.kpi && jsonData.daily && jsonData.grade && jsonData.anchor) {
        data = jsonData;
        data.updateTime = (jsonData.meta && jsonData.meta.updateTime) || jsonData.updateTime || formatNow();
      } else {
        data = buildDashboardFromDetail(jsonData.detail);
      }

      uploadedDetail = jsonData.detail || [];
      isRealData = true;
      dataSource = 'json';

      try {
        localStorage.setItem('koc_data_source', 'json');
      } catch(e) {}

      // 按系统真实日期重新计算 今天/昨天/近7天
      rebuildStatsByRealDate();

      updateDataSourceBadge();
      renderAll();

      if (!silent) {
        showToast(`数据已更新（${jsonData.detail.length} 条）`);
      }
      return true;
    } catch (err) {
      console.warn('加载 JSON 数据失败:', err);
      if (!silent) {
        showToast('加载数据失败：' + err.message);
      }
      return false;
    } finally {
      if (!silent) {
        const btn = document.getElementById('refreshBtn');
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
  }

  /* ---------- 切换到 JSON 自动采集数据源 ---------- */
  window.switchToJsonSource = function() {
    fetchJsonData(false).then(ok => {
      if (ok) {
        showToast('已切换到自动采集数据模式');
      }
    });
  };

  /* ---------- 按系统真实日期归一化数据 ---------- */
  // 根据系统时间重新计算 今天/昨天/近7天 的统计，不再依赖 JSON 里写死的 today 字段
  function getTodayStr() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function getYesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function getDateNDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const pad = n2 => String(n2).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 基于 detail 明细数据，按真实日期重新聚合各维度
  function rebuildStatsByRealDate() {
    if (!data.detail || data.detail.length === 0) return;

    const todayStr = getTodayStr();
    const yesterdayStr = getYesterdayStr();
    const d7Start = getDateNDaysAgo(6); // 近7天 = 今天往前推6天

    const detail = data.detail;
    const dailyMap = {};
    detail.forEach(r => {
      if (!dailyMap[r.date]) {
        dailyMap[r.date] = { count: 0, retain48h: 0, delete48h: 0 };
      }
      dailyMap[r.date].count += r.count || 0;
      dailyMap[r.date].retain48h += r.retain48h || 0;
      dailyMap[r.date].delete48h += r.delete48h || 0;
    });
    // 计算各天留存率
    Object.values(dailyMap).forEach(d => {
      d.retainRate48h = d.count > 0 ? +(d.retain48h / d.count * 100).toFixed(1) : 0;
    });

    // 取近7天的日期数组（包含今天，即使今天暂无数据）
    const dates7d = [];
    for (let i = 6; i >= 0; i--) {
      dates7d.push(getDateNDaysAgo(i));
    }

    // 近7天每日数据
    const daily7d = dates7d.map(d => {
      const item = dailyMap[d] || { count: 0, retain48h: 0, delete48h: 0, retainRate48h: 0 };
      return { date: d, ...item };
    });

    // 今日/昨日/前日总数
    const todayItem = dailyMap[todayStr] || { count: 0, retain48h: 0, delete48h: 0, retainRate48h: 0 };
    const yesterdayItem = dailyMap[yesterdayStr] || { count: 0, retain48h: 0, delete48h: 0, retainRate48h: 0 };
    const dayBeforeItem = dailyMap[getDateNDaysAgo(2)] || { count: 0, retain48h: 0, delete48h: 0, retainRate48h: 0 };
    const todayCount = todayItem.count;
    const yesterdayCount = yesterdayItem.count;
    const dayBeforeCount = dayBeforeItem.count;

    // 近7天总数 & 上一周期（再往前7天）
    const total7d = daily7d.reduce((s, d) => s + d.count, 0);
    const datesPrev7d = [];
    for (let i = 13; i >= 7; i--) {
      datesPrev7d.push(getDateNDaysAgo(i));
    }
    const totalPrev7d = datesPrev7d.reduce((s, d) => s + (dailyMap[d]?.count || 0), 0);
    const total7dDelta = total7d - totalPrev7d;
    const total7dDeltaPct = totalPrev7d > 0 ? (total7dDelta / totalPrev7d * 100).toFixed(1) : '0.0';

    const todayDelta = todayCount - yesterdayCount;
    const todayDeltaPct = yesterdayCount > 0 ? (todayDelta / yesterdayCount * 100).toFixed(1) : '0.0';
    const ytdDelta = yesterdayCount - dayBeforeCount;
    const ytdDeltaPct = dayBeforeCount > 0 ? (ytdDelta / dayBeforeCount * 100).toFixed(1) : '0.0';

    // 按年级聚合（今日/昨日/近7天）
    const gradeSet = new Set(detail.map(r => r.grade).filter(g => g && g !== '未知'));
    const grades = Array.from(gradeSet);
    const gradeToday = {};
    const gradeYesterday = {};
    const grade7d = {};
    grades.forEach(g => {
      gradeToday[g] = detail.filter(r => r.date === todayStr && r.grade === g).reduce((s, r) => s + r.count, 0);
      gradeYesterday[g] = detail.filter(r => r.date === yesterdayStr && r.grade === g).reduce((s, r) => s + r.count, 0);
      grade7d[g] = detail.filter(r => dates7d.includes(r.date) && r.grade === g).reduce((s, r) => s + r.count, 0);
    });

    // 按主播聚合（今日/昨日/近7天）
    const anchorSet = new Set(detail.map(r => r.anchor));
    const anchors = Array.from(anchorSet);
    const anchorToday = {};
    const anchorYesterday = {};
    const anchor7d = {};
    anchors.forEach(a => {
      anchorToday[a] = detail.filter(r => r.date === todayStr && r.anchor === a).reduce((s, r) => s + r.count, 0);
      anchorYesterday[a] = detail.filter(r => r.date === yesterdayStr && r.anchor === a).reduce((s, r) => s + r.count, 0);
      anchor7d[a] = detail.filter(r => dates7d.includes(r.date) && r.anchor === a).reduce((s, r) => s + r.count, 0);
    });

    // 近7天明细（按日期倒序 + 数量倒序）
    const detail7d = detail
      .filter(r => dates7d.includes(r.date))
      .sort((a, b) => {
        if (b.date !== a.date) return b.date.localeCompare(a.date);
        return b.count - a.count;
      });

    // 更新 data 对象（保留原始 detail，增加计算字段）
    data.today = todayStr;
    data.yesterday = yesterdayStr;
    data.dates7d = dates7d;
    data.dateRangeText = `${dates7d[0]} 至 ${dates7d[6]}（7 天）`;
    data.daily7d = daily7d;
    data.detail7d = detail7d;

    data.kpi.today = todayCount;
    data.kpi.todayDelta = todayDelta;
    data.kpi.todayDeltaPct = todayDeltaPct;
    data.kpi.yesterday = yesterdayCount;
    data.kpi.ytdDelta = ytdDelta;
    data.kpi.ytdDeltaPct = ytdDeltaPct;
    data.kpi.total7d = total7d;
    data.kpi.total7dDelta = total7dDelta;
    data.kpi.total7dDeltaPct = total7dDeltaPct;
    data.kpi.avg7d = Math.round(total7d / 7);

    data.grade.today = gradeToday;
    data.grade.yesterday = gradeYesterday;
    data.grade.d7 = grade7d;
    if (!data.grade.grades || data.grade.grades.length === 0) {
      data.grade.grades = grades.length > 0 ? grades : ['未知'];
    }

    data.anchor.today = anchorToday;
    data.anchor.yesterday = anchorYesterday;
    data.anchor.d7 = anchor7d;
    if (!data.anchor.anchors || data.anchor.anchors.length === 0) {
      data.anchor.anchors = anchors;
    }

    // === 分组汇总：大写KOC=郑州五组，小写koc=郑州三组 ===
    const GROUPS = [
      { key: 'zz5', name: '郑州五组', match: ch => ch.startsWith('KOC') },
      { key: 'zz3', name: '郑州三组', match: ch => ch.startsWith('koc') }
    ];
    data.groups = GROUPS.map(g => {
      const rows = detail.filter(r => g.match(r.channel || ''));
      const todayRows = rows.filter(r => r.date === todayStr);
      const yesterdayRows = rows.filter(r => r.date === yesterdayStr);
      const d7Rows = rows.filter(r => dates7d.includes(r.date));

      const todayCount = todayRows.reduce((s, r) => s + r.count, 0);
      const todayRetain = todayRows.reduce((s, r) => s + (r.retain48h || 0), 0);
      const yesterdayCount = yesterdayRows.reduce((s, r) => s + r.count, 0);
      const yesterdayRetain = yesterdayRows.reduce((s, r) => s + (r.retain48h || 0), 0);
      const d7Count = d7Rows.reduce((s, r) => s + r.count, 0);
      const d7Retain = d7Rows.reduce((s, r) => s + (r.retain48h || 0), 0);

      // 组内主播明细
      const anchorSet = new Set(rows.map(r => r.anchor));
      const anchorsInGroup = Array.from(anchorSet);
      const anchorDetail = {};
      anchorsInGroup.forEach(a => {
        anchorDetail[a] = {
          today: rows.filter(r => r.date === todayStr && r.anchor === a).reduce((s, r) => s + r.count, 0),
          yesterday: rows.filter(r => r.date === yesterdayStr && r.anchor === a).reduce((s, r) => s + r.count, 0),
          d7: rows.filter(r => dates7d.includes(r.date) && r.anchor === a).reduce((s, r) => s + r.count, 0)
        };
      });

      return {
        key: g.key,
        name: g.name,
        today: todayCount,
        todayRetain: todayRetain,
        yesterday: yesterdayCount,
        yesterdayRetain: yesterdayRetain,
        d7: d7Count,
        d7Retain: d7Retain,
        d7RetainRate: d7Count > 0 ? +(d7Retain / d7Count * 100).toFixed(1) : 0,
        anchors: anchorsInGroup,
        anchorDetail: anchorDetail
      };
    });
  }

  /* ---------- 渲染：筛选条 ---------- */
  function renderFilterBar() {
    const dates = data.dates7d || data.dates;
    document.getElementById('filterDate').textContent = data.dateRangeText;
    document.getElementById('updateTime').textContent = data.updateTime;
    document.getElementById('dateRange').textContent = `近 7 天（${dates[0]} ～ ${dates[dates.length - 1]}）`;
    updateFreshnessDot();
  }

  function updateFreshnessDot() {
    const dot = document.getElementById('freshnessDot');
    if (!dot) return;
    if (!data || !data.updateTime || dataSource === 'sample') {
      dot.className = 'freshness-dot offline';
      dot.title = '示例数据，未接入采集';
      return;
    }
    try {
      // 解析 updateTime （格式如 "2026-08-08 16:32"）
      const t = new Date(data.updateTime.replace(' ', 'T'));
      if (isNaN(t.getTime())) {
        dot.className = 'freshness-dot';
        return;
      }
      const diffMin = (Date.now() - t.getTime()) / 60000;
      if (diffMin < 90) {
        dot.className = 'freshness-dot';
        dot.title = `数据新鲜（${Math.round(diffMin)} 分钟前更新）`;
      } else if (diffMin < 360) {
        dot.className = 'freshness-dot stale';
        dot.title = `数据有延迟（${Math.round(diffMin/60*10)/10} 小时前更新）`;
      } else {
        dot.className = 'freshness-dot offline';
        dot.title = `采集可能离线（${Math.round(diffMin/60)} 小时前更新）`;
      }
    } catch(e) {
      dot.className = 'freshness-dot';
    }
  }

  window.checkCollectorHealth = function() {
    const btn = document.getElementById('healthCheckBtn');
    if (!btn) return;
    btn.classList.add('loading');
    btn.disabled = true;

    // 重新拉一次数据，通过时间戳新鲜度判断采集是否活着
    fetch(JSON_DATA_URL + '?t=' + Date.now(), { cache: 'no-cache' })
      .then(r => r.ok ? r.json() : null)
      .then(jsonData => {
        if (!jsonData || !jsonData.updateTime) {
          showToast('无法获取数据，请检查采集服务', 'error');
          return;
        }
        const t = new Date(jsonData.updateTime.replace(' ', 'T'));
        const diffMin = (Date.now() - t.getTime()) / 60000;
        let msg, type;
        if (diffMin < 90) {
          msg = `采集正常 · ${Math.round(diffMin)} 分钟前更新`;
          type = 'success';
        } else if (diffMin < 360) {
          msg = `采集有延迟 · ${Math.round(diffMin/60*10)/10} 小时前更新`;
          type = 'warning';
        } else {
          msg = `采集疑似离线 · ${Math.round(diffMin/60)} 小时前更新`;
          type = 'error';
        }
        showToast(msg, type);
        // 顺便更新一下数据
        if (jsonData.kpi && jsonData.daily && jsonData.grade && jsonData.anchor) {
          data = jsonData;
        } else if (jsonData.detail) {
          data = buildDashboardFromDetail(jsonData.detail);
        }
        uploadedDetail = jsonData.detail || [];
        rebuildStatsByRealDate();
        renderAll();
      })
      .catch(() => {
        showToast('检查失败：无法拉取数据', 'error');
      })
      .finally(() => {
        btn.classList.remove('loading');
        btn.disabled = false;
      });
  };

  /* ---------- 渲染：KPI ---------- */
  function renderKPI() {
    const k = data.kpi;

    document.getElementById('kpiToday').textContent = fmt(k.today);
    const td = document.getElementById('kpiTodayDelta');
    td.className = 'kpi-delta ' + (k.todayDelta >= 0 ? 'up' : 'down');
    td.textContent = `${fmtPct(k.todayDeltaPct)} （${k.todayDelta >= 0 ? '+' : ''}${fmt(k.todayDelta)}人）`;

    document.getElementById('kpi7d').textContent = fmt(k.total7d);
    const d7 = document.getElementById('kpi7dDelta');
    d7.className = 'kpi-delta ' + (k.total7dDelta >= 0 ? 'up' : 'down');
    d7.textContent = `${fmtPct(k.total7dDeltaPct)}`;

    document.getElementById('kpiYtd').textContent = fmt(k.yesterday);
    const yd = document.getElementById('kpiYtdDelta');
    yd.className = 'kpi-delta ' + (k.ytdDelta >= 0 ? 'up' : 'down');
    yd.textContent = `${fmtPct(k.ytdDeltaPct)}`;

    document.getElementById('kpiAvg').textContent = fmt(k.avg7d);

    // 48h 留存率
    const retainEl = document.getElementById('kpiRetain');
    const retainTodayEl = document.getElementById('kpiRetainToday');
    if (k.retainRate48h !== undefined) {
      retainEl.innerHTML = `${k.retainRate48h}<small>%</small>`;
      const todayRate = k.todayRetainRate48h || 0;
      retainTodayEl.textContent = `今日 ${todayRate}%`;
    } else {
      retainEl.innerHTML = `—<small>%</small>`;
      retainTodayEl.textContent = '暂无数据';
    }
  }

  /* ---------- 渲染：趋势图 ---------- */
  function renderTrendChart() {
    const el = document.getElementById('trendChart');
    if (!trendChart) {
      trendChart = echarts.init(el);
      new ResizeObserver(() => trendChart.resize()).observe(el);
    }

    const dailyData = data.daily7d || data.daily;
    const dates = dailyData.map(d => d.date);
    const hasRetain = dailyData.some(d => d.retain48h !== undefined);

    let values, color, label, unit, yMax, isRate = false;
    if (trendMetric === 'retain' && hasRetain) {
      values = dailyData.map(d => d.retain48h || 0);
      color = '#16a34a';
      label = '48h留存数';
      unit = '人';
      const max = Math.max(...values);
      yMax = Math.ceil(max * 1.2 / 100) * 100;
    } else if (trendMetric === 'rate' && hasRetain) {
      values = dailyData.map(d => d.retainRate48h || 0);
      color = '#7c3aed';
      label = '48h留存率';
      unit = '%';
      const max = Math.max(...values);
      yMax = Math.min(100, Math.ceil(max * 1.15 / 5) * 5);
      isRate = true;
    } else {
      values = dailyData.map(d => d.count);
      color = COLORS.brand;
      label = '加好友数';
      unit = '人';
      const max = Math.max(...values, 1);
      yMax = Math.ceil(max * 1.4 / 10) * 10;
    }

    const option = {
      grid: {
        left: '3%',
        right: '4%',
        top: 30,
        bottom: 30,
        containLabel: true
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#fff',
        borderColor: COLORS.grid,
        borderWidth: 1,
        textStyle: { color: COLORS.textPrimary, fontSize: 12 },
        formatter: function(params) {
          const p = params[0];
          const v = isRate ? p.value + '%' : fmt(p.value);
          return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
              <span>${label}</span>
              <span style="font-weight:600;margin-left:auto">${v}</span>
            </div>`;
        }
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLine: { lineStyle: { color: COLORS.grid } },
        axisTick: { show: false },
        axisLabel: {
          color: COLORS.textSecondary,
          fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace'
        }
      },
      yAxis: {
        type: 'value',
        max: yMax,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: COLORS.textTertiary,
          fontSize: 11,
          fontFamily: 'JetBrains Mono, monospace',
          formatter: isRate ? '{value}%' : null
        },
        splitLine: {
          lineStyle: {
            color: COLORS.grid,
            type: 'dashed'
          }
        }
      },
       series: [{
         name: label,
         type: 'line',
         data: values,
         smooth: true,
         symbol: 'circle',
         symbolSize: 8,
         showSymbol: true,
         label: {
           show: true,
           position: 'top',
           color: COLORS.textPrimary,
           fontSize: 12,
           fontWeight: 600,
           fontFamily: 'JetBrains Mono, monospace',
           formatter: function(params) {
             if (isRate) return params.value + '%';
             return Math.round(params.value);
           }
         },
         lineStyle: {
          color: color,
          width: 2.5
        },
        itemStyle: {
          color: color,
          borderColor: '#fff',
          borderWidth: 2
        },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: hexToRgba(color, 0.18) },
            { offset: 1, color: hexToRgba(color, 0.02) }
          ])
        },
        emphasis: {
          itemStyle: { borderWidth: 3 }
        },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{
            type: 'average',
            name: '均值',
            lineStyle: {
              color: COLORS.textTertiary,
              type: 'dashed',
              width: 1
            },
            label: {
              formatter: isRate ? '均值 {c}%' : '均值 {c}',
              color: COLORS.textSecondary,
              fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace'
            }
          }]
        }
      }]
    };

    trendChart.setOption(option, true);
  }

  // hex 转 rgba 辅助
  function hexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /* ---------- 渲染：年级统计 ---------- */
  function renderGradeBars() {
    let gradeData;
    if (gradeTab === 'd7') {
      gradeData = data.grade.d7 || data.grade.today;
    } else if (gradeTab === 'yesterday') {
      gradeData = data.grade.yesterday;
    } else {
      gradeData = data.grade.today;
    }
    const total = Object.values(gradeData).reduce((s, v) => s + v, 0);
    const max = Math.max(...Object.values(gradeData));

    const container = document.getElementById('gradeBars');
    container.innerHTML = '';

    data.grade.grades.forEach((g, idx) => {
      const count = gradeData[g];
      const pct = total > 0 ? (count / total * 100).toFixed(1) : 0;
      const width = max > 0 ? (count / max * 100) : 0;
      const color = COLORS.grade[g] || COLORS.brand;

      const row = document.createElement('div');
      row.className = 'grade-row';
      row.innerHTML = `
        <div class="grade-row-head">
          <span class="grade-name">${g}</span>
          <span class="grade-num mono">${fmt(count)} <small>${pct}%</small></span>
        </div>
        <div class="grade-bar-track">
          <div class="grade-bar-fill" style="width:0%;background:${color}"></div>
        </div>
      `;
      container.appendChild(row);

      // 触发动画
      requestAnimationFrame(() => {
        setTimeout(() => {
          row.querySelector('.grade-bar-fill').style.width = width + '%';
        }, idx * 80);
      });
    });

    document.getElementById('gradeTotal').textContent = fmt(total);
  }

  /* ---------- 渲染：主播排行 ---------- */
  function renderAnchorList() {
    let anchorData;
    if (anchorTab === 'd7') {
      anchorData = data.anchor.d7 || data.anchor.today;
    } else if (anchorTab === 'yesterday') {
      anchorData = data.anchor.yesterday;
    } else {
      anchorData = data.anchor.today;
    }
    const total = Object.values(anchorData).reduce((s, v) => s + v, 0);
    
    // 排序取TOP 10
    const sorted = Object.entries(anchorData)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const max = sorted.length ? sorted[0][1] : 0;

    const container = document.getElementById('anchorList');
    container.innerHTML = '';

    sorted.forEach(([name, count], idx) => {
      const pct = total > 0 ? (count / total * 100).toFixed(1) : 0;
      const width = max > 0 ? (count / max * 100) : 0;
      const color = COLORS.anchor[idx % COLORS.anchor.length];

      const rankClass = idx === 0 ? 'top-1' : idx === 1 ? 'top-2' : idx === 2 ? 'top-3' : '';

      const item = document.createElement('div');
      item.className = 'anchor-item';
      item.innerHTML = `
        <div class="anchor-rank ${rankClass}">${idx + 1}</div>
        <div class="anchor-info">
          <div class="anchor-name">${name}</div>
          <div class="anchor-bar-track">
            <div class="anchor-bar-fill" style="width:0%;background:${color}"></div>
          </div>
        </div>
        <div class="anchor-num mono">
          ${fmt(count)}
          <small>${pct}%</small>
        </div>
      `;
      container.appendChild(item);

      requestAnimationFrame(() => {
        setTimeout(() => {
          item.querySelector('.anchor-bar-fill').style.width = width + '%';
        }, idx * 40);
      });
    });
  }

  /* ---------- 渲染：分组汇总 ---------- */
  function renderGroupSummary() {
    if (!data.groups || data.groups.length === 0) {
      document.getElementById('groupCards').innerHTML = '<p style="color:var(--gray-400);font-size:13px;">暂无分组数据</p>';
      return;
    }

    const container = document.getElementById('groupCards');
    container.innerHTML = '';

    data.groups.forEach((g, gIdx) => {
      const count = groupTab === 'yesterday' ? g.yesterday : groupTab === 'd7' ? g.d7 : g.today;
      const retain = groupTab === 'yesterday' ? g.yesterdayRetain : groupTab === 'd7' ? g.d7Retain : g.todayRetain;
      const retainRate = count > 0 ? (retain / count * 100).toFixed(1) : '0.0';

      // 对比值：今日 vs 昨日，昨日 vs 前日，近7天 vs 总平均
      let delta = 0;
      let deltaPct = '0.0';
      if (groupTab === 'today') {
        delta = g.today - g.yesterday;
        deltaPct = g.yesterday > 0 ? (delta / g.yesterday * 100).toFixed(1) : '0.0';
      } else if (groupTab === 'yesterday') {
        // 无进一步对比，显示 0
      } else {
        // d7: 对比日均
        const avg = g.d7 / 7;
        delta = Math.round(g.today - avg);
        deltaPct = avg > 0 ? ((g.today - avg) / avg * 100).toFixed(1) : '0.0';
      }

      // 组内主播明细（按当前 tab 排序）
      const anchorField = groupTab === 'yesterday' ? 'yesterday' : groupTab === 'd7' ? 'd7' : 'today';
      const sortedAnchors = g.anchors
        .map(a => ({ name: a, count: (g.anchorDetail[a] || {})[anchorField] || 0 }))
        .sort((a, b) => b.count - a.count);
      const maxAnchor = sortedAnchors.length ? sortedAnchors[0].count : 1;
      const anchorTotal = sortedAnchors.reduce((s, a) => s + a.count, 0);

      const card = document.createElement('div');
      card.className = `group-card ${g.key}`;

      let anchorsHtml = sortedAnchors.map(a => {
        const pct = anchorTotal > 0 ? (a.count / anchorTotal * 100).toFixed(1) : '0.0';
        const barW = maxAnchor > 0 ? (a.count / maxAnchor * 100) : 0;
        return `<div class="group-anchor-row">
          <span class="group-anchor-name">${a.name}</span>
          <div class="group-anchor-bar-track">
            <div class="group-anchor-bar-fill" style="width:${barW}%"></div>
          </div>
          <span class="group-anchor-num">${fmt(a.count)}<small>${pct}%</small></span>
        </div>`;
      }).join('');

      card.innerHTML = `
        <div class="group-card-head">
          <span class="group-card-name">${g.name}</span>
          <span class="group-card-tag">${g.key === 'zz5' ? 'KOC' : 'koc'}</span>
        </div>
        <div class="group-card-kpis">
          <div class="group-kpi">
            <span class="group-kpi-label">${groupTab === 'd7' ? '7天总计' : groupTab === 'yesterday' ? '昨日' : '今日'}</span>
            <span class="group-kpi-value">${fmt(count)}</span>
            ${groupTab !== 'yesterday' ? `<span class="group-kpi-delta ${delta >= 0 ? 'up' : 'down'}">${fmtPct(deltaPct)}</span>` : ''}
          </div>
          <div class="group-kpi">
            <span class="group-kpi-label">留存</span>
            <span class="group-kpi-value">${fmt(retain)}</span>
          </div>
          <div class="group-kpi">
            <span class="group-kpi-label">留存率</span>
            <span class="group-kpi-value">${retainRate}<small>%</small></span>
          </div>
        </div>
        <div class="group-anchor-list">${anchorsHtml}</div>
      `;
      container.appendChild(card);
    });
  }

  window.switchGroupTab = function(tab) {
    groupTab = tab;
    document.querySelectorAll('[data-gtab]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-gtab') === tab);
    });
    renderGroupSummary();
  };

  /* ---------- 渲染：明细表 ---------- */
  function renderDetailTable() {
    const tbody = document.getElementById('detailBody');
    // 展示近7天明细，取TOP 50
    const detailData = data.detail7d || data.detail;
    const rows = detailData.slice(0, 50);
    const total = rows.reduce((s, r) => s + r.count, 0);

    tbody.innerHTML = rows.map(r => {
      const pct = total > 0 ? (r.count / total * 100).toFixed(1) : 0;
      return `
        <tr>
          <td class="mono">${r.date}</td>
          <td><code style="background:#f1f5f9;padding:1px 6px;border-radius:4px;font-size:12px">${r.channel}</code></td>
          <td>${r.anchor}</td>
          <td>${r.grade}</td>
          <td class="num mono">${fmt(r.count)}</td>
          <td class="num">
            <span class="pct-cell">
              <span class="pct-text">${pct}%</span>
              <span class="pct-bar"><span class="pct-bar-fill" style="width:${pct * 2}%"></span></span>
            </span>
          </td>
        </tr>
      `;
    }).join('');
  }

  /* ---------- 交互：刷新 ---------- */
  window.handleRefresh = function() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('loading');
    btn.disabled = true;

    // 如果是 JSON 数据源，重新加载 JSON 文件
    if (dataSource === 'json') {
      fetchJsonData(false)
        .then(ok => {
          if (ok) showToast('数据已刷新');
        })
        .finally(() => {
          btn.classList.remove('loading');
          btn.disabled = false;
        });
      return;
    }

    // 如果是伏羲数据源，自动刷新时重新从伏羲拉取
    if (dataSource === 'fuxi') {
      doFetchFromFuxi(true)
        .then(() => {
          showToast('数据已更新（来自伏羲）');
        })
        .catch(() => {
          // 静默失败时用已有数据更新时间戳
          if (uploadedDetail) {
            const newData = buildDashboardFromDetail(uploadedDetail);
            if (newData) data = newData;
            renderAll();
          }
          showToast('伏羲拉取失败，使用缓存数据');
        })
        .finally(() => {
          btn.classList.remove('loading');
          btn.disabled = false;
        });
      return;
    }

    setTimeout(() => {
      if (isRealData && uploadedDetail) {
        // 已导入真实数据：重新计算（不改变数据，只更新更新时间）
        const newData = buildDashboardFromDetail(uploadedDetail);
        if (newData) {
          data = newData;
        }
      } else {
        // 示例数据：模拟刷新
        data = window.buildDashboardData();
      }
      renderAll();
      btn.classList.remove('loading');
      btn.disabled = false;
      showToast('数据已更新');
    }, 600);
  };

  /* ---------- 自动刷新 ---------- */
  // 恢复数据源偏好：优先级 URL hash > bookmarklet > json > fuxi代理 > 默认

  /* ---------- 交互：Tab 切换 ---------- */
  window.switchGradeTab = function(tab) {
    if (gradeTab === tab) return;
    gradeTab = tab;
    document.querySelectorAll('.panel-grade .tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    renderGradeBars();
  };

  window.switchAnchorTab = function(tab) {
    if (anchorTab === tab) return;
    anchorTab = tab;
    document.querySelectorAll('.panel-anchor .tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.atab === tab);
    });
    renderAnchorList();
  };

  // 趋势图指标切换
  window.switchTrendMetric = function(metric) {
    if (trendMetric === metric) return;
    trendMetric = metric;
    document.querySelectorAll('#trendTabs .ptab').forEach(b => {
      b.classList.toggle('active', b.dataset.metric === metric);
    });
    renderTrendChart();
  };

  /* ---------- 交互：导出 ---------- */
  window.handleExport = function() {
    const headers = ['日期', '二级渠道', '主播', '年级', '加好友数'];
    const rows = data.detail.map(r => [r.date, r.channel, r.anchor, r.grade, r.count]);
    
    let csv = '\uFEFF' + headers.join(',') + '\n';
    rows.forEach(r => { csv += r.join(',') + '\n'; });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `伏羲_QC渠道加好友数据_${data.today}.csv`;
    a.click();
    URL.revokeObjectURL(url);

    showToast('已导出 CSV 文件');
  };

  /* ---------- 全部渲染 ---------- */
  function renderAll() {
    // 按系统真实日期归一化（今天/昨天/近7天），有detail数据时才执行
    if (data.detail && data.detail.length > 0) {
      rebuildStatsByRealDate();
    }
    updateDataSourceBadge();
    renderFilterBar();
    renderKPI();
    renderTrendChart();
    renderGradeBars();
    renderGroupSummary();
    renderAnchorList();
    renderDetailTable();
  }

  // 初始化
  applyAutoRefreshSetting();
  restoreDataSourcePref();
  renderAll();
  initBookmarklet();

  // 切回页面时自动静默刷新一次（后台跑了2分钟以上没看的话）
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && dataSource === 'json' && autoRefreshTimer) {
      fetchJsonDataSilent();
    }
  });

  // 初始化 bookmarklet 链接（把压缩+URL编码的数据直接放 hash）
  function initBookmarklet() {
    // 生成 bookmarklet 代码：在伏羲页面抓取表格，压缩后放 URL hash 跳转到看板
    const bmCode = `
javascript:(function(){var D=location.origin.includes('localhost')?'http://localhost:8080/app/app_17bnsab62yv/':(localStorage.getItem('koc_dashboard_url')||'https://your-dashboard-url/');function n(s){if(!s)return'';let t=String(s).trim().replace(/^"|"$/g,''),m;t=m=t.match(/(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})/)?m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0'):(m=t.match(/^(\\d{1,2})[-/](\\d{1,2})$/)?m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0'):(m=t.match(/(\\d{1,2})月(\\d{1,2})日/)?m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0'):t)));return t}function a(c){if(!c)return'未知';let p=String(c).replace(/_/g,'-').split('-').map(x=>x.trim()).filter(x=>x&&!/^\\d+$/.test(x));return p.length>0?p[p.length-1]:String(c)}function rd(){let t=null,h=[],d=[];document.querySelectorAll('table').forEach(function(tb){let rs=tb.querySelectorAll('tr');if(rs.length<3)return;let hs=[],hc=rs[0].querySelectorAll('th,td');hc.forEach(c=>hs.push(c.innerText.trim()));let hd=hs.some(x=>/日期|date/i.test(x)),ch=hs.some(x=>/渠道|channel/i.test(x)),cn=hs.some(x=>/加好友|好友数|新增|人数/i.test(x));if(hd&&ch&&cn){let dt=[];for(let i=1;i<rs.length;i++){let cs=rs[i].querySelectorAll('td');if(cs.length<3)continue;let ro={};cs.forEach((c,j)=>{if(j<hs.length)ro[hs[j]]=c.innerText.trim()});dt.push(ro)}if(dt.length>d.length){t=tb;h=hs;d=dt}}});return{headers:h,rows:d}}function ic(hs){let c={date:null,channel:null,grade:null,count:null};for(let h of hs){if(/日期|date|投放日期/.test(h)&&!c.date)c.date=h;else if(/二级渠道/.test(h))c.channel=h;else if(/渠道/.test(h)&&!c.channel)c.channel=h;else if(/年级|学段|年级段/.test(h))c.grade=h;else if(/加好友|好友数|新增人数|加好友数/.test(h)&&!c.count)c.count=h}return c}function tf(rs,cl){let re=[];for(let r of rs){let ch=String(r[cl.channel]||'');if(!ch.toUpperCase().includes('KOC'))continue;let dt=n(r[cl.date]||''),cs=String(r[cl.count]||'0').replace(/[,，]/g,''),cn=0;try{cn=parseInt(parseFloat(cs))}catch(e){}if(cn<=0)continue;let gr=cl.grade?String(r[cl.grade]||''):'未知';if(!gr||gr==='-'||gr==='null'||gr==='undefined')gr='未知';re.push({date:dt,channel:ch,anchor:a(ch),grade:gr,count:cn})}}re.sort((x,y)=>y.count-x.count);return re}var dm=rd(),dt=[];if(dm.rows.length>0){var cl=ic(dm.headers);if(cl.date&&cl.channel&&cl.count)dt=tf(dm.rows,cl)}if(dt.length===0){alert('没抓到数据，请确认已登录伏羲并在加好友数据页面，且二级渠道包含KOC。');return}var LZString=(function(){var ks='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=',br={};function gv(a,c){if(!br[a]){br[a]={};for(var i=0;i<a.length;i++)br[a][a.charAt(i)]=i}return br[a][c]}function cb(i){if(i==null)return'';var r=cp(i,6,function(a){return ks.charAt(a)});switch(r.length%4){case 0:return r;case 1:return r+'===';case 2:return r+'==';case 3:return r+'='}}function cp(u,b,gc){if(u==null)return'';var i,v,d={},dtc={},c='',wc='',w='',ei=2,ds=3,nb=2,da=[],dv=0,dp=0,ii,l;for(ii=0,l=u.length;ii<l;ii+=1){c=u.charAt(ii);if(!Object.prototype.hasOwnProperty.call(d,c)){d[c]=ds++;dtc[c]=true}wc=w+c;if(Object.prototype.hasOwnProperty.call(d,wc)){w=wc}else{if(Object.prototype.hasOwnProperty.call(dtc,w)){if(w.charCodeAt(0)<256){for(i=0;i<nb;i++){dv=(dv<<1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++}}v=w.charCodeAt(0);for(i=0;i<8;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}}else{v=1;for(i=0;i<nb;i++){dv=(dv<<1)|v;if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=0}v=w.charCodeAt(0);for(i=0;i<16;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}}ei--;if(ei==0){ei=Math.pow(2,nb);nb++}delete dtc[w]}else{v=d[w];for(i=0;i<nb;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}}ei--;if(ei==0){ei=Math.pow(2,nb);nb++}d[wc]=ds++;w=String(c)}}if(w!==''){if(Object.prototype.hasOwnProperty.call(dtc,w)){if(w.charCodeAt(0)<256){for(i=0;i<nb;i++){dv=(dv<<1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++}}v=w.charCodeAt(0);for(i=0;i<8;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}}else{v=1;for(i=0;i<nb;i++){dv=(dv<<1)|v;if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=0}v=w.charCodeAt(0);for(i=0;i<16;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}}ei--;if(ei==0){ei=Math.pow(2,nb);nb++}delete dtc[w]}else{v=d[w];for(i=0;i<nb;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}}ei--;if(ei==0){ei=Math.pow(2,nb);nb++}}}v=2;for(i=0;i<nb;i++){dv=(dv<<1)|(v&1);if(dp==b-1){dp=0;da.push(gc(dv));dv=0}else dp++;v=v>>1}while(true){dv=(dv<<1);if(dp==b-1){da.push(gc(dv));break}else dp++}return da.join('')}return{compressToBase64:cb}})();try{var payload={v:1,detail:dt,fetchTime:new Date().toLocaleString('zh-CN')};var jsonStr=JSON.stringify(payload);var compressed=LZString.compressToBase64(jsonStr);var safe=compressed.replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');window.location.href=D+'#d='+safe}catch(e){alert('保存失败：'+e.message)}})();
    `.trim();
    
    const link = document.getElementById('bookmarkletLink');
    if (link) {
      link.href = bmCode;
      link.setAttribute('title', '拖到书签栏后，在伏羲页面点我抓取数据');
    }
  }

  window.showBookmarkletGuide = function() {
    document.getElementById('bookmarkletModal').classList.add('show');
  };

  window.hideBookmarkletGuide = function() {
    document.getElementById('bookmarkletModal').classList.remove('show');
  };

  // 按 Esc 关闭弹窗
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      const modal = document.getElementById('bookmarkletModal');
      if (modal) modal.classList.remove('show');
    }
  });
})();

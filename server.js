const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ============================================================
// API PROXY - 解决浏览器CORS问题
// 将前端请求代理到迈德施云端API
// ============================================================
const API_BASE = 'https://mds.bodazl.com:8090';
const API_USER = 'mds26061103';
const API_PASS = '123456';
const API_DEVICE = 56857;
const API_SDID = 18806;        // 从设备ID
const API_GROUP_PID = 23891;   // 项目组ID
const API_DSIDS = '361240,361241,361242,361243,361244,361245,361246,361247';

let apiToken = null;
let tokenExpiry = 0;

function apiRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(API_BASE + urlPath);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      rejectUnauthorized: false // 自签名证书兼容
    };

    if (apiToken && Date.now() < tokenExpiry) {
      options.headers['X-Token'] = apiToken;
    }

    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function ensureToken() {
  if (apiToken && Date.now() < tokenExpiry) return apiToken;
  try {
    const result = await apiRequest('POST', '/api/v1/login/login', {
      username: API_USER,
      password: API_PASS
    });
    if (result.code === 0 && result.data?.token) {
      apiToken = result.data.token;
      tokenExpiry = Date.now() + 3600000; // 1小时过期
      return apiToken;
    }
  } catch (e) {
    console.error('Login failed:', e.message);
  }
  return null;
}

// 代理所有API请求
app.all('/api/v1/*', async (req, res) => {
  try {
    await ensureToken();
    const urlPath = '/api/v1' + req.url.replace('/api/v1', '');
    const result = await apiRequest(req.method, urlPath, req.body);
    res.json(result);
  } catch (e) {
    console.error('Proxy error:', e.message);
    res.status(502).json({ code: -1, msg: 'API proxy error: ' + e.message });
  }
});

// ============================================================
// 报警记录 API - 从历史数据生成报警记录
// ============================================================
app.get('/api/alarms', async (req, res) => {
  try {
    const token = await ensureToken();
    if (!token) {
      return res.json({ code: 0, data: [] });
    }

    // 尝试从API获取历史数据并生成报警记录
    // 使用 hisdps 获取最近7天数据
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fmt = d => d.toISOString().replace('T', ' ').substring(0, 19);
    const hisUrl = `/api/v1/device/hisdps?pid=${API_GROUP_PID}&did=${API_DEVICE}&sdid=${API_SDID}&dsids=${API_DSIDS}&start=${fmt(weekAgo)}&end=${fmt(now)}&order=desc`;
    const result = await apiRequest('GET', hisUrl);

    if (result.code === 0 && result.data?.dss) {
      // 将 hisdps 响应转换为记录数组
      const DSID_MAP = {361240:'d_1',361241:'d_2',361242:'d_3',361243:'d_4',361244:'d_5',361245:'d_6',361246:'d_7',361247:'d_8'};
      const tsMap = {};
      for (const ds of result.data.dss) {
        const dsName = DSID_MAP[ds.id] || ds.name;
        for (const dp of (ds.dps || [])) {
          if (!tsMap[dp.at]) tsMap[dp.at] = {};
          tsMap[dp.at][dsName] = dp.value;
        }
      }
      const records = Object.entries(tsMap).sort((a, b) => b[0] - a[0]).map(([at, vals]) => ({
        timestamp: new Date(parseInt(at) * 1000).toISOString().replace('T', ' ').substring(0, 19),
        level1: parseFloat(vals.d_1), level2: parseFloat(vals.d_2),
        level3: parseFloat(vals.d_3), level4: parseFloat(vals.d_4), level5: parseFloat(vals.d_5),
        temperature: parseFloat(vals.d_6), waterContent: parseFloat(vals.d_7), waterActivity: parseFloat(vals.d_8)
      }));

      const alarms = [];
      const thresholds = getAlarmThresholds();

      for (const record of records) {
        // 检查报警条件
        const alarmTypes = [];
        let maxLevel = 0;

        ['level1','level2','level3','level4','level5'].forEach(k => {
          const v = record[k];
          if (v >= thresholds.particle.critical) {
            alarmTypes.push({ type: 'particle', level: 2, channel: k, value: v });
            maxLevel = Math.max(maxLevel, 2);
          } else if (v >= thresholds.particle.warning) {
            alarmTypes.push({ type: 'particle', level: 1, channel: k, value: v });
            maxLevel = Math.max(maxLevel, 1);
          }
        });

        if (record.temperature >= thresholds.temperature.highCritical) {
          alarmTypes.push({ type: 'temperature', level: 2, value: record.temperature });
          maxLevel = Math.max(maxLevel, 2);
        } else if (record.temperature >= thresholds.temperature.highWarn) {
          alarmTypes.push({ type: 'temperature', level: 1, value: record.temperature });
          maxLevel = Math.max(maxLevel, 1);
        }

        if (record.waterContent >= thresholds.waterContent.critical) {
          alarmTypes.push({ type: 'water', level: 2, value: record.waterContent });
          maxLevel = Math.max(maxLevel, 2);
        } else if (record.waterContent >= thresholds.waterContent.warning) {
          alarmTypes.push({ type: 'water', level: 1, value: record.waterContent });
          maxLevel = Math.max(maxLevel, 1);
        }

        if (record.waterActivity >= thresholds.waterActivity.critical) {
          alarmTypes.push({ type: 'activity', level: 2, value: record.waterActivity });
          maxLevel = Math.max(maxLevel, 2);
        } else if (record.waterActivity >= thresholds.waterActivity.warning) {
          alarmTypes.push({ type: 'activity', level: 1, value: record.waterActivity });
          maxLevel = Math.max(maxLevel, 1);
        }

        if (alarmTypes.length > 0) {
          alarms.push({
            id: `ALM-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            timestamp: record.timestamp,
            level: maxLevel,
            types: alarmTypes,
            deviceId: API_DEVICE,
            deviceName: '油液清洁度检测仪',
            imei: '863304084381278'
          });
        }
      }

      return res.json({ code: 0, data: alarms });
    }

    res.json({ code: 0, data: [] });
  } catch (e) {
    res.json({ code: 0, data: [] });
  }
});

// ============================================================
// 设备状态 API
// ============================================================
app.get('/api/device-status', async (req, res) => {
  try {
    const token = await ensureToken();
    if (!token) {
      return res.json({
        code: -1,
        msg: '无法连接迈德施平台，设备状态未知',
        data: {
          total: 1,
          online: 0,
          offline: 0,
          alarm: 0,
          onlineRate: 0,
          offlineRate: 0,
          alarmRate: 0,
          devices: [{
            id: 56857,
            name: '油液清洁度检测仪',
            imei: '863304084381278',
            status: 'unknown',
            lastReport: null
          }]
        }
      });
    }

    const result = await apiRequest('GET', `/api/v1/device/lastdps?deviceId=56857`);
    if (result.code === 0 && result.data?.rows?.length) {
      res.json({
        code: 0,
        data: {
          total: 1,
          online: 1,
          offline: 0,
          alarm: 0,
          onlineRate: 100,
          offlineRate: 0,
          alarmRate: 0,
          devices: [{
            id: 56857,
            name: '油液清洁度检测仪',
            imei: '863304084381278',
            status: 'online',
            lastReport: new Date().toISOString().replace('T', ' ').substring(0, 19)
          }]
        }
      });
    } else {
      res.json({ code: -1, msg: 'No device data' });
    }
  } catch (e) {
    res.json({
      code: -1,
      msg: '获取设备状态异常',
      data: {
        total: 1, online: 0, offline: 0, alarm: 0,
        onlineRate: 0, offlineRate: 0, alarmRate: 0,
        devices: [{ id: 56857, name: '油液清洁度检测仪', imei: '863304084381278', status: 'unknown', lastReport: null }]
      }
    });
  }
});

// ============================================================
// 最新数据 API（实时 + 历史回退）
// ============================================================
app.get('/api/latest', async (req, res) => {
  try {
    const token = await ensureToken();
    if (!token) {
      return res.json({ code: -1, msg: '无法连接迈德施平台' });
    }

    // 尝试获取实时数据
    const result = await apiRequest('GET', `/api/v1/device/lastdps?deviceId=56857`);
    if (result.code === 0 && result.data?.rows?.length) {
      const row = result.data.rows[0];
      const m = {};
      (row.lastdp || []).forEach(dp => { m[dp.name] = dp; });

      // 检查是否有有效数据
      const hasData = [1,2,3,4,5,6,7,8].some(i => m[`d_${i}`]?.value != null);
      if (hasData) {
        return res.json({
          code: 0,
          data: {
            timestamp: m.d_1?.at || new Date().toISOString().replace('T', ' ').substring(0, 19),
            level1: m.d_1?.value, level2: m.d_2?.value, level3: m.d_3?.value,
            level4: m.d_4?.value, level5: m.d_5?.value,
            temperature: m.d_6?.value, waterContent: m.d_7?.value, waterActivity: m.d_8?.value,
            source: 'realtime'
          }
        });
      }
    }

    // 回退到历史数据
    console.log('[Latest] 实时数据为空，尝试从历史数据获取最新值');
    const DP_TO_DSID = {
      level1: '361240', level2: '361241', level3: '361242',
      level4: '361243', level5: '361244',
      temperature: '361245', waterContent: '361246', waterActivity: '361247',
    };

    const latestValues = {};
    let latestTs = null;
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
    const fmt = d => d.toISOString().replace('T', ' ').substring(0, 19).replace(' ', '%20');

    for (const [name, dsid] of Object.entries(DP_TO_DSID)) {
      try {
        const hisUrl = `/api/v1/device/hisdps?pid=23891&did=56857&sdid=18806&dsids=${dsid}&start=${fmt(dayAgo)}&end=${fmt(now)}&order=desc`;
        const hisResult = await apiRequest('GET', hisUrl);
        if (hisResult.code === 0 && hisResult.data?.dss?.length) {
          const dps = hisResult.data.dss[0].dps || [];
          if (dps.length > 0) {
            const dp = dps[0]; // 最新一条（order=desc）
            const ts = new Date(parseInt(dp.at) * 1000);
            const val = parseFloat(dp.value);
            latestValues[name] = val;
            if (!latestTs || ts > latestTs) latestTs = ts;
          }
        }
      } catch (e) {
        console.log(`[Latest] 获取 ${name} 历史数据失败:`, e.message);
      }
    }

    if (Object.keys(latestValues).length > 0 && latestTs) {
      return res.json({
        code: 0,
        data: {
          timestamp: latestTs.toISOString().replace('T', ' ').substring(0, 19),
          level1: latestValues.level1, level2: latestValues.level2, level3: latestValues.level3,
          level4: latestValues.level4, level5: latestValues.level5,
          temperature: latestValues.temperature, waterContent: latestValues.waterContent,
          waterActivity: latestValues.waterActivity,
          source: 'history'
        }
      });
    }

    res.json({ code: 0, data: null });
  } catch (e) {
    res.json({ code: -1, msg: '获取最新数据异常: ' + e.message });
  }
});

// ============================================================
// 历史数据 API - 从迈德施获取历史数据并聚合
// ============================================================
app.get('/api/history', async (req, res) => {
  try {
    const token = await ensureToken();
    if (!token) {
      return res.json({ code: -1, msg: '无法连接迈德施平台' });
    }

    const { start, end, dataPoint, algorithm, interval } = req.query;
    const startDate = start ? new Date(start) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const endDate = end ? new Date(end) : new Date();
    const dp = dataPoint || 'temperature';
    const algo = algorithm || 'raw';
    const intervalMin = parseInt(interval) || 5;

    const fmt = d => d.toISOString().replace('T', ' ').substring(0, 19);

    // 各数据点的合理值范围（用于过滤传感器通信错误产生的异常数据）
    const VALID_RANGES = {
      level1:        { min: 0, max: 100 },
      level2:        { min: 0, max: 100 },
      level3:        { min: 0, max: 100 },
      level4:        { min: 0, max: 100 },
      level5:        { min: 0, max: 100 },
      temperature:   { min: -40, max: 200 },
      waterContent:  { min: 0, max: 100 },
      waterActivity: { min: 0, max: 1 },
    };
    const range = VALID_RANGES[dp] || { min: -1e9, max: 1e9 };

    // 数据点名称→ds_id映射
    const DP_TO_DSID = {
      level1: '361240', level2: '361241', level3: '361242',
      level4: '361243', level5: '361244',
      temperature: '361245', waterContent: '361246', waterActivity: '361247'
    };
    const dsid = DP_TO_DSID[dp] || '361245';

    // 从MDS获取历史数据（支持cursor分页）
    const rawPoints = [];
    let cursor = 0;
    const pageSize = 1000; // MDS API实际每页最多返回1000条
    let hasMore = true;
    let filteredCount = 0;

    while (hasMore) {
      const hisUrl = `/api/v1/device/hisdps?pid=${API_GROUP_PID}&did=${API_DEVICE}&sdid=${API_SDID}&dsids=${dsid}&start=${fmt(startDate)}&end=${fmt(endDate)}&order=asc&cursor=${cursor}`;
      const result = await apiRequest('GET', hisUrl);

      if (result.code !== 0 || !result.data?.dss?.length) {
        break;
      }

      for (const ds of result.data.dss) {
        for (const dpItem of (ds.dps || [])) {
          const ts = new Date(parseInt(dpItem.at) * 1000);
          const val = parseFloat(dpItem.value);
          if (!isNaN(val) && val >= range.min && val <= range.max) {
            rawPoints.push({ ts, val });
          } else if (!isNaN(val)) {
            filteredCount++;
          }
        }
      }

      // 分页：API实际返回条数 < pageSize 时说明已到最后一页
      const actualCount = result.data.dss[0]?.dps?.length || 0;
      const nextCursor = result.data.cursor;
      if (nextCursor && nextCursor > 0 && actualCount > 0) {
        cursor = nextCursor;
      } else {
        hasMore = false;
      }

      // 安全限制：最多20页
      if (cursor > pageSize * 20) hasMore = false;
    }

    if (filteredCount > 0) {
      console.log(`[History] 已过滤 ${filteredCount} 条异常数据（超出合理范围 ${range.min}~${range.max}）`);
    }

    rawPoints.sort((a, b) => a.ts - b.ts);

    if (rawPoints.length === 0) {
      return res.json({ code: 0, data: { labels: [], values: [], stats: {} } });
    }

    // 按时间间隔聚合
    const intervalMs = intervalMin * 60 * 1000;
    const groups = {};
    rawPoints.forEach(p => {
      const bucket = Math.floor(p.ts.getTime() / intervalMs) * intervalMs;
      if (!groups[bucket]) groups[bucket] = [];
      groups[bucket].push(p.val);
    });

    const sortedBuckets = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const labels = [];
    const values = [];

    for (const bucket of sortedBuckets) {
      const vals = groups[bucket];
      let aggVal;
      const bucketDate = new Date(bucket);

      switch (algo) {
        case 'raw':
          // 原始数据：每个点单独显示
          for (const v of vals) {
            labels.push(fmt(bucketDate));
            values.push(v);
          }
          continue;
        case 'diff':
          // 差值：当前值 - 前一个聚合值
          aggVal = vals[vals.length - 1];
          break;
        case 'avg':
          aggVal = vals.reduce((s, v) => s + v, 0) / vals.length;
          break;
        case 'max':
          aggVal = Math.max(...vals);
          break;
        case 'min':
          aggVal = Math.min(...vals);
          break;
        case 'latest':
          aggVal = vals[vals.length - 1];
          break;
        case 'earliest':
          aggVal = vals[0];
          break;
        case 'sum':
          aggVal = vals.reduce((s, v) => s + v, 0);
          break;
        case 'count':
          aggVal = vals.length;
          break;
        default:
          aggVal = vals[vals.length - 1];
      }

      labels.push(fmt(bucketDate));
      values.push(Math.round(aggVal * 100) / 100);
    }

    // diff算法特殊处理：计算相邻聚合值的差
    if (algo === 'diff' && values.length > 1) {
      for (let i = values.length - 1; i > 0; i--) {
        values[i] = Math.round((values[i] - values[i - 1]) * 100) / 100;
      }
      values[0] = 0;
    }

    // 计算统计信息
    const allVals = values.filter(v => v != null);
    const stats = {
      count: allVals.length,
      avg: allVals.length ? parseFloat((allVals.reduce((s, v) => s + v, 0) / allVals.length).toFixed(2)) : 0,
      max: allVals.length ? parseFloat(Math.max(...allVals).toFixed(2)) : 0,
      min: allVals.length ? parseFloat(Math.min(...allVals).toFixed(2)) : 0,
    };

    res.json({ code: 0, data: { labels, values, stats, dataPoint: dp, algorithm: algo, interval: intervalMin } });
  } catch (e) {
    console.error('[History API] Error:', e.message);
    res.json({ code: -1, msg: '获取历史数据失败: ' + e.message });
  }
});

// ============================================================
// 企业微信 Webhook 推送
// ============================================================
const WEBHOOK_URL = process.env.WECOM_WEBHOOK || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=c7ba1fb2-236a-4e20-8a69-9b2e0d1447bd';
const POLL_INTERVAL = 60000; // 每60秒检测一次
const notifiedAlarms = new Set(); // 已推送过的报警ID

function sendWeChatNotification(content) {
  return new Promise((resolve, reject) => {
    const url = new URL(WEBHOOK_URL);
    const body = JSON.stringify({
      msgtype: 'markdown',
      markdown: { content }
    });

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.errcode === 0) {
            console.log('[WeChat Push] 推送成功');
            resolve(result);
          } else {
            console.error('[WeChat Push] 推送失败:', result);
            reject(new Error(result.errmsg || 'unknown error'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[WeChat Push] 请求错误:', e.message);
      reject(e);
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function buildAlarmMessage(alarm) {
  const levelText = alarm.level === 2 ? '<font color="warning">严重</font>' : '<font color="comment">警告</font>';
  const typeMap = {
    particle: '颗粒度超标',
    temperature: '温度过高',
    water: '水含量超标',
    activity: '水活性过高'
  };
  const unitMap = {
    particle: '个/mL',
    temperature: '℃',
    water: 'ppm',
    activity: 'aw'
  };

  let lines = [
    `### 油液监测报警通知`,
    `> **级别：** ${levelText}`,
    `> **时间：** ${alarm.timestamp}`,
    `> **设备：** ${alarm.deviceName || '油液清洁度检测仪'}`,
    `---`
  ];

  if (alarm.types && alarm.types.length > 0) {
    alarm.types.forEach(t => {
      const ch = t.channel ? ` (${t.channel})` : '';
      lines.push(`> **${typeMap[t.type] || t.type}**${ch}：${t.value} ${unitMap[t.type] || ''}`);
    });
  } else if (alarm.type) {
    const ch = alarm.channel ? ` (${alarm.channel})` : '';
    lines.push(`> **${typeMap[alarm.type] || alarm.typeName || alarm.type}**${ch}：${alarm.value} ${unitMap[alarm.type] || alarm.unit || ''}`);
  }

  lines.push(`---`, `> 请及时处理，登录系统查看详情`);
  return lines.join('\n');
}

// 启动定时轮询，检测新报警并推送
let lastPollTime = null;

async function pollAndNotify() {
  try {
    const token = await ensureToken();
    if (!token) {
      console.log('[Poll] API不可用，跳过轮询');
      return;
    }

    const result = await apiRequest('GET', `/api/v1/device/lastdps?deviceId=${API_DEVICE}`);
    if (result.code !== 0 || !result.data?.rows) return;

    const thresholds = getAlarmThresholds();

    for (const row of result.data.rows) {
      const m = {};
      (row.lastdp || []).forEach(dp => m[dp.name] = dp);

      const record = {
        timestamp: m.d_1?.at || row.createTime,
        level1: parseFloat(m.d_1?.value),
        level2: parseFloat(m.d_2?.value),
        level3: parseFloat(m.d_3?.value),
        level4: parseFloat(m.d_4?.value),
        level5: parseFloat(m.d_5?.value),
        temperature: parseFloat(m.d_6?.value),
        waterContent: parseFloat(m.d_7?.value),
        waterActivity: parseFloat(m.d_8?.value)
      };

      const alarmTypes = [];
      let maxLevel = 0;

      ['level1','level2','level3','level4','level5'].forEach(k => {
        const v = record[k];
        if (v >= thresholds.particle.critical) {
          alarmTypes.push({ type: 'particle', level: 2, channel: k, value: v });
          maxLevel = Math.max(maxLevel, 2);
        } else if (v >= thresholds.particle.warning) {
          alarmTypes.push({ type: 'particle', level: 1, channel: k, value: v });
          maxLevel = Math.max(maxLevel, 1);
        }
      });

      if (record.temperature >= thresholds.temperature.highCritical) {
        alarmTypes.push({ type: 'temperature', level: 2, value: record.temperature });
        maxLevel = Math.max(maxLevel, 2);
      } else if (record.temperature >= thresholds.temperature.highWarn) {
        alarmTypes.push({ type: 'temperature', level: 1, value: record.temperature });
        maxLevel = Math.max(maxLevel, 1);
      }

      if (record.waterContent >= thresholds.waterContent.critical) {
        alarmTypes.push({ type: 'water', level: 2, value: record.waterContent });
        maxLevel = Math.max(maxLevel, 2);
      } else if (record.waterContent >= thresholds.waterContent.warning) {
        alarmTypes.push({ type: 'water', level: 1, value: record.waterContent });
        maxLevel = Math.max(maxLevel, 1);
      }

      if (record.waterActivity >= thresholds.waterActivity.critical) {
        alarmTypes.push({ type: 'activity', level: 2, value: record.waterActivity });
        maxLevel = Math.max(maxLevel, 2);
      } else if (record.waterActivity >= thresholds.waterActivity.warning) {
        alarmTypes.push({ type: 'activity', level: 1, value: record.waterActivity });
        maxLevel = Math.max(maxLevel, 1);
      }

      if (alarmTypes.length > 0) {
        const alarmId = `${record.timestamp}-${maxLevel}`;
        if (!notifiedAlarms.has(alarmId)) {
          notifiedAlarms.add(alarmId);
          const alarm = {
            timestamp: record.timestamp,
            level: maxLevel,
            types: alarmTypes,
            deviceName: '油液清洁度检测仪'
          };
          const msg = buildAlarmMessage(alarm);
          await sendWeChatNotification(msg);
          console.log(`[Poll] 推送报警: ${record.timestamp}`);
        }
      }
    }

    lastPollTime = new Date().toISOString();
    console.log(`[Poll] 轮询完成 at ${lastPollTime}`);
  } catch (e) {
    console.error('[Poll] 轮询错误:', e.message);
  }
}

// 服务启动后延迟30秒开始首次轮询，之后每60秒一次
setTimeout(() => {
  pollAndNotify();
  setInterval(pollAndNotify, POLL_INTERVAL);
}, 30000);

// 测试推送接口
app.get('/api/notify/test', async (req, res) => {
  try {
    const testMsg = [
      '### 油液监测报警通知（测试）',
      '> **级别：** <font color="warning">严重</font>',
      '> **时间：** ' + new Date().toISOString().replace('T', ' ').substring(0, 19),
      '> **设备：** 油液清洁度检测仪',
      '---',
      '> **颗粒度超标** (L1(>4um))：28.5 个/mL',
      '> **温度过高**：67.3 ℃',
      '---',
      '> 请及时处理，登录系统查看详情'
    ].join('\n');

    await sendWeChatNotification(testMsg);
    res.json({ code: 0, msg: '测试推送成功' });
  } catch (e) {
    res.status(500).json({ code: -1, msg: '推送失败: ' + e.message });
  }
});

// ============================================================
// 预测分析 API - 宏观趋势预测 + 历史周期性对比
// ============================================================
const fs = require('fs');
const DISMISSED_FILE = path.join(__dirname, 'dismissed_alerts.json');
const THRESHOLDS_FILE = path.join(__dirname, 'thresholds_config.json');

// 默认阈值
const DEFAULT_PRED_THRESHOLDS = {
  level1: 25, level2: 25, level3: 25, level4: 25, level5: 25,
  temperature: 45, waterContent: 150, waterActivity: 0.7,
};
const DEFAULT_ALARM_THRESHOLDS = {
  particle: { warning: 18, critical: 25 },
  temperature: { highWarn: 55, highCritical: 65 },
  waterContent: { warning: 150, critical: 300 },
  waterActivity: { warning: 0.7, critical: 0.85 },
};

function loadThresholds() {
  try {
    if (fs.existsSync(THRESHOLDS_FILE)) {
      return JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));
    }
  } catch (e) { console.error('[Thresholds] 读取失败:', e.message); }
  return {};
}
function saveThresholds(cfg) {
  try { fs.writeFileSync(THRESHOLDS_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { console.error('[Thresholds] 保存失败:', e.message); }
}
function getPredThresholds() {
  const custom = loadThresholds();
  const result = { ...DEFAULT_PRED_THRESHOLDS };
  if (custom.prediction) {
    for (const [k, v] of Object.entries(custom.prediction)) {
      if (typeof v === 'number' && v > 0) result[k] = v;
    }
  }
  return result;
}
function getAlarmThresholds() {
  const custom = loadThresholds();
  const result = JSON.parse(JSON.stringify(DEFAULT_ALARM_THRESHOLDS));
  if (custom.alarm) {
    for (const [cat, vals] of Object.entries(custom.alarm)) {
      if (result[cat] && typeof vals === 'object') {
        for (const [k, v] of Object.entries(vals)) {
          if (typeof v === 'number' && v >= 0) result[cat][k] = v;
        }
      }
    }
  }
  return result;
}

// 数据平滑：移动中位数
function movingMedian(values, window = 3) {
  const n = values.length;
  if (n < window) return [...values];
  const result = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - half);
    const end = Math.min(n, i + half + 1);
    const w = values.slice(start, end).sort((a, b) => a - b);
    const mid = Math.floor(w.length / 2);
    result.push(w.length % 2 === 0 ? +((w[mid - 1] + w[mid]) / 2).toFixed(4) : +w[mid].toFixed(4));
  }
  return result;
}

// IQR异常值检测
function detectOutliersIQR(values) {
  if (values.length < 4) return values.map(() => true);
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const q1 = sorted[Math.floor(n / 4)];
  const q3 = sorted[Math.floor(3 * n / 4)];
  const iqr = q3 - q1;
  const lower = q1 - 2.0 * iqr;
  const upper = q3 + 2.0 * iqr;
  return values.map(v => v >= lower && v <= upper);
}

// 加权线性回归
function weightedLinearRegression(ys, decay = 0.95) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  const weights = Array.from({ length: n }, (_, i) => Math.pow(decay, n - 1 - i));
  const sumW = weights.reduce((s, w) => s + w, 0);
  const sumWx = weights.reduce((s, w, i) => s + w * i, 0);
  const sumWy = weights.reduce((s, w, i) => s + w * ys[i], 0);
  const sumWxy = weights.reduce((s, w, i) => s + w * i * ys[i], 0);
  const sumWxx = weights.reduce((s, w, i) => s + w * i * i, 0);
  const denom = sumW * sumWxx - sumWx * sumWx;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sumWy / sumW, r2: 0 };
  const slope = (sumW * sumWxy - sumWx * sumWy) / denom;
  const intercept = (sumWy - slope * sumWx) / sumW;
  const yMean = sumWy / sumW;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += weights[i] * (ys[i] - yMean) ** 2;
    ssRes += weights[i] * (ys[i] - (slope * i + intercept)) ** 2;
  }
  const r2 = ssTot > 1e-10 ? Math.max(0, 1 - ssRes / ssTot) : 0;
  return { slope, intercept, r2 };
}

function weightedPolyRegression(ys, degree = 2, decay = 0.95) {
  const n = ys.length;
  if (n < degree + 1) return { coeffs: [0, 0, 0], r2: 0, predictedNext: ys[n - 1] || 0, predictAt: () => ys[n - 1] || 0 };
  const weights = Array.from({ length: n }, (_, i) => Math.pow(decay, n - 1 - i));
  const xs = Array.from({ length: n }, (_, i) => i / Math.max(n - 1, 1));
  const dim = degree + 1;
  const XtWX = Array.from({ length: dim }, () => Array(dim).fill(0));
  const XtWy = Array(dim).fill(0);
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    const x = xs[i];
    const y = ys[i];
    const powers = Array.from({ length: dim }, (_, p) => Math.pow(x, p));
    for (let j = 0; j < dim; j++) {
      XtWy[j] += w * powers[j] * y;
      for (let k = 0; k < dim; k++) {
        XtWX[j][k] += w * powers[j] * powers[k];
      }
    }
  }
  const a = gaussSolve(XtWX, XtWy, dim);
  if (!a) return { coeffs: [0, 0, 0], r2: 0, predictedNext: ys[n - 1] || 0, predictAt: () => ys[n - 1] || 0 };
  const sumW = weights.reduce((s, w) => s + w, 0);
  const yMean = weights.reduce((s, w, i) => s + w * ys[i], 0) / sumW;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += weights[i] * (ys[i] - yMean) ** 2;
    const pred = a.reduce((s, c, p) => s + c * Math.pow(xs[i], p), 0);
    ssRes += weights[i] * (ys[i] - pred) ** 2;
  }
  const r2 = ssTot > 1e-10 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;
  const predictAt = (k) => {
    const x = 1.0 + k / Math.max(n - 1, 1);
    return a.reduce((s, c, p) => s + c * Math.pow(x, p), 0);
  };
  return { coeffs: a, r2, predictedNext: predictAt(1), predictAt };
}

function gaussSolve(A, b, n) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[maxRow][col])) maxRow = r;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) return null;
    const pivot = M[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / pivot;
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = (M[i][n] - M[i].slice(i + 1, n).reduce((s, v, j) => s + v * x[i + 1 + j], 0)) / M[i][i];
  }
  return x;
}

// 读取已消除的报警
function loadDismissed() {
  try {
    if (fs.existsSync(DISMISSED_FILE)) {
      return JSON.parse(fs.readFileSync(DISMISSED_FILE, 'utf8'));
    }
  } catch (e) { console.error('[Dismissed] 读取失败:', e.message); }
  return [];
}

// 保存已消除的报警
function saveDismissed(arr) {
  try {
    fs.writeFileSync(DISMISSED_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { console.error('[Dismissed] 保存失败:', e.message); }
}

// 线性回归: 返回 {slope, intercept, r2}
function linearRegression(ys) {
  const n = ys.length;
  if (n < 2) return { slope: 0, intercept: ys[0] || 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0, sumYY = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += ys[i]; sumXY += i * ys[i]; sumXX += i * i; sumYY += ys[i] * ys[i];
  }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // R² 计算
  const yMean = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (ys[i] - yMean) ** 2;
    ssRes += (ys[i] - (slope * i + intercept)) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2: Math.max(0, r2) };
}

// 从MDS获取单个数据源的全部历史数据（带分页）
async function fetchAllDataForDsId(dsid, startDate, endDate) {
  const fmt = d => d.toISOString().replace('T', ' ').substring(0, 19);
  const points = [];
  let cursor = 0;
  const pageSize = 1000;
  let hasMore = true;

  while (hasMore) {
    const hisUrl = `/api/v1/device/hisdps?pid=${API_GROUP_PID}&did=${API_DEVICE}&sdid=${API_SDID}&dsids=${dsid}&start=${fmt(startDate)}&end=${fmt(endDate)}&order=asc&cursor=${cursor}`;
    const result = await apiRequest('GET', hisUrl);
    if (result.code !== 0 || !result.data?.dss?.length) break;

    for (const ds of result.data.dss) {
      for (const dp of (ds.dps || [])) {
        const ts = parseInt(dp.at);
        const val = parseFloat(dp.value);
        if (!isNaN(val)) points.push({ ts, val });
      }
    }

    const actualCount = result.data.dss[0]?.dps?.length || 0;
    const nextCursor = result.data.cursor;
    if (nextCursor && nextCursor > 0 && actualCount > 0) {
      cursor = nextCursor;
    } else {
      hasMore = false;
    }
    if (cursor > pageSize * 30) hasMore = false; // 安全限制
  }
  return points;
}

// 主预测API - 增强版：数据平滑+加权回归+超标预测+自定义阈值
app.get('/api/prediction', async (req, res) => {
  try {
    const token = await ensureToken();
    if (!token) return res.json({ code: -1, msg: '无法连接迈德施平台' });

    const now = new Date();
    const startDate = new Date(now.getTime() - 90 * 24 * 3600 * 1000);

    // 使用自定义阈值
    const predThresh = getPredThresholds();

    const DP_CONFIG = {
      level1:        { dsid: '361240', threshold: predThresh.level1 || 25, unit: '个/100ml', label: '颗粒度L1(≥4μm)' },
      level2:        { dsid: '361241', threshold: predThresh.level2 || 25, unit: '个/100ml', label: '颗粒度L2(≥6μm)' },
      level3:        { dsid: '361242', threshold: predThresh.level3 || 25, unit: '个/100ml', label: '颗粒度L3(≥14μm)' },
      level4:        { dsid: '361243', threshold: predThresh.level4 || 25, unit: '个/100ml', label: '颗粒度L4(≥21μm)' },
      level5:        { dsid: '361244', threshold: predThresh.level5 || 25, unit: '个/100ml', label: '颗粒度L5(≥38μm)' },
      temperature:   { dsid: '361245', threshold: predThresh.temperature || 45, unit: '℃', label: '油温' },
      waterContent:  { dsid: '361246', threshold: predThresh.waterContent || 150, unit: 'ppm', label: '水含量' },
      waterActivity: { dsid: '361247', threshold: predThresh.waterActivity || 0.7, unit: 'aw', label: '水活性' },
    };

    const VALID_RANGES = {
      level1: {min:0,max:100}, level2: {min:0,max:100}, level3: {min:0,max:100},
      level4: {min:0,max:100}, level5: {min:0,max:100},
      temperature: {min:-40,max:200}, waterContent: {min:0,max:300}, waterActivity: {min:0,max:1},
    };

    // 6小时分桶聚合（每天4个桶，90天=360个桶）
    const binData = {};

    for (const [dpName, cfg] of Object.entries(DP_CONFIG)) {
      const rawPoints = await fetchAllDataForDsId(cfg.dsid, startDate, now);
      const range = VALID_RANGES[dpName];
      const cleanPoints = rawPoints.filter(p => p.val >= range.min && p.val <= range.max && p.val !== -1);

      for (const p of cleanPoints) {
        const d = new Date(p.ts * 1000);
        const hourBin = Math.floor(d.getHours() / 6) * 6;
        const binKey = d.toISOString().substring(0, 10) + `T${String(hourBin).padStart(2, '0')}`;
        if (!binData[binKey]) binData[binKey] = {};
        if (!binData[binKey][dpName]) binData[binKey][dpName] = [];
        binData[binKey][dpName].push(p.val);
      }
    }

    const sortedBins = Object.keys(binData).sort();

    const binStats = [];
    for (const binKey of sortedBins) {
      const bData = { bin: binKey };
      for (const dpName of Object.keys(DP_CONFIG)) {
        const vals = binData[binKey]?.[dpName] || [];
        if (vals.length > 0) {
          bData[dpName + '_avg'] = parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
          bData[dpName + '_max'] = parseFloat(Math.max(...vals).toFixed(2));
          bData[dpName + '_min'] = parseFloat(Math.min(...vals).toFixed(2));
          bData[dpName + '_count'] = vals.length;
        } else {
          bData[dpName + '_avg'] = 0;
          bData[dpName + '_max'] = 0;
          bData[dpName + '_min'] = 0;
          bData[dpName + '_count'] = 0;
        }
      }
      binStats.push(bData);
    }

    const predictions = {};
    const dismissed = loadDismissed();

    for (const [dpName, cfg] of Object.entries(DP_CONFIG)) {
      const binMax = binStats.map(d => d[dpName + '_max']);
      const binAvg = binStats.map(d => d[dpName + '_avg']);

      // 数据平滑：移动中位数（窗口5=1.25天，平滑日内波动）
      const smoothedMax = movingMedian(binMax, 5);

      // IQR异常值检测
      const outlierFlags = detectOutliersIQR(binMax);
      const outlierCount = outlierFlags.filter(f => !f).length;

      // 加权线性回归（平滑后数据）
      const reg = weightedLinearRegression(smoothedMax, 0.95);
      const regRaw = linearRegression(binMax);
      // 二次多项式回归（捕捉加速趋势）
      const polyReg = weightedPolyRegression(smoothedMax, 2, 0.95);

      const currentMax = binMax.length > 0 ? Math.max(...binMax) : 0;
      const currentAvg = binAvg.length > 0 ? parseFloat((binAvg.reduce((s, v) => s + v, 0) / binAvg.length).toFixed(2)) : 0;
      const smoothedCurrent = smoothedMax.length > 0 ? smoothedMax[smoothedMax.length - 1] : 0;
      const margin = cfg.threshold - smoothedCurrent;
      const riskPct = cfg.threshold > 0 ? parseFloat((smoothedCurrent / cfg.threshold * 100).toFixed(1)) : 0;

      // 数据质量检查：平滑值为0或大部分数据为0时跳过预测
      const nonZeroBins = binMax.filter(v => v > 0).length;
      const dataQualityOk = smoothedCurrent > 0 && nonZeroBins > binMax.length * 0.1;

      let riskLevel, riskColor;
      if (smoothedCurrent >= cfg.threshold) {
        riskLevel = '已超标'; riskColor = '#e74c3c';
      } else if (riskPct > 90) {
        riskLevel = '高风险'; riskColor = '#e74c3c';
      } else if (riskPct > 80) {
        riskLevel = '中风险'; riskColor = '#f39c12';
      } else if (riskPct > 60) {
        riskLevel = '低风险'; riskColor = '#f39c12';
      } else {
        riskLevel = '安全'; riskColor = '#27ae60';
      }

      // 预测超标日期（综合线性+多项式模型）
      let predDate = '趋势平稳/下降，暂无超标风险';
      let predDays = -1;
      let confidence = 0;
      let modelType = 'linear';

      // 只在数据质量合格时进行预测
      if (dataQualityOk) {
        // 选择拟合更好的模型
        if (polyReg.r2 > reg.r2 + 0.05 && polyReg.r2 > 0.1) {
          modelType = 'poly';
        }

        if (modelType === 'poly') {
          // 多项式模型：逐步预测未来值直到超标
          for (let k = 1; k < 365 * 4; k++) {
            const predicted = polyReg.predictAt(k);
            if (predicted >= cfg.threshold) {
              const remainingDays = Math.max(1, Math.floor(k / 4));
              const predDateObj = new Date(now.getTime() + remainingDays * 24 * 3600 * 1000);
              predDate = `约 ${remainingDays} 天 (${predDateObj.toISOString().substring(0, 10)})`;
              predDays = remainingDays;
              break;
            }
          }
          confidence = Math.min(95, Math.floor(polyReg.r2 * 100 * Math.min(1.0, smoothedMax.length / 56)));
        } else if (reg.slope > 0.01 && reg.r2 > 0.1) {
          // 线性模型
          const daysToThreshold = (cfg.threshold - reg.intercept) / reg.slope;
          const binsToThreshold = daysToThreshold * 4;
          const remainingDays = Math.max(1, Math.floor((binsToThreshold - smoothedMax.length) / 4) + 1);
          if (remainingDays > 0 && remainingDays < 365) {
            const predDateObj = new Date(now.getTime() + remainingDays * 24 * 3600 * 1000);
            predDate = `约 ${remainingDays} 天 (${predDateObj.toISOString().substring(0, 10)})`;
            predDays = remainingDays;
          } else if (remainingDays <= 0) {
            predDate = '已接近超标，预计7天内';
            predDays = Math.max(1, remainingDays);
          }
          confidence = Math.min(95, Math.floor(reg.r2 * 100 * Math.min(1.0, smoothedMax.length / 56)));
        }
      } else {
        predDate = '暂无超标风险';
      }

      // 周期性检测（使用桶数据，检测日内周期和周周期）
      let isPeriodic = false;
      let periodicNote = '';
      const nBins = smoothedMax.length;

      // 检测日内周期（4桶/天）
      if (nBins >= 28) {
        const dailyPatterns = [];
        for (let dayIdx = 0; dayIdx < Math.min(14, Math.floor(nBins / 4)); dayIdx++) {
          const start = nBins - (dayIdx + 1) * 4;
          const end = nBins - dayIdx * 4;
          if (start >= 0) {
            const pattern = smoothedMax.slice(start, end);
            if (pattern.length === 4) dailyPatterns.push(pattern);
          }
        }
        if (dailyPatterns.length >= 3) {
          const avgPattern = Array.from({ length: 4 }, (_, i) =>
            dailyPatterns.reduce((s, p) => s + p[i], 0) / dailyPatterns.length
          );
          const deviations = dailyPatterns.map(p =>
            p.reduce((s, v, i) => s + Math.abs(v - avgPattern[i]), 0)
          );
          const avgDev = deviations.reduce((s, d) => s + d, 0) / deviations.length;
          const avgVal = avgPattern.reduce((s, v) => s + v, 0) / 4;
          if (avgVal > 0 && avgDev / avgVal < 0.2) {
            isPeriodic = true;
            periodicNote = '日内波动规律明显（4时段周期稳定）';
          }
        }
      }

      // 检测周周期（28桶/周）
      if (!isPeriodic && nBins >= 56) {
        const week1 = smoothedMax.slice(-28);
        const week2 = smoothedMax.slice(-56, -28);
        const w1Avg = week1.reduce((s, v) => s + v, 0) / week1.length;
        const w2Avg = week2.reduce((s, v) => s + v, 0) / week2.length;
        if (w2Avg > 0 && Math.abs(w1Avg - w2Avg) / w2Avg < 0.15) {
          isPeriodic = true;
          periodicNote = '周期间均值稳定，波动为周期性规律';
        }
      }

      if (isPeriodic && riskLevel !== '已超标' && riskLevel !== '高风险') {
        riskLevel = '安全（周期性）';
        riskColor = '#27ae60';
      }

      const isDismissed = dismissed.some(d => d.metric === dpName);

      // 趋势方向判断（基于最近7天斜率）
      let trendDir = '平稳';
      const recent28 = smoothedMax.length >= 28 ? smoothedMax.slice(-28) : smoothedMax;
      if (recent28.length > 0) {
        const recentReg = linearRegression(recent28);
        if (recentReg.slope > 0.05) trendDir = '上升';
        else if (recentReg.slope < -0.05) trendDir = '下降';
      }

      predictions[dpName] = {
        threshold: cfg.threshold,
        unit: cfg.unit,
        label: cfg.label,
        current_max: currentMax,
        current_avg: currentAvg,
        smoothed_current: parseFloat(smoothedCurrent.toFixed(2)),
        margin: parseFloat(margin.toFixed(2)),
        risk_pct: riskPct,
        risk_level: riskLevel,
        risk_color: riskColor,
        slope: parseFloat(reg.slope.toFixed(4)),
        slope_raw: parseFloat(regRaw.slope.toFixed(4)),
        poly_r2: parseFloat(polyReg.r2.toFixed(4)),
        linear_r2: parseFloat(reg.r2.toFixed(4)),
        r2: parseFloat(Math.max(reg.r2, polyReg.r2).toFixed(4)),
        model_type: modelType,
        pred_date: predDate,
        pred_days: predDays,
        confidence: confidence,
        is_periodic: isPeriodic,
        periodic_note: periodicNote,
        is_dismissed: isDismissed,
        outlier_count: outlierCount,
        trend_dir: trendDir,
        daily_max: binMax,
        daily_avg: binAvg,
        daily_smoothed: smoothedMax,
        outlier_flags: outlierFlags,
        bins: sortedBins,
      };
    }

    const dateLabels = sortedBins.map(b => b.substring(0, 10));

    res.json({
      code: 0,
      data: {
        dates: dateLabels,
        bins: sortedBins,
        daily: binStats,
        predictions,
        generated_at: now.toISOString(),
        total_records: binStats.reduce((total, d) => {
          return total + Object.keys(DP_CONFIG).filter(dpName => d[dpName + '_max'] > 0).length;
        }, 0),
        total_bins: binStats.length,
        custom_thresholds: predThresh,
      }
    });
  } catch (e) {
    console.error('[Prediction] Error:', e.message);
    res.json({ code: -1, msg: '预测分析失败: ' + e.message });
  }
});

// 消除风险报警
app.post('/api/prediction/dismiss', (req, res) => {
  const { metric, reason } = req.body;
  if (!metric) return res.json({ code: -1, msg: '缺少指标名称' });

  const dismissed = loadDismissed();
  // 避免重复
  const exists = dismissed.findIndex(d => d.metric === metric);
  const entry = {
    metric,
    reason: reason || '',
    dismissed_at: new Date().toISOString(),
  };
  if (exists >= 0) {
    dismissed[exists] = entry;
  } else {
    dismissed.push(entry);
  }
  saveDismissed(dismissed);
  res.json({ code: 0, msg: '已消除', data: entry });
});

// 获取已消除的报警列表
app.get('/api/prediction/dismissed', (req, res) => {
  res.json({ code: 0, data: loadDismissed() });
});

// 恢复已消除的报警
app.post('/api/prediction/restore', (req, res) => {
  const { metric } = req.body;
  if (!metric) return res.json({ code: -1, msg: '缺少指标名称' });
  let dismissed = loadDismissed();
  dismissed = dismissed.filter(d => d.metric !== metric);
  saveDismissed(dismissed);
  res.json({ code: 0, msg: '已恢复' });
});

// ============================================================
// 阈值配置 API - 读取/保存自定义阈值
// ============================================================
app.get('/api/thresholds', (req, res) => {
  const custom = loadThresholds();
  res.json({
    code: 0,
    data: {
      prediction: getPredThresholds(),
      alarm: getAlarmThresholds(),
      custom: custom,
      defaults: {
        prediction: DEFAULT_PRED_THRESHOLDS,
        alarm: DEFAULT_ALARM_THRESHOLDS,
      },
    }
  });
});

app.post('/api/thresholds', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.json({ code: -1, msg: '无效请求' });
  }

  // 重置所有自定义阈值
  if (body.reset === true) {
    saveThresholds({});
    return res.json({ code: 0, msg: '已重置为默认阈值' });
  }

  const custom = loadThresholds();

  // 更新预测阈值
  if (body.prediction && typeof body.prediction === 'object') {
    if (!custom.prediction) custom.prediction = {};
    for (const [k, v] of Object.entries(body.prediction)) {
      if (typeof v === 'number' && v > 0) {
        custom.prediction[k] = v;
      } else if (v === null || v === '') {
        delete custom.prediction[k]; // 删除自定义，回退到默认值
      }
    }
  }

  // 更新报警阈值
  if (body.alarm && typeof body.alarm === 'object') {
    if (!custom.alarm) custom.alarm = {};
    for (const [cat, vals] of Object.entries(body.alarm)) {
      if (typeof vals === 'object' && vals !== null) {
        if (!custom.alarm[cat]) custom.alarm[cat] = {};
        for (const [k, v] of Object.entries(vals)) {
          if (typeof v === 'number' && v >= 0) {
            custom.alarm[cat][k] = v;
          } else if (v === null || v === '') {
            delete custom.alarm[cat][k];
          }
        }
      }
    }
  }

  saveThresholds(custom);
  res.json({
    code: 0,
    msg: '阈值已保存',
    data: {
      prediction: getPredThresholds(),
      alarm: getAlarmThresholds(),
    }
  });
});

// ============================================================
// SPA 路由 - 所有路径返回 dashboard.html
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ============================================================
// START
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  油液智能监测平台已启动`);
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  局域网访问: http://0.0.0.0:${PORT}`);
  console.log(`  API代理: http://localhost:${PORT}/api/v1/...\n`);
});

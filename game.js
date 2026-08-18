// AI 生存游戏 —— 前端核心逻辑
// 状态机 + 规则结算 + AI 调用 + 存档导入导出
// 双模式：
//   A. 本地模式（localhost/127.0.0.1）：走本地服务 /api/chat 代理，Key 在 config.json
//   B. 公网模式（GitHub Pages 等静态托管）：玩家在浏览器填自己的 Key（存 localStorage），直连所选服务商

const IS_LOCAL = typeof location !== 'undefined' && /^(127\.0\.0\.1|localhost|\[::1\])/.test(location.hostname);

// ---------- 服务商配置（切换便宜/免费模型） ----------
// key：内部标识；label：界面显示；model：默认模型；baseURL：OpenAI 兼容接口（公网直连用）
const PROVIDERS = {
  deepseek: { label: 'DeepSeek', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/chat/completions' },
  glm:      { label: '智谱 GLM（免费）', model: 'glm-4-flash', baseURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  qwen:     { label: '通义千问（便宜）', model: 'qwen-turbo', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions' },
  custom:   { label: '自定义', model: '', baseURL: '' },
};
const STORE_KEYS = {
  provider: 'survival_provider',              // 当前选中的服务商
  keyPrefix: 'survival_key_',                 // 各服务商 Key 存储前缀（survival_key_deepseek 等）
  customUrl: 'survival_custom_url',
  customModel: 'survival_custom_model',
  theme: 'survival_theme',                    // 界面主题：dark / neon
  wallpaper: 'survival_wallpaper',            // 壁纸 base64
  wallBlur: 'survival_wall_blur',             // 壁纸模糊度
  wallDim: 'survival_wall_dim',               // 壁纸明暗（暗化遮罩）
  plugins: 'survival_plugins',                // 已导入插件列表（JSON 字符串）
};

// ---------- 自定义规则插件 ----------
// 插件格式：{ id, name, version, stats:[{key,icon,label,max,default}], stylePrompt, extraRules }
const MAX_PLUGIN_STATS = 8;   // 插件可自定义状态项上限

function loadPlugins() {
  try {
    const raw = localStorage.getItem(STORE_KEYS.plugins);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function savePlugins(list) {
  try { localStorage.setItem(STORE_KEYS.plugins, JSON.stringify(list)); } catch (e) {}
}

// 校验并规范化插件对象
function normalizePlugin(p) {
  if (!p || typeof p !== 'object') return null;
  const id = String(p.id || '').trim();
  if (!id) return null;
  // 基础状态保留字：插件不得占用
  const RESERVED = ['hp', 'food', 'water', 'temp', 'stamina', 'bored'];
  const stats = Array.isArray(p.stats) ? p.stats.slice(0, MAX_PLUGIN_STATS).map((s) => {
    const key = String(s.key || '').trim();
    const max = (typeof s.max === 'number' && s.max > 0) ? s.max : 100;
    const def = (typeof s.default === 'number') ? s.default : 50;
    return {
      key,
      icon: String(s.icon || '⭐'),
      label: String(s.label || key || '状态'),
      max,
      default: Math.max(0, Math.min(max, def)),   // 钳制到 [0, max]
    };
  }).filter((s) => s.key && RESERVED.indexOf(s.key) < 0) : [];
  return {
    id,
    name: String(p.name || id),
    version: String(p.version || '1.0'),
    stats,
    stylePrompt: String(p.stylePrompt || ''),
    extraRules: String(p.extraRules || ''),
  };
}

// 当前生效的插件（全部启用）
function activePlugins() {
  return loadPlugins().map(normalizePlugin).filter(Boolean);
}

// 插件注入系统提示词：风格 + 追加规则
function buildPluginPrompt() {
  const ps = activePlugins();
  if (!ps.length) return '';
  const parts = [];
  for (const p of ps) {
    const bits = [];
    if (p.stylePrompt) bits.push('对话风格：' + p.stylePrompt);
    if (p.extraRules) bits.push('追加规则：' + p.extraRules);
    if (p.stats.length) {
      bits.push('自定义状态项（与基础状态同等结算，增减量由你返回）：' +
        p.stats.map((s) => s.icon + s.key + '(0-' + s.max + ')').join('、'));
    }
    parts.push('【插件 ' + p.name + '】' + bits.join('；'));
  }
  return '\n---\n已加载插件规则（必须遵守）：\n' + parts.join('\n');
}

// ---------- 自定义壁纸 ----------
function getWallpaper() { try { return localStorage.getItem(STORE_KEYS.wallpaper) || ''; } catch (e) { return ''; } }
function setWallpaper(b64) {
  try {
    if (b64) localStorage.setItem(STORE_KEYS.wallpaper, b64);
    else localStorage.removeItem(STORE_KEYS.wallpaper);
  } catch (e) {}
}
function getWallBlur() { try { return parseInt(localStorage.getItem(STORE_KEYS.wallBlur) || '0', 10); } catch (e) { return 0; } }
function setWallBlur(v) { try { localStorage.setItem(STORE_KEYS.wallBlur, String(v)); } catch (e) {} }
function getWallDim() { try { return parseInt(localStorage.getItem(STORE_KEYS.wallDim) || '0', 10); } catch (e) { return 0; } }
function setWallDim(v) { try { localStorage.setItem(STORE_KEYS.wallDim, String(v)); } catch (e) {} }

// 应用壁纸与调节到背景层
function applyWallpaper() {
  const el = document.getElementById('wallpaper');
  if (!el) return;
  const b64 = getWallpaper();
  if (b64) {
    el.style.backgroundImage = "url('" + b64 + "')";
    el.classList.add('active');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('active');
  }
  el.style.filter = 'blur(' + getWallBlur() + 'px)';
  // 明暗：0=全透，80=几乎遮黑（让文字更清晰）
  el.style.opacity = String(Math.max(0, 1 - getWallDim() / 100));
}

// 上传图片：压缩到约 200KB 内（canvas），防 localStorage 超限
function uploadWallpaper(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 限制最长边 1280，压缩质量 0.6
        let { width, height } = img;
        const MAX = 1280;
        if (width > MAX || height > MAX) {
          const ratio = Math.min(MAX / width, MAX / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const out = canvas.toDataURL('image/jpeg', 0.6);
        resolve(out);
      };
      img.onerror = () => reject(new Error('图片读取失败'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

// ---------- 主题 ----------
const VALID_THEMES = ['dark', 'neon'];
function getTheme() {
  try {
    const t = localStorage.getItem(STORE_KEYS.theme);
    return VALID_THEMES.indexOf(t) >= 0 ? t : 'dark';
  } catch (e) { return 'dark'; }
}
function setTheme(t) {
  const safe = VALID_THEMES.indexOf(t) >= 0 ? t : 'dark';
  try { localStorage.setItem(STORE_KEYS.theme, safe); } catch (e) {}
  document.body.setAttribute('data-theme', safe);
}
function applyTheme() {
  setTheme(getTheme());
}

function getProvider() {
  const p = (() => { try { return localStorage.getItem(STORE_KEYS.provider); } catch (e) { return null; } })();
  return PROVIDERS[p] ? p : 'deepseek';
}
function setProvider(p) { try { localStorage.setItem(STORE_KEYS.provider, p); } catch (e) {} }

function getKey(id) {
  try { return localStorage.getItem(STORE_KEYS.keyPrefix + id) || ''; } catch (e) { return ''; }
}
function setKey(id, k) {
  try {
    if (k) localStorage.setItem(STORE_KEYS.keyPrefix + id, k);
    else localStorage.removeItem(STORE_KEYS.keyPrefix + id);
  } catch (e) {}
}
function getCustomUrl() { try { return localStorage.getItem(STORE_KEYS.customUrl) || ''; } catch (e) { return ''; } }
function getCustomModel() { try { return localStorage.getItem(STORE_KEYS.customModel) || ''; } catch (e) { return ''; } }

// 返回当前生效的 {id, label, model, baseURL}
function currentProvider() {
  const id = getProvider();
  return Object.assign({ id }, PROVIDERS[id]);
}

// 运行模式：'local'（有本地服务代理）或 'remote'（静态托管直连）
// 启动时探测一次：即使通过局域网 IP 访问本地服务也能正确识别
let MODE = null;
async function detectMode() {
  if (MODE) return MODE;
  if (IS_LOCAL) {
    MODE = 'local';
    return MODE;
  }
  // 非 localhost：尝试探测 /api/config，能响应说明背后有本地服务（如局域网 IP 访问）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch('/api/config', { signal: ctrl.signal });
      if (res.ok) {
        MODE = 'local';
        return MODE;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) { /* 无本地服务 */ }
  MODE = 'remote';
  return MODE;
}
function isLocalMode() { return MODE === 'local'; }

// ---------- 默认开局（对应规则示例：废弃卧室） ----------
function newGameState() {
  return {
    version: 2,
    day: 0,
    stats: { hp: 40, food: 50, water: 60, temp: '温', stamina: 45, bored: 0 },
    focus: false,        // 专注模式
    location: '废弃卧室',
    inventory: [],       // 物品栏
    death: false,
    logs: [],            // 完整对话历史 [{role, content}]
    history: [],         // 渲染用消息 [{role, text}]
    memory: {            // 游戏档案：自动分类的长期记忆（AI 写入，前端存档）
      player: [],        // 玩家状态：伤病、技能、持久效果（如"左手划伤"）
      world: [],         // 世界状态：NPC、地点、群落、局势（如"镇上有幸存者老王"）
      events: [],        // 重要事件时间线（如"第3天：发现铜矿脉"）
      knowledge: [],     // 已学知识/配方/科技（如"学会用石斧劈柴"）
    },
    map: [               // 文字版小地图（字符画网格）
      '████████████████████',
      '██················██',
      '██···▓▓▓··········██',
      '██···▓▓▓·····@····██',
      '██················██',
      '██·····░░·······M·██',
      '████████████████████',
    ],
    mapLegend: '█ 墙壁  · 地面  ▓ 家具/障碍  ░ 水/危险  @ 你  M 出口',
    pluginStats: {},     // 插件自定义状态数值 { key: value }
  };
}

// 插件状态默认值初始化（导入插件或新游戏时补齐）
function ensurePluginStats(state) {
  const ps = activePlugins();
  const target = state.pluginStats || (state.pluginStats = {});
  for (const p of ps) {
    for (const s of p.stats) {
      if (typeof target[s.key] !== 'number') target[s.key] = s.default;
    }
  }
  return target;
}

// ---------- 规则结算（前端强制生效） ----------
function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }

function getDisasterType(day) {
  if (day > 0 && day % 30 === 0) return '血月';
  if (day > 0 && day % 10 === 0) return '无月';
  return '正常';
}

function applyStats(s, deltas) {
  if (!deltas) return;
  const d = deltas;
  if (typeof d.hp === 'number') s.stats.hp = clamp(s.stats.hp + d.hp);
  if (typeof d.food === 'number') s.stats.food = clamp(s.stats.food + d.food);
  if (typeof d.water === 'number') s.stats.water = clamp(s.stats.water + d.water);
  if (d.temp === '热' || d.temp === '温' || d.temp === '冷') s.stats.temp = d.temp;
  if (typeof d.stamina === 'number') s.stats.stamina = clamp(s.stats.stamina + d.stamina);
  if (typeof d.bored === 'number') s.stats.bored = clamp(s.stats.bored + d.bored);
  // 插件自定义状态：按各插件声明的 max 钳制
  const ps = activePlugins();
  if (ps.length) {
    const target = s.pluginStats || (s.pluginStats = {});
    const keyMax = {};
    for (const p of ps) for (const st of p.stats) keyMax[st.key] = st.max;
    for (const key of Object.keys(keyMax)) {
      if (typeof d[key] === 'number') {
        const base = typeof target[key] === 'number' ? target[key] : 0;
        const max = keyMax[key];
        target[key] = Math.max(0, Math.min(max, Math.round(base + d[key])));
      }
    }
  }
  // 饱食/水分归零扣血
  if (s.stats.food <= 0) s.stats.hp = clamp(s.stats.hp - 2);
  if (s.stats.water <= 0) s.stats.hp = clamp(s.stats.hp - 2);
}

// ---------- 系统提示词 ----------
let rulesText = '';
const SYSTEM_TAIL = `
---
【输出协议（最高优先级，必须严格遵守）】
你是本游戏的 AI 主控。基于上述规则与玩家指令推演世界。
你的整条回复必须且只能是【一个合法的 JSON 对象】。禁止输出任何其他文字、解释、注释、markdown 代码块、围栏（如 \`\`\`）或开场白。回复的第一个字符必须是 {，最后一个字符必须是 }。

JSON 格式如下：
{
  "narrator": "环境/动作结果描写（默认≤35字；耗时>1小时需注明用时；[探索]时输出详细环境描写）",
  "event": "特殊事件文本（无则省略）",
  "day_delta": 0,
  "stats": { "hp": 0, "food": -3, "water": -4, "temp": "温", "stamina": 20, "bored": 0 },
  "focus": null,
  "location": "当前位置（未变则省略）",
  "inventory_add": [],
  "inventory_remove": [],
  "memory_add": { "player": [], "world": [], "events": [], "knowledge": [] },
  "memory_remove": [],
  "map": ["字符画小地图行1", "行2", "..."],
  "map_legend": "图例说明（可选）",
  "death": false
}

JSON 合法性与格式要求（违反会导致游戏崩溃）：
- stats 中的 hp/food/water/stamina/bored 是数字增减量：正值直接写数字（如 20），禁止加 + 号（"+20" 是非法 JSON！），负值写 -3。
- temp 只能是 热/温/冷 之一（字符串）。
- 所有键必须用双引号；不能有尾逗号；不能有注释；不能用单引号。
- 只列出发生变化或需要确认的字段，不要列出全部。
- map：当玩家移动、探索新区域、场景明显变化时，输出【小地图】（数组，每行一个字符串）。规则：
  · 必须保持与当前地图相同的行数与字符宽度（每行等宽，可用半角空格补位）
  · 用 @ 标记玩家当前位置；█ 墙壁；· 地面；▓ 家具/障碍物；░ 水域/危险；M 出口/门；▲ 楼梯/洞；T 树/植被；其他大写字母可表示重要 NPC 或地标
  · 未变化时省略该字段
- map_legend：若自定义了符号，补充图例说明（可选）。
- memory_add：把【值得长期记住】的状态/事件写入对应分类（每项一句话、≤25字）：
  · player：玩家持久状态（伤病、技能、身体变化），如"左手划伤未愈"
  · world：世界局势/NPC/地点，如"小镇东南有废弃矿洞"
  · events：重要里程碑事件，如"第3天：发现铜矿脉"
  · knowledge：解锁的知识/配方/科技，如"学会用木炭过滤水"
  只写新的或显著变化的条目；不要重复已存在于【游戏档案】中的内容。
- memory_remove：若档案中某条目已失效（如伤愈、事件过去），给出该条目的完整原文文本。
- focus: 玩家申请[专注]时，满足条件(动作明确、材料工具齐全、目标可达、非危险、体力≥20)则为 true，否则 false。
- death: 仅当 hp 归零时 true。
- 界面布局、状态栏由前端固定渲染，你不得描述界面本身。
- 规则冲突时选择最具生存挑战的情况。
- 未提及事项遵循现实规则。
`;

async function loadRules() {
  try {
    const res = await fetch('rules.txt');
    rulesText = await res.text();
    return true;
  } catch (e) {
    rulesText = '';
    return false;
  }
}

function buildSystemPrompt() {
  return (rulesText || '（规则文件缺失）') + SYSTEM_TAIL + buildPluginPrompt();
}

// ---------- 游戏档案：把分类记忆格式化为文本 ----------
function buildMemoryText(state) {
  const m = state.memory || {};
  const labels = { player: '【玩家状态】', world: '【世界局势】', events: '【重要事件】', knowledge: '【已学知识】' };
  const parts = [];
  for (const key of ['player', 'world', 'events', 'knowledge']) {
    const items = Array.isArray(m[key]) ? m[key] : [];
    if (items.length) parts.push(labels[key] + items.join('；'));
  }
  return parts.length ? parts.join('\n') : '（档案为空）';
}

// ---------- AI 调用 ----------
async function callAI(state, userText, extraLogs) {
  // 把完整状态附加到玩家指令中，让 AI 始终知晓现状
  const stateSnapshot = JSON.stringify({
    day: state.day,
    disaster: getDisasterType(state.day),
    focus: state.focus,
    location: state.location,
    inventory: state.inventory,
    stats: state.stats,
  });
  const memoryText = buildMemoryText(state);

  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    // 长期记忆由游戏档案承担，历史只保留近 8 条（省 token）
    ...state.logs.slice(-8).map((m) => ({ role: m.role, content: m.content })),
    ...(extraLogs || []),
    {
      role: 'user',
      content: userText + '\n【当前状态】' + stateSnapshot + '\n【游戏档案】\n' + memoryText,
    },
  ];

  const prov = currentProvider();
  const model = prov.id === 'custom' ? (getCustomModel().trim() || 'unknown-model') : prov.model;
  const payload = { model, messages, temperature: 0.8, max_tokens: 1500 };
  let res;

  if (isLocalMode()) {
    // 本地模式：走本地服务代理。把所选服务商一并告诉代理（代理读取 config.json 的对应 Key）
    const body = { provider: prov.id, payload };
    if (prov.id === 'custom') {
      const url = getCustomUrl().trim();
      if (!url) {
        throw new Error('「自定义」服务商还未填写接口地址，请先在设置里填写');
      }
      body.payload.customUrl = url;
    }
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } else {
    // 公网模式：直连所选服务商，玩家自己的 Key（存 localStorage）
    const baseURL = prov.id === 'custom' ? getCustomUrl().trim() : prov.baseURL;
    if (!baseURL) {
      throw new Error('「自定义」服务商还未填写接口地址，请先在设置里填写');
    }
    const key = getKey(prov.id).trim();
    if (!key) {
      throw new Error('请先点击右上角「设置」，填入所选服务商（' + prov.label + '）的 API Key');
    }
    res = await fetch(baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
      },
      body: JSON.stringify(payload),
    });
  }

  // 容错解析响应体：公网模式可能收到非 JSON 错误页（网关 HTML 等），不能直接 res.json()
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }
  if (!res.ok) {
    // DeepSeek 错误可能形如 { error: { message: "..." } } 或 { error: "文本" }，统一提取可读信息
    let msg;
    const err = data && data.error;
    if (typeof err === 'string') msg = err;
    else if (err && typeof err.message === 'string') msg = err.message;
    else if (err && typeof err === 'object') msg = JSON.stringify(err);
    else msg = '请求失败 HTTP ' + res.status;
    throw new Error(msg);
  }
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return content;
}

// ---------- 解析 AI 输出 ----------
function parseAIOutput(text) {
  if (!text) return null;
  let jsonStr = String(text).trim();
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) jsonStr = fence[1].trim();
  const braceStart = jsonStr.indexOf('{');
  const braceEnd = jsonStr.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    jsonStr = jsonStr.slice(braceStart, braceEnd + 1);
  }

  // 第一级：直接解析
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) { /* 进入容错修复 */ }

  // 第二级：逐步容错修复 AI 的常见非法 JSON
  let fixed = jsonStr;
  // JSON 规范不允许数字前带 + 号（AI 常输出 "stamina": +20 或数组 [ +5, ... ]）
  fixed = fixed.replace(/([:,\[])\s*\+(\d+(?:\.\d+)?)/g, '$1 $2');
  try {
    const parsed = JSON.parse(fixed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) { /* 继续 */ }

  // 去掉尾逗号（如 "a":1,} 或 {,）
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(fixed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) { /* 继续 */ }

  // AI 可能给键加单引号
  fixed = fixed.replace(/'/g, '"');
  try {
    const parsed = JSON.parse(fixed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return null;
  }
}

// ---------- 应用 AI 结果到状态 ----------
function applyAIResult(state, parsed) {
  const out = {
    narrator: '',
    event: '',
    focus: null,
    death: false,
  };
  if (!parsed) return out;

  if (typeof parsed.day_delta === 'number') state.day = Math.max(0, state.day + Math.floor(parsed.day_delta));
  applyStats(state, parsed.stats);

  if (parsed.focus === true) state.focus = true;
  else if (parsed.focus === false) state.focus = false;

  if (typeof parsed.location === 'string' && parsed.location) state.location = parsed.location;

  if (Array.isArray(parsed.inventory_add)) {
    for (const it of parsed.inventory_add) {
      if (typeof it === 'string' && it) state.inventory.push(it);
    }
  }
  if (Array.isArray(parsed.inventory_remove)) {
    for (const it of parsed.inventory_remove) {
      const idx = state.inventory.indexOf(it);
      if (idx >= 0) state.inventory.splice(idx, 1);
    }
  }

  // 游戏档案：分类记忆写入/删除
  const mem = state.memory || (state.memory = { player: [], world: [], events: [], knowledge: [] });
  const add = parsed.memory_add;
  if (add && typeof add === 'object') {
    for (const cat of ['player', 'world', 'events', 'knowledge']) {
      const items = add[cat];
      if (Array.isArray(items)) {
        for (const raw of items) {
          const it = typeof raw === 'string' ? raw.trim() : '';
          if (it && Array.isArray(mem[cat]) && mem[cat].indexOf(it) < 0) {
            mem[cat].push(it);
          }
        }
      }
    }
  }
  if (Array.isArray(parsed.memory_remove)) {
    for (const raw of parsed.memory_remove) {
      const it = typeof raw === 'string' ? raw.trim() : '';
      for (const cat of Object.keys(mem)) {
        if (Array.isArray(mem[cat])) {
          const idx = mem[cat].indexOf(it);
          if (idx >= 0) mem[cat].splice(idx, 1);
        }
      }
    }
  }

  // 小地图更新：AI 返回新地图时替换（需为字符串数组）
  if (Array.isArray(parsed.map) && parsed.map.length) {
    let rows = parsed.map.map((r) => (typeof r === 'string' ? r : ''));
    // 过滤末尾空行，保留有效内容
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    // 等宽归一化：按最长行补空格对齐，避免参差错位
    if (rows.length && rows.some((r) => r.length > 0)) {
      const width = Math.max(...rows.map((r) => r.length));
      state.map = rows.map((r) => r + ' '.repeat(width - r.length));
    }
  }
  if (typeof parsed.map_legend === 'string' && parsed.map_legend.trim()) {
    state.mapLegend = parsed.map_legend.trim();
  }

  if (parsed.death === true) state.death = true;

  out.narrator = typeof parsed.narrator === 'string' ? parsed.narrator : '';
  out.event = typeof parsed.event === 'string' ? parsed.event : '';
  return out;
}

// ---------- 死亡结算 ----------
function handleDeath(state) {
  // 床上复活，属性减至1/4，物品全掉落
  const st = state.stats;
  st.hp = clamp(st.hp * 0.25);
  st.food = clamp(st.food * 0.25);
  st.water = clamp(st.water * 0.25);
  st.stamina = clamp(st.stamina * 0.25);
  st.bored = clamp(st.bored * 0.25);
  const dropped = state.inventory;
  state.inventory = [];
  state.death = false;
  return dropped;
}

// ---------- 状态持久化 ----------
const AUTOSAVE_KEY = 'survival_game_autosave';

function autosave(state) {
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state)); } catch (e) {}
}

function exportSave(state) {
  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fname = 'survival_save_' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate())
    + '_' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + '.json';
  const json = JSON.stringify({ format: 'survival-save', savedAt: stamp.toISOString(), state }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.rel = 'noopener';
  document.body.appendChild(a);   // 部分移动端浏览器需要元素在 DOM 中才触发下载
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }, 100);
  return fname; // 返回文件名供提示
}

function parseSaveFile(text) {
  const data = JSON.parse(text);
  const state = data.state || data;
  if (!state || typeof state !== 'object' || !state.stats) throw new Error('存档格式无效');
  // 补全缺失字段
  const base = newGameState();
  return {
    version: 2,
    day: typeof state.day === 'number' ? state.day : 0,
    stats: Object.assign({}, base.stats, state.stats || {}),
    focus: !!state.focus,
    location: state.location || '未知地点',
    inventory: Array.isArray(state.inventory) ? state.inventory : [],
    death: !!state.death,
    logs: Array.isArray(state.logs) ? state.logs : [],
    history: Array.isArray(state.history) ? state.history : [],
    // 游戏档案：兼容旧存档（无 memory 时给空档案）
    memory: Object.assign({ player: [], world: [], events: [], knowledge: [] }, state.memory || {}),
    // 小地图：兼容旧存档（无 map 时用默认地图）
    map: Array.isArray(state.map) && state.map.length ? state.map : newGameState().map,
    mapLegend: typeof state.mapLegend === 'string' && state.mapLegend ? state.mapLegend : newGameState().mapLegend,
    // 插件状态：兼容旧存档
    pluginStats: (state.pluginStats && typeof state.pluginStats === 'object') ? state.pluginStats : {},
  };
}

// ---------- 界面渲染 ----------
const $ = (id) => document.getElementById(id);

// 记录各状态项旧值，用于数值变化闪烁提示
let _prevStats = {};

function renderStats(state) {
  const s = state.stats;
  const defs = [
    { key: 'hp', label: '❤️生命', color: '#e74c3c' },
    { key: 'food', label: '🍲饱食', color: '#f39c12' },
    { key: 'water', label: '💧水分', color: '#3498db' },
    { key: 'temp', label: '🌡️温度', color: '#e67e22', text: s.temp },
    { key: 'stamina', label: '🏋️体力', color: '#9b59b6' },
    { key: 'bored', label: '🍽️厌倦', color: '#95a5a6' },
  ];
  // 插件自定义状态项
  ensurePluginStats(state);
  const ps = activePlugins();
  const pluginDefs = [];
  if (ps.length) {
    for (const p of ps) {
      for (const st of p.stats) {
        pluginDefs.push({ key: st.key, label: st.icon + st.label, color: '#2ecc71', max: st.max, plugin: true });
      }
    }
  }
  const all = defs.concat(pluginDefs);
  const flashes = {};
  all.forEach((d) => {
    const key = d.key;
    const cur = d.plugin ? state.pluginStats[key] : (key === 'temp' ? s.temp : s[key]);
    const prev = _prevStats[key];
    if (prev !== undefined && String(prev) !== String(cur)) flashes[key] = true;
    _prevStats[key] = cur;
  });
  // 动态列数：基础 6 项 → 每多 2 项增一列（最多 4 列）。
  // 仅列数 >6 时设内联（否则交给 CSS：桌面 6 列 / 移动端媒体查询 3 列）
  const cols = all.length <= 6 ? 6 : (all.length <= 8 ? 8 : (all.length <= 10 ? 10 : 12));
  const barEl = $('statsBar');
  if (all.length > 6) barEl.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  else barEl.style.gridTemplateColumns = '';
  barEl.innerHTML = all.map((d) => {
    let v, valText;
    if (d.plugin) {
      v = (state.pluginStats[d.key] / d.max) * 100;
      valText = state.pluginStats[d.key];
    } else if (d.key === 'temp') {
      v = s.temp === '热' ? 100 : s.temp === '冷' ? 20 : 60;
      valText = s.temp;
    } else {
      v = s[d.key];
      valText = s[d.key];
    }
    const cls = flashes[d.key] ? ' flash' : '';
    const safeLabel = escapeHtml(d.label);
    const safeVal = escapeHtml(String(valText));
    return `<div class="stat">
      <div class="label"><span>${safeLabel}</span><span class="val${cls}">${safeVal}</span></div>
      <div class="bar"><div style="width:${Math.max(0, Math.min(100, v))}%;background:${d.color}"></div></div>
    </div>`;
  }).join('');
}

function renderBanner(state) {
  $('dayBanner').textContent = `${state.day}天 灾日(${getDisasterType(state.day)})`;
}

function renderLog(state) {
  const el = $('log');
  el.innerHTML = state.history.map((m) => `<div class="msg ${m.role}">${escapeHtml(m.text)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMemory(state) {
  const m = state.memory || {};
  const labels = { player: '玩家状态', world: '世界局势', events: '重要事件', knowledge: '已学知识' };
  let total = 0;
  let html = '';
  for (const key of ['player', 'world', 'events', 'knowledge']) {
    const items = Array.isArray(m[key]) ? m[key] : [];
    total += items.length;
    html += `<div class="mem-cat"><b>${labels[key]}</b>`;
    if (items.length) {
      html += `<ul>${items.map((it) => `<li>${escapeHtml(it)}</li>`).join('')}</ul>`;
    } else {
      html += `<span class="mem-empty">（空）</span>`;
    }
    html += '</div>';
  }
  const el = $('memoryContent');
  if (el) el.innerHTML = html;
  const cnt = $('memoryCount');
  if (cnt) cnt.textContent = `共 ${total} 条`;
}

function renderMap(state) {
  const el = $('miniMap');
  if (!el) return;
  const rows = Array.isArray(state.map) ? state.map : [];
  el.textContent = rows.join('\n') || '（地图未知）';
  const legendEl = $('mapLegend');
  if (legendEl) {
    legendEl.innerHTML = state.mapLegend
      ? state.mapLegend.split('  ').filter(Boolean).map((s) => `<div class="lg-item">${escapeHtml(s)}</div>`).join('')
      : '';
  }
}

function renderAll(state) {
  renderBanner(state);
  renderStats(state);
  renderMemory(state);
  renderMap(state);
  renderLog(state);
  autosave(state);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.style.display = 'none'), 2500);
}

// ---------- 主流程 ----------
let G = newGameState();
let busy = false;

function pushLogs(state, userText, aiText) {
  state.logs.push({ role: 'user', content: userText });
  state.logs.push({ role: 'assistant', content: aiText });
  if (state.logs.length > 200) state.logs = state.logs.slice(-200);
}

async function sendCommand(text) {
  if (busy) return;
  const cmd = text.trim();
  if (!cmd) return;

  if (G.death) {
    toast('你已死亡，请先新建游戏');
    return;
  }

  busy = true;
  $('btnSend').disabled = true;

  // 显示玩家消息
  G.history.push({ role: 'user', text: cmd });
  renderAll(G);

  try {
    // 首次调用 AI
    let aiText = await callAI(G, cmd);
    let parsed = parseAIOutput(aiText);

    // 解析失败：自动重试（最多2次），把错误反馈给 AI
    let retried = 0;
    while (!parsed && retried < 2) {
      retried++;
      const feedback = '【系统提示】你上一条回复不是合法 JSON 或缺少有效内容，游戏无法结算。请重新只输出一个合法 JSON 对象（键用双引号、数字不带+号、无尾逗号、无markdown围栏），格式严格按系统要求。不要再输出任何其他文字。';
      const extraLogs = [
        { role: 'assistant', content: aiText },
        { role: 'user', content: feedback },
      ];
      aiText = await callAI(G, cmd, extraLogs);
      parsed = parseAIOutput(aiText);
    }

    const out = applyAIResult(G, parsed);

    pushLogs(G, cmd, aiText);

    // 渲染 AI 回复：解析成功显示 narrator/event；彻底失败则把原文当文本显示
    let display;
    if (parsed) {
      display = out.narrator || '';
      if (out.event) display = display ? display + '\n\n' + out.event : out.event;
      if (!display) display = aiText;
    } else {
      // 重试后仍不是 JSON：把 AI 原始文本作为叙事显示，状态不结算
      display = aiText || '（AI 未返回有效内容）';
      if (retried > 0) {
        G.history.push({ role: 'sys', text: '⚠️ AI 未按协议返回 JSON，本次未结算状态（已重试 ' + retried + ' 次）。' });
      }
    }
    G.history.push({ role: 'ai', text: display });

    if (G.death) {
      const dropped = handleDeath(G);
      G.history.push({
        role: 'sys',
        text: `☠️ 你死了！在床上复活，属性降至1/4。物品全部掉落：${dropped.length ? dropped.join('、') : '（无）'}`,
      });
    }
  } catch (e) {
    G.history.push({ role: 'sys', text: '⚠️ ' + e.message });
    toast(e.message);
  }

  busy = false;
  $('btnSend').disabled = false;
  $('cmdInput').value = '';
  renderAll(G);
}

// ---------- 事件绑定 ----------
function init() {
  // 侧边栏（小地图）展开/收起
  const sidebar = $('sidebar');
  const toggleBtn = $('btnSidebarToggle');
  if (sidebar && toggleBtn) {
    const SIDEBAR_KEY = 'survival_sidebar_collapsed';
    let collapsed = false;
    try { collapsed = localStorage.getItem(SIDEBAR_KEY) === '1'; } catch (e) {}
    const applySidebar = () => {
      sidebar.classList.toggle('collapsed', collapsed);
      toggleBtn.textContent = collapsed ? '▶' : '◀';
      try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (e) {}
    };
    applySidebar();
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      applySidebar();
    });
  }

  // 指令按钮
  document.querySelectorAll('.cmd').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = btn.dataset.cmd;
      if (c === '[其他]') {
        $('cmdInput').focus();
      } else {
        sendCommand(c);
      }
    });
  });

  $('btnSend').addEventListener('click', () => sendCommand($('cmdInput').value));
  $('cmdInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendCommand($('cmdInput').value);
  });

  // 新建游戏
  $('btnNew').addEventListener('click', () => {
    if (!confirm('确定要新建游戏吗？当前进度将丢失（自动存档仍保留）。')) return;
    G = newGameState();
    _prevStats = {};   // 重置状态变化追踪，避免新建时闪烁
    const opening = '你从冰冷的地面上醒来，脑中一片空白。四周是老旧的墙壁，破损的家具散落一地，这似乎是一间被遗弃已久的卧室。晨光从钉着木条的窗外透进来，空气中弥漫着灰尘和霉变的气味。';
    G.history.push({ role: 'ai', text: opening });
    renderAll(G);
    toast('新游戏已开始');
  });

  // 保存存档（下载 JSON 文件）
  $('btnSave').addEventListener('click', () => {
    const fname = exportSave(G);
    toast('存档已导出：' + fname + '（.json 文件）');
  });

  // 导入存档
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // 提前拦截明显错误的文件类型
    const lower = (file.name || '').toLowerCase();
    if (lower.endsWith('.pdf')) {
      toast('导入失败：这是一个 PDF 文件，不是存档。请选择导出的 .json 存档文件');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result);
        // 内容级检测：PDF 文件头 %PDF
        if (text.startsWith('%PDF')) {
          toast('导入失败：这个文件是 PDF（其内容以 %PDF 开头），不是 JSON 存档');
          return;
        }
        G = parseSaveFile(text);
        if (!G.history.length) G.history.push({ role: 'sys', text: '存档导入成功（无对话历史）' });
        renderAll(G);
        toast('存档导入成功');
      } catch (err) {
        toast('导入失败：' + err.message + '（请确认选择的是「保存存档」导出的 .json 文件）');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // 重新载入规则
  $('btnReloadRules').addEventListener('click', async () => {
    const ok = await loadRules();
    toast(ok ? '规则已重新载入' : '规则文件读取失败');
  });

  // 设置
  const sel = $('providerSelect');
  const customFields = $('customFields');
  const keyInput = $('apiKeyInput');
  const keyLabel = $('keyLabel');

  // 切换服务商时更新关键字段显示状态、自定义字段显隐
  function syncProviderUI() {
    const id = sel.value;
    if (customFields) customFields.style.display = (id === 'custom') ? 'flex' : 'none';
    const prov = PROVIDERS[id];
    if (keyLabel) keyLabel.textContent = (id === 'custom' ? '自定义' : prov.label) + ' API Key';
    // 提示当前服务商已配置情况
    const hintEl = $('apiKeyHint');
    if (hintEl) {
      if (id === 'custom') {
        hintEl.textContent = '自定义：填写任意 OpenAI 兼容接口地址、模型名和 API Key。';
      } else {
        const configured = isLocalMode() ? null : !!getKey(id).trim();
        hintEl.textContent = isLocalMode()
          ? '本地模式：服务商 Key 由电脑上的 config.json 管理（可选在此修改）。'
          : (configured ? '该服务商 Key 已保存在浏览器（留空则不修改）。' : '公网模式：填你自己的 ' + prov.label + ' API Key（只存本浏览器）。');
      }
    }
  }

  $('btnSettings').addEventListener('click', async () => {
    const id = getProvider();
    sel.value = id;
    keyInput.value = '';

    // 同步主题选择框
    const themeSel = $('themeSelect');
    if (themeSel) themeSel.value = getTheme();

    if (id === 'custom') {
      $('customUrlInput').value = getCustomUrl();
      $('customModelInput').value = getCustomModel();
    } else if (isLocalMode()) {
      // 本地模式：从服务端读对应已配置情况
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        if (data.configured && data.configured[id]) keyInput.value = '（已配置，留空则不修改）';
      } catch (e) {}
    } else {
      // 公网模式：读浏览器本地
      if (getKey(id).trim()) keyInput.value = '（已保存，留空则不修改）';
    }
    syncProviderUI();
    $('settingsModal').style.display = 'flex';
  });

  sel.addEventListener('change', syncProviderUI);

  // 主题切换：即时生效 + 持久化
  const themeSel = $('themeSelect');
  if (themeSel) {
    themeSel.addEventListener('change', () => {
      setTheme(themeSel.value);
      toast('主题已切换：' + (themeSel.value === 'neon' ? '蓝紫渐变' : '暗黑'));
    });
  }

  // 壁纸：上传
  $('btnWallpaperUpload').addEventListener('click', () => $('wallpaperFile').click());
  $('wallpaperFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const b64 = await uploadWallpaper(file);
      setWallpaper(b64);
      applyWallpaper();
      toast('壁纸已设置');
    } catch (err) {
      toast('壁纸上传失败：' + err.message);
    }
    e.target.value = '';
  });
  // 壁纸：清除
  $('btnWallpaperClear').addEventListener('click', () => {
    setWallpaper('');
    applyWallpaper();
    toast('壁纸已清除');
  });
  // 壁纸：模糊度/明暗滑杆（实时预览 + 持久化）
  const blurEl = $('wallBlur');
  const dimEl = $('wallDim');
  const blurVal = $('wallBlurVal');
  const dimVal = $('wallDimVal');
  if (blurEl) {
    blurEl.value = getWallBlur();
    blurVal.textContent = blurEl.value;
    blurEl.addEventListener('input', () => {
      blurVal.textContent = blurEl.value;
      setWallBlur(parseInt(blurEl.value, 10));
      applyWallpaper();
    });
  }
  if (dimEl) {
    dimEl.value = getWallDim();
    dimVal.textContent = dimEl.value;
    dimEl.addEventListener('input', () => {
      dimVal.textContent = dimEl.value;
      setWallDim(parseInt(dimEl.value, 10));
      applyWallpaper();
    });
  }

  // 插件：列表渲染
  const pluginListEl = $('pluginList');
  function renderPluginList() {
    if (!pluginListEl) return;
    const ps = loadPlugins().map(normalizePlugin).filter(Boolean);
    if (!ps.length) {
      pluginListEl.innerHTML = '<div class="plugin-empty">尚未导入插件</div>';
      return;
    }
    pluginListEl.innerHTML = ps.map((p) => `
      <div class="plugin-item">
        <span class="p-name">${escapeHtml(p.name)}</span>
        <span class="p-meta">v${escapeHtml(p.version)} · ${p.stats.length}状态项</span>
        <button data-del="${escapeHtml(p.id)}">删除</button>
      </div>`).join('');
    // 删除按钮
    pluginListEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        const removed = loadPlugins().find((p) => String(p.id) === id);
        const ps2 = loadPlugins().filter((p) => String(p.id) !== id);
        savePlugins(ps2);
        // 清理该插件对应状态数值
        if (removed && G.pluginStats) {
          const removedKeys = (removed.stats || []).map((s) => s.key);
          for (const k of removedKeys) delete G.pluginStats[k];
        }
        renderPluginList();
        renderAll(G);
        toast('插件已删除');
      });
    });
  }
  renderPluginList();

  // 插件：导入
  $('btnPluginImport').addEventListener('click', () => $('pluginFile').click());
  $('pluginFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = normalizePlugin(JSON.parse(String(reader.result)));
        if (!p) throw new Error('插件格式无效');
        const list = loadPlugins();
        // 同 id 覆盖
        const idx = list.findIndex((x) => String(x.id) === p.id);
        if (idx >= 0) list[idx] = p;
        else list.push(p);
        savePlugins(list);
        renderPluginList();
        ensurePluginStats(G);
        renderAll(G);
        toast('插件已导入：' + p.name);
      } catch (err) {
        toast('插件导入失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // 插件：示例格式
  $('btnPluginExample').addEventListener('click', () => {
    const example = {
      id: 'example-mod',
      name: '示例插件',
      version: '1.0',
      stats: [
        { key: 'sanity', icon: '🧠', label: '理智', max: 100, default: 80 },
        { key: 'luck', icon: '🍀', label: '运气', max: 50, default: 25 },
      ],
      stylePrompt: '你的描写要更注重心理氛围和情绪。',
      extraRules: '新增规则：当理智低于 30 时，玩家会出现幻觉，行动可能失败。',
    };
    const blob = new Blob([JSON.stringify(example, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'example_plugin.json';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
    toast('已下载示例插件');
  });

  $('btnApiCancel').addEventListener('click', () => ($('settingsModal').style.display = 'none'));

  $('btnApiSave').addEventListener('click', async () => {
    const id = sel.value;
    const v = keyInput.value.trim();

    // 保存自定义服务商的地址/模型
    if (id === 'custom') {
      try {
        localStorage.setItem(STORE_KEYS.customUrl, $('customUrlInput').value.trim());
        localStorage.setItem(STORE_KEYS.customModel, $('customModelInput').value.trim());
      } catch (e) {}
    }
    setProvider(id);

    // 保存 Key（留空或占位符时跳过，不清空已有）
    if (v && !v.startsWith('（')) {
      if (isLocalMode()) {
        let ok = false;
        try {
          const resp = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: id, key: v }),
          });
          const data = await resp.json().catch(() => ({}));
          ok = resp.ok && data.ok;
        } catch (e) { ok = false; }
        if (ok) {
          toast('Key 已保存（' + PROVIDERS[id].label + '）');
        } else {
          toast('保存失败：请确认本地服务正在运行');
          return; // 失败时保持弹窗打开
        }
      } else {
        setKey(id, v);
        toast('Key 已保存在浏览器（' + PROVIDERS[id].label + '）');
      }
    } else {
      toast('已选择服务商：' + PROVIDERS[id].label);
    }
    $('settingsModal').style.display = 'none';
  });
}

// ---------- 启动 ----------
(async function boot() {
  applyTheme();          // 应用已保存的界面主题
  applyWallpaper();      // 应用已保存的壁纸与调节
  await detectMode();   // 先确定运行模式（本地代理 or 公网直连）
  await loadRules();

  // 尝试恢复：优先自动存档
  let restored = null;
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) restored = parseSaveFile(raw);
  } catch (e) {}

  if (restored && restored.history.length) {
    G = restored;
  } else {
    // 新游戏开局
    G.history.push({
      role: 'ai',
      text: '你从冰冷的地面上醒来，脑中一片空白。四周是老旧的墙壁，破损的家具散落一地，这似乎是一间被遗弃已久的卧室。晨光从钉着木条的窗外透进来，空气中弥漫着灰尘和霉变的气味。',
    });
  }

  // 公网模式且未填 Key：开局提示
  if (!isLocalMode()) {
    const provId = getProvider();
    const needKey = provId === 'custom' ? !getCustomUrl().trim() || !getKey(provId).trim() : !getKey(provId).trim();
    if (needKey) {
      const prov = PROVIDERS[provId];
      G.history.push({
        role: 'sys',
        text: '📌 公网模式：请先点击右上角「设置」，填入所选服务商（' + prov.label + '）的 API Key 后再开始游戏。',
      });
    }
  }

  renderAll(G);
  init();
})();

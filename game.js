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
  mods: 'survival_mods',                      // 已导入 Mod 列表（TXT 内容 + 启用状态）
  modEnabled: 'survival_mod_enabled',         // Mod 启用状态映射（JSON 对象）
};

// ---------- 自定义 Mod（TXT 格式，无门槛） ----------
// TXT Mod 格式：
//   【Mod名】天末灾日
//   【版本】v1.0
//   【规则】· 病毒蔓延…  · 血月日…
//   【指令】· [喝茶]：提供微量食物厌倦缓解
//   【状态栏】· 理智：0-100=80
//   【回答风格】· 冷峻，心理描写
const MAX_MOD_STATS = 8;   // Mod 可自定义状态项上限

// 解析 TXT Mod：输入原始文本，输出规范化 Mod 对象（解析失败返回 null）
function parseTxtMod(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const lines = String(rawText).split(/\r?\n/);
  let name = '';
  let version = '';
  let rules = '';
  let style = '';
  const commands = [];
  const stats = [];
  let currentSection = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;  // 空行/注释

    // 识别节标题：【xxx】
    const secMatch = line.match(/^【(.+?)】/);
    if (secMatch) {
      const secName = secMatch[1];
      const rest = line.slice(secMatch[0].length).trim();
      const secKey = secName.toLowerCase();   // 统一小写比较，覆盖所有大小写变体
      if (secKey === 'mod名') {
        name = rest || name;
        currentSection = '';
      } else if (secKey === '版本') {
        version = rest || version;
        currentSection = '';
      } else if (secKey === '规则') {
        currentSection = 'rules';
        if (rest) rules += rest + '\n';
      } else if (secKey === '回答风格') {
        currentSection = 'style';
        if (rest) style += rest + ' ';
      } else if (secKey === '指令') {
        currentSection = 'commands';
        if (rest) parseCommandLine(rest.replace(/^[·•*\-]\s*/, ''), commands);
      } else if (secKey === '状态栏') {
        currentSection = 'stats';
        if (rest) parseStatLine(rest.replace(/^[·•*\-]\s*/, ''), stats);
      } else {
        currentSection = '';
      }
      continue;
    }

    // 非节标题行，按当前区块收集（统一剥离行首符号，避免污染解析）
    const textLine = line.replace(/^[·•*\-]\s*/, '');
    if (currentSection === 'rules') {
      rules += textLine + '\n';
    } else if (currentSection === 'style') {
      style += textLine + ' ';
    } else if (currentSection === 'commands') {
      parseCommandLine(textLine, commands);
    } else if (currentSection === 'stats') {
      parseStatLine(textLine, stats);
    }
  }

  if (!name) return null;   // 缺少 Mod 名 → 不合法

  return {
    id: 'mod_' + name,        // 用名称生成稳定 id
    name,
    version: version || '1.0',
    rules: rules.trim(),
    commands: commands.slice(0, 10),
    stats: stats.slice(0, MAX_MOD_STATS),
    style: style.trim(),
  };
}

// 解析指令行：[名字]：说明 → commands.push({ name, prompt })
function parseCommandLine(line, commands) {
  const m = line.match(/\[(.+?)\]\s*[:：]?\s*(.*)/);
  if (!m) return;
  const btnName = m[1].trim();
  if (!btnName) return;
  // 忽略与基底固定按钮重复的（基底由另外的地方渲染，这里只收 Mod 新增）
  const desc = m[2].trim();
  commands.push({ name: btnName, prompt: desc });
}

// 判断首字符是否为 emoji（用码点范围，兼容不支持 \p{Emoji} 的老浏览器/WebView）
function isEmojiChar(ch) {
  const cp = typeof ch === 'string' && ch.length ? ch.codePointAt(0) : 0;
  return (cp >= 0x1F000 && cp <= 0x1FAFF)   // 表情符号区
    || (cp >= 0x2600 && cp <= 0x27BF)       // 杂项符号/装饰
    || (cp >= 0x2B00 && cp <= 0x2BFF)       // 箭头等
    || cp === 0xFE0F || cp === 0x200D;      // 变体选择符/ZWJ
}
// 解析状态栏行：数值型「名称：min-max=默认」/「名称：数字」；文本型「名称：初始文本」（非数字）
function parseStatLine(line, stats) {
  let m = line.match(/^(.+?)\s*[:：]\s*(\d+)\s*[-~]\s*(\d+)\s*(?:[=＝]\s*(\d+))?/);
  let label, min, max, def;
  if (m) {
    label = m[1].trim();
    min = parseInt(m[2], 10);
    max = parseInt(m[3], 10);
    def = m[4] !== undefined ? parseInt(m[4], 10) : Math.round((min + max) / 2);
  } else {
    // 兜底数值格式：名称：数字（视为 max）
    m = line.match(/^(.+?)\s*[:：]\s*(\d+)/);
    if (m) {
      label = m[1].trim();
      min = 0;
      max = parseInt(m[2], 10);
      def = Math.round(max / 2);
    } else {
      // 文本类型：名称：初始文本（或 名称=初始文本）
      m = line.match(/^(.+?)\s*[:：=＝]\s*(.+)$/);
      if (!m) return;
      label = m[1].trim();
      if (!label) return;
      const textDefault = m[2].trim();
      // 图标：用 Array.from 按码点取首字符（正确处理 emoji 代理对）
      const chars = Array.from(label);
      const firstIsEmoji = isEmojiChar(chars[0]);
      const icon = firstIsEmoji ? chars[0] : '⭐';
      const cleanLabel = firstIsEmoji ? chars.slice(1).join('').trim() : label;
      stats.push({
        key: 'm_' + cleanLabel,
        icon,
        label: cleanLabel || label,
        text: true,               // 文本类型标记
        default: textDefault,     // 初始文本
      });
      return;
    }
  }
  if (!label || max <= 0) return;
  // 图标：用 Array.from 按码点取首字符（正确处理 emoji 代理对）
  const chars = Array.from(label);
  const firstIsEmoji = isEmojiChar(chars[0]);
  const icon = firstIsEmoji ? chars[0] : '⭐';
  const cleanLabel = firstIsEmoji ? chars.slice(1).join('').trim() : label;
  // key 用 m_ 前缀天然隔离基底状态键，无需保留字过滤
  const key = 'm_' + cleanLabel;
  stats.push({
    key,
    icon,
    label: cleanLabel || label,
    max,
    default: Math.max(0, Math.min(max, def)),
  });
}

// 读取所有 Mod 原始文本
function loadMods() {
  try {
    const raw = localStorage.getItem(STORE_KEYS.mods);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function saveMods(list) {
  try { localStorage.setItem(STORE_KEYS.mods, JSON.stringify(list)); } catch (e) {}
}
// 读取/写入某个 Mod 的启用状态
const DEFAULT_ENABLED = { };
function loadModEnabled() {
  try {
    const raw = localStorage.getItem(STORE_KEYS.modEnabled);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) { return {}; }
}
function setModEnabled(id, enabled) {
  const obj = loadModEnabled();
  if (enabled) obj[id] = true;
  else delete obj[id];
  try { localStorage.setItem(STORE_KEYS.modEnabled, JSON.stringify(obj)); } catch (e) {}
}
function isModEnabled(id) {
  return !!loadModEnabled()[id];
}

// 规范化的启用 Mod 列表
function activeMods() {
  return loadMods().map(parseTxtMod).filter(Boolean).filter((m) => isModEnabled(m.id));
}
// 所有 Mod（含解析后对象）
function allMods() {
  return loadMods().map(parseTxtMod).filter(Boolean);
}

// 把所有启用 Mod 的规则/风格合并成注入 AI 的文本
function buildModPrompt() {
  const mods = activeMods();
  if (!mods.length) return '';
  const parts = [];
  for (const m of mods) {
    const bits = [];
    if (m.style) bits.push('对话风格：' + m.style);
    if (m.stats.length) {
      const descs = m.stats.map((s) => {
        if (s.text) {
          return '"' + s.key + '"(' + s.icon + s.label + '，文本型，直接设置为字符串，如 "' + s.key + '": "杰出")';
        }
        return '"' + s.key + '"(表示 ' + s.icon + s.label + ', 0-' + s.max + '，增减量由你返回)';
      });
      bits.push('自定义状态项（stats 中须用如下 JSON key）：' + descs.join('、'));
    }
    if (m.commands.length) {
      bits.push('可用指令：' + m.commands.map((c) => '[' + c.name + ']' + (c.prompt ? '（' + c.prompt + '）' : '')).join(' '));
    }
    parts.push('【Mod·' + m.name + '】' + (bits.length ? bits.join('；') : '') + (m.rules ? '\n' + m.rules.trim() : ''));
  }
  return '\n---\n已加载 Mod 规则（仅在其明确覆盖的领域生效，其余按基底规则）：\n' + parts.join('\n\n');
}

// 收集所有启用 Mod 的指令按钮（供指令栏渲染）
function activeModCommands() {
  const commands = [];
  for (const m of activeMods()) {
    for (const c of m.commands) {
      if (!commands.some((x) => x.name === c.name)) commands.push(c);
    }
  }
  return commands;
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
    home: [],            // 家中物品（存放在家里的物品清单）
    savedPlaces: [],     // 已保存地点（可回头的地标）
    pluginStats: {},     // 插件自定义状态数值 { key: value }
  };
}

// Mod 状态默认值初始化（启用 Mod 或新游戏时补齐）
function ensurePluginStats(state) {
  const mods = activeMods();
  const target = state.pluginStats || (state.pluginStats = {});
  for (const m of mods) {
    for (const s of m.stats) {
      if (s.text) {
        // 文本类型：默认值为字符串
        if (typeof target[s.key] !== 'string') target[s.key] = s.default;
      } else {
        // 数值类型
        if (typeof target[s.key] !== 'number') target[s.key] = s.default;
      }
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
  // Mod 自定义状态：数值型按 max 钳制累加；文本型由 AI 直接设置字符串
  const mods = activeMods();
  if (mods.length) {
    const target = s.pluginStats || (s.pluginStats = {});
    const statDefs = {};
    for (const m of mods) for (const st of m.stats) statDefs[st.key] = st;
    for (const key of Object.keys(statDefs)) {
      if (d[key] === undefined) continue;
      const def = statDefs[key];
      if (def.text) {
        // 文本类型：直接设置（字符串）
        if (typeof d[key] === 'string') target[key] = d[key];
      } else if (typeof d[key] === 'number') {
        // 数值类型：累加 + 钳制
        const base = typeof target[key] === 'number' ? target[key] : 0;
        const max = def.max;
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
  "home_add": [],
  "home_remove": [],
  "place_save": [],
  "place_remove": [],
  "memory_add": { "player": [], "world": [], "events": [], "knowledge": [] },
  "memory_remove": [],
  "death": false
}

JSON 合法性与格式要求（违反会导致游戏崩溃）：
- stats 中的 hp/food/water/stamina/bored 是数字增减量：正值直接写数字（如 20），禁止加 + 号（"+20" 是非法 JSON！），负值写 -3。
- temp 只能是 热/温/冷 之一（字符串）。
- 所有键必须用双引号；不能有尾逗号；不能有注释；不能用单引号。
- 只列出发生变化或需要确认的字段，不要列出全部。
- inventory_add/inventory_remove：背包物品的增减（字符串数组）。
- home_add/home_remove：【家中物品】的增减——玩家把物品存放/取回家时使用（字符串数组）。
- place_save/place_remove：【已保存地点】的保存/移除——玩家记录地标时使用（**字符串数组**，如 ["废弃矿洞"]）。
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
  return (rulesText || '（规则文件缺失）') + SYSTEM_TAIL + buildModPrompt();
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
    home: state.home,             // 家中物品
    savedPlaces: state.savedPlaces,  // 已保存地点
    stats: state.stats,
    modStats: state.pluginStats || {},   // Mod 自定义状态当前值（AI 结算需知）
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

  // 家中物品：增减
  if (Array.isArray(parsed.home_add)) {
    for (const raw of parsed.home_add) {
      const it = typeof raw === 'string' ? raw.trim() : '';
      if (it && state.home.indexOf(it) < 0) state.home.push(it);
    }
  }
  if (Array.isArray(parsed.home_remove)) {
    for (const raw of parsed.home_remove) {
      const it = typeof raw === 'string' ? raw.trim() : '';
      const idx = state.home.indexOf(it);
      if (idx >= 0) state.home.splice(idx, 1);
    }
  }
  // 已保存地点：保存/移除
  if (Array.isArray(parsed.place_save)) {
    for (const raw of parsed.place_save) {
      const it = typeof raw === 'string' ? raw.trim() : '';
      if (it && state.savedPlaces.indexOf(it) < 0) state.savedPlaces.push(it);
    }
  }
  if (Array.isArray(parsed.place_remove)) {
    for (const raw of parsed.place_remove) {
      const it = typeof raw === 'string' ? raw.trim() : '';
      const idx = state.savedPlaces.indexOf(it);
      if (idx >= 0) state.savedPlaces.splice(idx, 1);
    }
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
    // 家中物品 / 已保存地点：兼容旧存档
    home: Array.isArray(state.home) ? state.home : [],
    savedPlaces: Array.isArray(state.savedPlaces) ? state.savedPlaces : [],
    // 插件状态：兼容旧存档
    pluginStats: (state.pluginStats && typeof state.pluginStats === 'object') ? state.pluginStats : {},
  };
}

// ---------- 界面渲染 ----------
const $ = (id) => document.getElementById(id);

// 记录各状态项旧值，用于数值变化闪烁提示
let _prevStats = {};

// 动态合并 Mod 指令按钮到指令栏（基底按钮在 HTML 中保持不动）
function renderModCommands() {
  const container = $('cmdButtons');
  if (!container) return;
  // 移除旧的 Mod 按钮（class='cmd mod-command'），保留基底按钮
  const old = container.querySelectorAll('.cmd.mod-command');
  old.forEach((b) => b.remove());
  const modBtns = activeModCommands();
  if (!modBtns.length) return;
  for (const c of modBtns) {
    const label = '[' + c.name + ']';
    // 若基底或其他 mod 已有同名按钮则跳过
    if (container.querySelector('[data-cmd="' + label + '"]')) continue;
    const b = document.createElement('button');
    b.className = 'cmd mod-command';
    b.setAttribute('data-cmd', label);
    b.textContent = label;
    b.addEventListener('click', () => sendCommand(label));
    container.appendChild(b);
  }
}

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
  // Mod 自定义状态项
  ensurePluginStats(state);
  const mods = activeMods();
  const pluginDefs = [];
  if (mods.length) {
    for (const m of mods) {
      for (const st of m.stats) {
        pluginDefs.push({
          key: st.key,
          label: st.icon + st.label,
          color: '#2ecc71',
          max: st.max,
          plugin: true,
          text: !!st.text,
        });
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
  // 动态列数：桌面端基础 6 列，每多 2 项增一列（最多 12）；移动端减半
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 640;
  let cols = all.length <= 6 ? 6 : (all.length <= 8 ? 8 : (all.length <= 10 ? 10 : 12));
  if (isMobile) cols = Math.max(3, Math.ceil(cols / 2));
  const barEl = $('statsBar');
  barEl.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
  barEl.innerHTML = all.map((d) => {
    let v, valText;
    if (d.plugin && d.text) {
      // 文本类型 Mod 状态：无进度条，直接显示文本
      valText = state.pluginStats[d.key];
      const cls = flashes[d.key] ? ' flash' : '';
      const safeLabel = escapeHtml(d.label);
      const safeVal = escapeHtml(String(valText));
      return `<div class="stat">
        <div class="label"><span>${safeLabel}</span><span class="val${cls}">${safeVal}</span></div>
      </div>`;
    }
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

function renderSidebar(state) {
  const el = $('sidebarBody');
  if (!el) return;
  const inv = Array.isArray(state.inventory) ? state.inventory : [];
  const home = Array.isArray(state.home) ? state.home : [];
  const places = Array.isArray(state.savedPlaces) ? state.savedPlaces : [];

  const sec = (title, items, emptyText) => `
    <div class="sb-section">
      <div class="sb-title">${title} <span class="sb-count">${items.length}</span></div>
      ${items.length
        ? '<ul class="sb-list">' + items.map((it) => `<li>${escapeHtml(it)}</li>`).join('') + '</ul>'
        : `<div class="sb-empty">${emptyText}</div>`}
    </div>`;

  el.innerHTML =
    sec('🎒 背包', inv, '空空如也') +
    sec('🏠 家中物品', home, '没有存放物品') +
    sec('📍 已保存地点', places, '尚未保存地点');
}

function renderAll(state) {
  renderBanner(state);
  renderStats(state);
  renderMemory(state);
  renderSidebar(state);
  renderModCommands(state);
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
  // 侧边栏（物资）展开/收起
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

  // 指令按钮（只绑基底按钮；Mod 按钮由 renderModCommands 单独绑定，避免双重监听）
  document.querySelectorAll('#cmdButtons .cmd:not(.mod-command)').forEach((btn) => {
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
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    // 提前拦截明显错误的文件类型
    const lower = (file.name || '').toLowerCase();
    if (lower.endsWith('.pdf')) {
      toast('导入失败：这是一个 PDF 文件，不是存档。请选择导出的 .json 存档文件');
      e.target.value = '';
      return;
    }
    try {
      const text = await file.text();
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
    setTimeout(() => { e.target.value = ''; }, 0);
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

  // Mod：列表渲染（含启用开关 + 删除）
  const pluginListEl = $('pluginList');
  function renderPluginList() {
    if (!pluginListEl) return;
    const mods = allMods();
    if (!mods.length) {
      pluginListEl.innerHTML = '<div class="plugin-empty">尚未导入 Mod</div>';
      return;
    }
    pluginListEl.innerHTML = mods.map((m) => {
      const enabled = isModEnabled(m.id);
      return `
      <div class="plugin-item">
        <label class="plugin-toggle">
          <input type="checkbox" data-id="${escapeHtml(m.id)}" ${enabled ? 'checked' : ''}>
          <span class="p-name">${escapeHtml(m.name)}</span>
        </label>
        <span class="p-meta">v${escapeHtml(m.version)} · ${m.stats.length}状态 · ${m.commands.length}指令</span>
        <button data-del="${escapeHtml(m.id)}">删除</button>
      </div>`;
    }).join('');

    // 启用开关
    pluginListEl.querySelectorAll('input[data-id]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-id');
        setModEnabled(id, cb.checked);
        renderAll(G);
        if (cb.checked) toast('Mod 已启用');
        else toast('Mod 已禁用');
      });
    });
    // 删除按钮
    pluginListEl.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-del');
        const removed = allMods().find((m) => m.id === id);
        const mods2 = loadMods().filter((raw) => {
          const parsed = parseTxtMod(raw);
          return parsed && parsed.id !== id;
        });
        saveMods(mods2);
        // 清理该 Mod 对应状态数值 + 启用标记
        if (removed && removed.stats && G.pluginStats) {
          for (const s of removed.stats) delete G.pluginStats[s.key];
        }
        setModEnabled(id, false);
        renderPluginList();
        renderAll(G);
        toast('Mod 已删除');
      });
    });
  }
  renderPluginList();

  // Mod：导入 TXT
  $('btnPluginImport').addEventListener('click', () => $('pluginFile').click());
  $('pluginFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      // 用 file.text()（Promise）读取，比 FileReader 更兼容手机浏览器
      const text = await file.text();
      const m = parseTxtMod(text);
      if (!m) throw new Error('Mod 格式无效（缺少【Mod名】？）');
      const list = loadMods();
      // 同 id 覆盖
      const idx = list.findIndex((x) => {
        const parsed = parseTxtMod(x);
        return parsed && parsed.id === m.id;
      });
      const rawText = text.trim();
      if (idx >= 0) list[idx] = rawText;
      else list.push(rawText);
      saveMods(list);
      setModEnabled(m.id, true);   // 新导入默认启用
      renderPluginList();
      ensurePluginStats(G);
      renderAll(G);
      toast('Mod 已导入并启用：' + m.name);
    } catch (err) {
      toast('Mod 导入失败：' + err.message);
    }
    e.target.value = '';
  });

  // Mod：示例格式（下载）
  $('btnPluginExample').addEventListener('click', () => {
    const exampleTxt = `${'【Mod名】示例Mod\n【版本】v1.0\n【规则】\n· 这是示例 Mod 的世界观与规则说明。\n· 新增规则：当理智低于 30 时，玩家会出现幻觉，行动可能失败。\n【指令】\n· [喝茶]：提供微量食物厌倦缓解（示例指令）\n【状态栏】\n· 🧠理智：0-100=80\n· 🍀运气：0-50=25\n· 🏅资质：平庸（文本型，AI直接设置文字）\n【回答风格】\n· 你的描写要更注重心理氛围和情绪。'}`;
    const blob = new Blob([exampleTxt], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '示例Mod.txt';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
    toast('已下载示例 Mod');
  });

  // Mod：从文本框粘贴导入（绕开手机文件读取问题）
  $('btnPluginPaste').addEventListener('click', () => {
    const text = ($('pluginPaste') ? $('pluginPaste').value : '') || '';
    if (!text.trim()) {
      toast('请先粘贴 Mod 文本');
      return;
    }
    try {
      const m = parseTxtMod(text);
      if (!m) throw new Error('Mod 格式无效（缺少【Mod名】？）');
      const list = loadMods();
      const idx = list.findIndex((x) => {
        const parsed = parseTxtMod(x);
        return parsed && parsed.id === m.id;
      });
      const rawText = text.trim();
      if (idx >= 0) list[idx] = rawText;
      else list.push(rawText);
      saveMods(list);
      setModEnabled(m.id, true);
      renderPluginList();
      ensurePluginStats(G);
      renderAll(G);
      $('pluginPaste').value = '';
      toast('Mod 已导入并启用：' + m.name);
    } catch (err) {
      toast('Mod 导入失败：' + err.message);
    }
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

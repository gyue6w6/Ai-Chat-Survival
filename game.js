// AI 生存游戏 —— 前端核心逻辑
// 状态机 + 规则结算 + AI 调用 + 存档导入导出
// 双模式：
//   A. 本地模式（localhost/127.0.0.1）：走本地服务 /api/chat 代理，Key 在 config.json
//   B. 公网模式（GitHub Pages 等静态托管）：玩家在浏览器填自己的 Key（存 localStorage），直连 DeepSeek

const IS_LOCAL = typeof location !== 'undefined' && /^(127\.0\.0\.1|localhost|\[::1\])/.test(location.hostname);
const LOCAL_KEY_STORE = 'ds_own_api_key';

function getOwnKey() {
  try { return localStorage.getItem(LOCAL_KEY_STORE) || ''; } catch (e) { return ''; }
}
function setOwnKey(k) {
  try { localStorage.setItem(LOCAL_KEY_STORE, k); } catch (e) {}
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
  };
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
  "death": false
}

JSON 合法性与格式要求（违反会导致游戏崩溃）：
- stats 中的 hp/food/water/stamina/bored 是数字增减量：正值直接写数字（如 20），禁止加 + 号（"+20" 是非法 JSON！），负值写 -3。
- temp 只能是 热/温/冷 之一（字符串）。
- 所有键必须用双引号；不能有尾逗号；不能有注释；不能有单引号。
- 只列出发生变化或需要确认的字段，不要列出全部。
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
  return (rulesText || '（规则文件缺失）') + SYSTEM_TAIL;
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

  const payload = { model: 'deepseek-chat', messages, temperature: 0.8, max_tokens: 1500 };
  let res;

  if (isLocalMode()) {
    // 本地模式：走本地服务代理（Key 在 config.json，不进入浏览器）
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } else {
    // 公网模式：直连 DeepSeek，玩家自己的 Key（存 localStorage）
    const key = getOwnKey().trim();
    if (!key) {
      throw new Error('请先点击右上角「设置」，填入你自己的 DeepSeek API Key');
    }
    res = await fetch('https://api.deepseek.com/chat/completions', {
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
  const blob = new Blob([JSON.stringify({ format: 'survival-save', savedAt: stamp.toISOString(), state }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  URL.revokeObjectURL(a.href);
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
  };
}

// ---------- 界面渲染 ----------
const $ = (id) => document.getElementById(id);

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
  $('statsBar').innerHTML = defs.map((d) => {
    const v = d.key === 'temp' ? (s.temp === '热' ? 100 : s.temp === '冷' ? 20 : 60) : s[d.key];
    const valText = d.key === 'temp' ? s.temp : s[d.key];
    return `<div class="stat"><div class="label">${d.label}</div>
      <div class="bar"><div style="width:${v}%;background:${d.color}"></div></div>
      <div class="val">${valText}</div></div>`;
  }).join('');
}

function renderBanner(state) {
  $('dayBanner').textContent = `-------- ${state.day}天 灾日(${getDisasterType(state.day)}) --------`;
}

function renderLog(state) {
  const el = $('log');
  el.innerHTML = state.history.map((m) => `<div class="msg ${m.role}">${escapeHtml(m.text)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function renderAll(state) {
  renderBanner(state);
  renderStats(state);
  renderMemory(state);
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
    const opening = '你从冰冷的地面上醒来，脑中一片空白。四周是老旧的墙壁，破损的家具散落一地，这似乎是一间被遗弃已久的卧室。晨光从钉着木条的窗外透进来，空气中弥漫着灰尘和霉变的气味。';
    G.history.push({ role: 'ai', text: opening });
    renderAll(G);
    toast('新游戏已开始');
  });

  // 保存存档（下载 JSON 文件）
  $('btnSave').addEventListener('click', () => {
    exportSave(G);
    toast('存档已导出');
  });

  // 导入存档
  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        G = parseSaveFile(String(reader.result));
        if (!G.history.length) G.history.push({ role: 'sys', text: '存档导入成功（无对话历史）' });
        renderAll(G);
        toast('存档导入成功');
      } catch (err) {
        toast('导入失败：' + err.message);
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
  $('btnSettings').addEventListener('click', async () => {
    const hintEl = $('apiKeyHint');
    if (isLocalMode()) {
      // 本地模式：Key 由本地服务 config.json 管理
      if (hintEl) hintEl.textContent = '本地模式：Key 由电脑上的 config.json 管理（无需在此填写）。';
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        $('apiKeyInput').value = data.hasKey ? '（已配置，留空则不修改）' : '';
      } catch (e) {
        $('apiKeyInput').value = '';
      }
    } else {
      // 公网模式：玩家填自己的 Key，存浏览器 localStorage
      if (hintEl) hintEl.textContent = '公网模式：请填写你自己的 DeepSeek API Key（只保存在你的浏览器中）。';
      const own = getOwnKey();
      $('apiKeyInput').value = own ? '（已保存，留空则不修改）' : '';
    }
    $('settingsModal').style.display = 'flex';
  });
  $('btnApiCancel').addEventListener('click', () => ($('settingsModal').style.display = 'none'));
  $('btnApiSave').addEventListener('click', async () => {
    const v = $('apiKeyInput').value.trim();
    if (v && !v.startsWith('（')) {
      if (isLocalMode()) {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: v }),
        });
        const data = await res.json();
        toast(data.ok ? 'Key 已保存' : '保存失败');
      } else {
        // 公网模式：存浏览器 localStorage
        setOwnKey(v);
        toast('Key 已保存在浏览器中');
      }
    }
    $('settingsModal').style.display = 'none';
  });
}

// ---------- 启动 ----------
(async function boot() {
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
  if (!isLocalMode() && !getOwnKey().trim()) {
    G.history.push({
      role: 'sys',
      text: '📌 公网模式：请先点击右上角「设置」，填入你自己的 DeepSeek API Key 后再开始游戏。',
    });
  }

  renderAll(G);
  init();
})();

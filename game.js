(function() {
    'use strict';

    // ============================================================
    // 常量与配置
    // ============================================================

    const CORE_RULES = `【核心规则】
基于玩家回答和现实或者额外规则推演，真实有张力但戏剧性与意外。
禁止同情用户。

【行动】
1. 当玩家[探索]时生成详细周边环境描述。
2. 当玩家[思索]时生成提示或者其他信息。

【死亡惩罚】
死后将会由于巧合存活，但苏醒后各属性减少1/3，若玩家仍未能脱离险境将不再复活。`;

    const DIFFICULTY_PROMPTS = {
        easy: '你的回答应约 70% 符合玩家预期。',
        normal: '你的回答应约 50% 符合玩家预期。',
        hard: '你的回答应约 30% 符合玩家预期。',
        hardcore: '你的回答应约 20% 符合玩家预期。',
    };

    const DIFFICULTY_LABELS = {
        easy: 'Easy',
        normal: 'Normal',
        hard: 'Hard',
        hardcore: 'Hardcore',
    };

    const OUTPUT_PROTOCOL = `【输出协议】
你的整条回复必须是一个合法 JSON 对象，禁止输出任何其他文字、markdown 围栏或开场白。
JSON 格式：
{
  "narrator": "环境/动作结果描写（默认≤75字；玩家[探索]时可扩展至≤125字）",
  "stats": { "hp": 0, "food": -3, "water": -4, "stamina": -10 },
  "time_delta": 30,
  "time_freeze": false,
  "move": { "dx": 0, "dy": 0 },
  "consume": [ { "name": "木棍", "count": 1 } ],
  "durability_cost": [ { "name": "石斧", "amount": 5 } ],
  "offer_pickup": [ { "name": "木棍", "type": "item", "count": 1 } ],
  "inventory_full": false,
  "event": "特殊事件（无则省略）",
  "diary": "跨天时返回，简短要点（无则省略）"
}
要求：
- stats 中四项是增减量，正数直接写数字（如 5），禁止加 + 号；负数写 -5。
- time_delta 是本次行动消耗的游戏分钟数。
- time_freeze 为 true 时暂停时间流逝（用于紧张/关键时刻）；省略或 false 则恢复正常流逝。
- move 是本次行动的位移（dx 向东为正，dy 向北为正），无移动则省略。
- consume 是消耗的物品（前端扣数量），无则省略。
- durability_cost 是消耗的工具耐久（前端扣耐久），无则省略。
- offer_pickup 是玩家遇到的物品（前端弹选项让玩家选择是否拾起），无则省略。
- inventory_full 为 true 表示背包已满，无法拾取，无则省略。
- 所有键用双引号，不能有尾逗号。
- 只列出发生变化的字段。

【物品权重规则】
- [方括号] 里的内容是玩家当前实际持有的工具/物品，权重最高。
- 若 [空手且无工具和物品]，则玩家手上没有任何工具，即使文字里提到了工具，也视为没有。
- 玩家文字里的工具名称只是意图描述，不代表实际持有。
- 若玩家尝试用不合理的工具做某事（如徒手砍树），结果应符合现实，往往失败或效率极低。`;

    const FULL_SYSTEM_INTERVAL = 10;
    const HISTORY_LIMIT = 8;
    const TEMPERATURE = 0.9;

    const REAL_MS = 1000;
    const GAME_SECONDS_PER_TICK = 6;
    const INIT_GAME_SECONDS = 8 * 3600;

    const LS_CONFIG = 'eo_config';
    const LS_CONVS = 'eo_convs';

    const STAT_KEYS = ['hp', 'food', 'water', 'stamina'];

    // ============================================================
    // 全局引用
    // ============================================================
    const $ = (id) => document.getElementById(id);

    const splashLayer = $('splashLayer');
    const mainLayer = $('mainLayer');
    const saveLayer = $('saveLayer');
    const dialogLayer = $('dialogLayer');
    const splashTextContainer = $('splashText');
    const iconWrapper = document.querySelector('.icon-wrapper');
    const starField = $('starField');
    const titleMain = $('titleMain');
    const startBtn = $('startBtn');
    const settingsBtn = $('settingsBtn');
    const introBtn = $('introBtn');
    const saveBackBtn = $('saveBackBtn');
    const saveCardList = $('saveCardList');
    const saveAddCircle = $('saveAddCircle');
    const actionOverlay = $('actionOverlay');
    const actionNewBtn = $('actionNewBtn');
    const actionEditBtn = $('actionEditBtn');
    const actionCancelBtn = $('actionCancelBtn');
    const editSelectOverlay = $('editSelectOverlay');
    const editSelectList = $('editSelectList');
    const editSelectCancel = $('editSelectCancel');
    const dialogBackBtn = $('dialogBackBtn');
    const dialogTitle = $('dialogTitle');
    const dialogLog = $('dialogLog');
    const wizardOverlay = $('wizardOverlay');
    const wizardStepName = $('wizardStepName');
    const wizardStepDiff = $('wizardStepDiff');
    const wizardStepEra = $('wizardStepEra');
    const wizardStepState = $('wizardStepState');
    const wizardNameInput = $('wizardNameInput');
    const wizardNameCancel = $('wizardNameCancel');
    const wizardNameNext = $('wizardNameNext');
    const wizardDiffBack = $('wizardDiffBack');
    const wizardDiffNext = $('wizardDiffNext');
    const wizardEraTitle = $('wizardEraTitle');
    const wizardEraOptions = $('wizardEraOptions');
    const wizardEraBack = $('wizardEraBack');
    const wizardEraNext = $('wizardEraNext');
    const wizardStateTitle = $('wizardStateTitle');
    const wizardStateOptions = $('wizardStateOptions');
    const wizardStateBack = $('wizardStateBack');
    const wizardStateCreate = $('wizardStateCreate');
    const editOverlay = $('editOverlay');
    const editNameInput = $('editNameInput');
    const editDiffOptions = $('editDiffOptions');
    const editEraReadonly = $('editEraReadonly');
    const editStateReadonly = $('editStateReadonly');
    const editCancel = $('editCancel');
    const editOk = $('editOk');
    const editDelete = $('editDelete');
    const settingsOverlay = $('settingsOverlay');
    const settingsApiKey = $('settingsApiKey');
    const settingsBaseUrl = $('settingsBaseUrl');
    const settingsModel = $('settingsModel');
    const settingsCancel = $('settingsCancel');
    const settingsOk = $('settingsOk');
    const diaryToggleBtn = $('diaryToggleBtn');
    const diaryPanel = $('diaryPanel');
    const diaryDayLabel = $('diaryDayLabel');
    const diaryContent = $('diaryContent');
    const diaryPageNum = $('diaryPageNum');
    const diaryPrevBtn = $('diaryPrevBtn');
    const diaryNextBtn = $('diaryNextBtn');
    const mapToggleBtn = $('mapToggleBtn');
    const mapPanel = $('mapPanel');
    const mapArea = $('mapArea');
    const mapViewport = $('mapViewport');
    const mapPoints = $('mapPoints');
    const mapZoomIn = $('mapZoomIn');
    const mapZoomOut = $('mapZoomOut');
    const mapScaleText = $('mapScaleText');
    const bagToggleBtn = $('bagToggleBtn');
    const bagPanel = $('bagPanel');
    const bagCurrent = $('bagCurrent');
    const bagList = $('bagList');
    const storageTitle = $('storageTitle');
    const storageCurrent = $('storageCurrent');
    const storageList = $('storageList');
    const recordBtn = $('recordBtn');
    const recordOverlay = $('recordOverlay');
    const recordPos = $('recordPos');
    const recordInput = $('recordInput');
    const recordSetStorage = $('recordSetStorage');
    const recordCancel = $('recordCancel');
    const recordOk = $('recordOk');
    const pickupOverlay = $('pickupOverlay');
    const pickupList = $('pickupList');
    const pickupSkip = $('pickupSkip');
    const itemActionOverlay = $('itemActionOverlay');
    const itemActionTitle = $('itemActionTitle');
    const itemActionCancel = $('itemActionCancel');
    const itemActionOk = $('itemActionOk');
    const dialogInput = $('dialogInput');
    const dialogSendBtn = $('dialogSendBtn');
    const infoDay = $('infoDay');
    const infoTime = $('infoTime');
    const infoRound = $('infoRound');
    const infoPos = $('infoPos');

    // 序章
    const prologueLayer = $('prologueLayer');
    const prologueText = $('prologueText');
    const prologueDay = $('prologueDay');
    const prologueBody = $('prologueBody');
    const prologueSkip = $('prologueSkip');
    const prologueEnd = $('prologueEnd');
    const prologueBackBtn = $('prologueBackBtn');

    // 游戏介绍
    const introLayer = $('introLayer');
    const introBackBtn = $('introBackBtn');

    // ============================================================
    // 全局状态
    // ============================================================
    let animState = 'idle';
    let animationTimers = [];
    let conversations = [];
    let currentConvId = null;
    let editingConvId = null;
    let busy = false;
    let timeTimer = null;

    let wizardName = '';
    let wizardDiff = '';
    let wizardEra = '';
    let wizardState = '';

    // 序章
    let prologueIndex = 0;
    let prologuePlaying = false;
    let prologueTimers = [];

    // 日记翻页
    let diaryPage = 0;

    // 地图视图状态
    let mapScale = 1;
    let mapOffsetX = 0;
    let mapOffsetY = 0;
    let mapDragging = false;
    let mapDragStartX = 0;
    let mapDragStartY = 0;
    let mapDragStartOffsetX = 0;
    let mapDragStartOffsetY = 0;

    // 拾取临时数据
    let pendingPickups = [];

    // 长按
    let longPressItem = null;
    let longPressSource = null;

    // ============================================================
    // 配置读写
    // ============================================================
    function loadConfig() {
        try {
            const raw = localStorage.getItem(LS_CONFIG);
            if (!raw) return { apiKey: '', baseURL: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };
            const obj = JSON.parse(raw);
            return {
                apiKey: obj.apiKey || '',
                baseURL: obj.baseURL || 'https://api.deepseek.com/chat/completions',
                model: obj.model || 'deepseek-chat',
            };
        } catch (e) {
            return { apiKey: '', baseURL: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' };
        }
    }

    function saveConfig(cfg) {
        try { localStorage.setItem(LS_CONFIG, JSON.stringify(cfg)); } catch (e) {}
    }

    // ============================================================
    // 对话读写
    // ============================================================
    function loadConversations() {
        try {
            const raw = localStorage.getItem(LS_CONVS);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    function saveConversations(list) {
        try { localStorage.setItem(LS_CONVS, JSON.stringify(list)); } catch (e) {}
    }

    function newConvState() {
        return {
            stats: { hp: 80, food: 70, water: 70, stamina: 80 },
            gameSeconds: INIT_GAME_SECONDS,
            round: 0,
            logs: [],
            history: [],
            diaries: [],
            frozen: false,
            frozenRounds: 0,
            currentPos: { x: 0, y: 0 },
            savedPlaces: [ { name: '起点', x: 0, y: 0 } ],
            inventory: [],
            selected: [],
            storage: null,
            storageItems: [],
        };
    }

    // ============================================================
    // 工具
    // ============================================================
    function getCurrentConv() {
        return conversations.find((c) => c.id === currentConvId) || null;
    }

    function getDay(gameSeconds) {
        return Math.floor(gameSeconds / 86400);
    }

    function formatGameTime(gameSeconds) {
        const secsOfDay = ((gameSeconds % 86400) + 86400) % 86400;
        const hh = String(Math.floor(secsOfDay / 3600)).padStart(2, '0');
        const mm = String(Math.floor((secsOfDay % 3600) / 60)).padStart(2, '0');
        return hh + ':' + mm;
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, Math.round(v)));
    }

    function escapeHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function genId(prefix) {
        return (prefix || 'id_') + Date.now() + '_' + Math.floor(Math.random() * 10000);
    }

    // ============================================================
    // 信息渲染
    // ============================================================
    function updateInfo() {
        const conv = getCurrentConv();
        if (!conv) return;
        infoDay.textContent = getDay(conv.state.gameSeconds);
        infoTime.textContent = formatGameTime(conv.state.gameSeconds);
        infoRound.textContent = conv.state.round;
        const p = conv.state.currentPos || { x: 0, y: 0 };
        infoPos.textContent = '(' + p.x + ', ' + p.y + ')';
    }

    function startTimeFlow() {
        stopTimeFlow();
        timeTimer = setInterval(() => {
            const conv = getCurrentConv();
            if (!conv) return;
            if (conv.state.frozen) return;

            const beforeDay = getDay(conv.state.gameSeconds);
            conv.state.gameSeconds += GAME_SECONDS_PER_TICK;
            const afterDay = getDay(conv.state.gameSeconds);
            updateInfo();
            if (afterDay > beforeDay) {
                triggerDiarySummary(conv);
            }
            saveConversations(conversations);
        }, REAL_MS);
    }

    function stopTimeFlow() {
        if (timeTimer) {
            clearInterval(timeTimer);
            timeTimer = null;
        }
    }

    function renderStats() {
        const conv = getCurrentConv();
        if (!conv) return;
        const s = conv.state.stats;
        $('statHpVal').textContent = s.hp;
        $('statFoodVal').textContent = s.food;
        $('statWaterVal').textContent = s.water;
        $('statStaminaVal').textContent = s.stamina;
        $('statHpBar').style.width = s.hp + '%';
        $('statFoodBar').style.width = s.food + '%';
        $('statWaterBar').style.width = s.water + '%';
        $('statStaminaBar').style.width = s.stamina + '%';
    }

    function appendMessage(role, text) {
        const div = document.createElement('div');
        div.className = 'dialog-msg ' + role;
        div.textContent = text;
        dialogLog.appendChild(div);
        dialogLog.scrollTop = dialogLog.scrollHeight;
        return div;
    }

    // ============================================================
    // 存档界面渲染
    // ============================================================
    function renderConversations() {
        saveCardList.innerHTML = '';

        const sorted = conversations.slice().sort((a, b) => {
            const fa = a.faved ? 1 : 0;
            const fb = b.faved ? 1 : 0;
            return fb - fa;
        });

        sorted.forEach((conv) => {
            const card = document.createElement('div');
            card.className = 'save-card save-card-conv' + (conv.faved ? ' faved' : '');
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');

            const eraName = getEraName(conv.era);
            const stateName = getStateName(conv.worldState);
            const diffName = DIFFICULTY_LABELS[conv.difficulty] || '';
            const tag = [diffName, eraName, stateName].filter(Boolean).join('·');

            const favBtn = document.createElement('button');
            favBtn.className = 'conv-fav-btn' + (conv.faved ? ' faved' : '');
            favBtn.type = 'button';
            favBtn.setAttribute('aria-label', conv.faved ? '取消收藏' : '收藏');
            favBtn.textContent = '★';
            favBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                conv.faved = !conv.faved;
                saveConversations(conversations);
                renderConversations();
            });

            const nameSpan = document.createElement('span');
            nameSpan.className = 'conv-name';
            nameSpan.textContent = conv.name;

            const diffSpan = document.createElement('span');
            diffSpan.className = 'conv-diff';
            diffSpan.textContent = tag;

            card.appendChild(favBtn);
            card.appendChild(nameSpan);
            card.appendChild(diffSpan);

            card.addEventListener('click', (e) => {
                e.stopPropagation();
                openConversation(conv.id);
            });
            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    card.click();
                }
            });
            saveCardList.appendChild(card);
        });
    }

    function getEraName(eraId) {
        const era = window.WORLD_OPTIONS && window.WORLD_OPTIONS.era;
        if (!era) return '';
        const opt = era.options.find((o) => o.id === eraId);
        return opt ? opt.name : '';
    }

    function getStateName(stateId) {
        const st = window.WORLD_OPTIONS && window.WORLD_OPTIONS.state;
        if (!st) return '';
        const opt = st.options.find((o) => o.id === stateId);
        return opt ? opt.name : '';
    }

    // ============================================================
    // 界面切换
    // ============================================================
    function clearAllTimers() {
        animationTimers.forEach((t) => clearTimeout(t));
        animationTimers = [];
    }

    function buildStars() {
        if (!starField) return;
        starField.innerHTML = '';
        const COLS = 6;
        const ROWS = 3;
        const TOTAL_CELLS = COLS * ROWS;
        const STAR_COUNT = 18;

        const cellIndices = [];
        for (let i = 0; i < TOTAL_CELLS; i++) cellIndices.push(i);
        for (let i = cellIndices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [cellIndices[i], cellIndices[j]] = [cellIndices[j], cellIndices[i]];
        }

        const frag = document.createDocumentFragment();
        for (let n = 0; n < STAR_COUNT; n++) {
            const cellIdx = cellIndices[n];
            const col = cellIdx % COLS;
            const row = Math.floor(cellIdx / COLS);
            const cellW = 100 / COLS;
            const cellH = 100 / ROWS;
            const padX = cellW * 0.22;
            const padY = cellH * 0.22;
            const leftMin = col * cellW + padX;
            const leftMax = (col + 1) * cellW - padX;
            const topMin = row * cellH + padY;
            const topMax = (row + 1) * cellH - padY;

            const star = document.createElement('div');
            star.className = 'star';
            const size = (1.2 + Math.random() * 1.8).toFixed(2);
            const rot = Math.round(Math.random() * 360);
            const dx = ((Math.random() - 0.5) * 4).toFixed(2);
            const dy = ((Math.random() - 0.5) * 4).toFixed(2);
            const oMin = (0.15 + Math.random() * 0.20).toFixed(2);
            const oMax = (0.55 + Math.random() * 0.35).toFixed(2);
            const sMin = (0.90 + Math.random() * 0.08).toFixed(2);
            const sMax = (1.00 + Math.random() * 0.10).toFixed(2);
            const dur = (2.8 + Math.random() * 3.0).toFixed(2);
            const delay = (-Math.random() * 6).toFixed(2);
            const glow = (1.2 + Math.random() * 1.8).toFixed(1);

            star.style.width = size + 'px';
            star.style.height = size + 'px';
            star.style.left = (leftMin + Math.random() * (leftMax - leftMin)) + '%';
            star.style.top = (topMin + Math.random() * (topMax - topMin)) + '%';
            star.style.animationDuration = dur + 's';
            star.style.animationDelay = delay + 's';
            star.style.boxShadow = '0 0 ' + glow + 'px rgba(255,255,255,0.4)';
            star.style.setProperty('--rot', rot + 'deg');
            star.style.setProperty('--dx', dx + 'px');
            star.style.setProperty('--dy', dy + 'px');
            star.style.setProperty('--o-min', oMin);
            star.style.setProperty('--o-max', oMax);
            star.style.setProperty('--s-min', sMin);
            star.style.setProperty('--s-max', sMax);
            frag.appendChild(star);
        }
        starField.appendChild(frag);
    }

    function buildSplashText() {
        const text = 'BY LJY';
        splashTextContainer.innerHTML = '';
        const frag = document.createDocumentFragment();
        let letterIndex = 0;
        for (let i = 0; i < text.length; i++) {
            const char = text[i];
            const span = document.createElement('span');
            if (char === ' ') {
                span.className = 'space';
                span.textContent = ' ';
            } else {
                span.textContent = char;
                span.style.animationDelay = (0.5 + letterIndex * 0.12).toFixed(2) + 's';
                letterIndex++;
            }
            frag.appendChild(span);
        }
        splashTextContainer.appendChild(frag);
    }

    function resetLayers() {
        dialogLayer.classList.remove('visible');
        dialogLayer.style.opacity = '0';
        saveLayer.classList.remove('visible');
        saveLayer.style.opacity = '0';
        mainLayer.classList.remove('visible');
        mainLayer.style.opacity = '0';
        wizardOverlay.classList.remove('visible');
        settingsOverlay.classList.remove('visible');
        actionOverlay.classList.remove('visible');
        editOverlay.classList.remove('visible');
        editSelectOverlay.classList.remove('visible');
        prologueLayer.classList.remove('visible');
        introLayer.classList.remove('visible');
        recordOverlay.classList.remove('visible');
        pickupOverlay.classList.remove('visible');
        itemActionOverlay.classList.remove('visible');

        splashLayer.style.display = 'flex';
        splashLayer.style.opacity = '1';

        if (iconWrapper) {
            iconWrapper.style.animation = 'none';
            void iconWrapper.offsetHeight;
            iconWrapper.style.animation = 'iconFadeIn 1.8s cubic-bezier(0.4, 0, 0.2, 1) forwards';
        }

        buildSplashText();
        splashTextContainer.style.animation = 'none';
        void splashTextContainer.offsetHeight;
        splashTextContainer.style.animation = 'containerShake 0.5s ease-out 0.5s both';
    }

    function startAnimationSequence() {
        clearAllTimers();
        resetLayers();
        animState = 'splash';

        const timerFade = setTimeout(() => {
            splashLayer.style.opacity = '0';
        }, 2100);

        const timerMain = setTimeout(() => {
            splashLayer.style.display = 'none';
            mainLayer.classList.add('visible');
            mainLayer.style.opacity = '1';
            animState = 'main';
        }, 3500);

        const timerEnd = setTimeout(() => {
            animState = 'idle';
        }, 4800);

        animationTimers.push(timerFade, timerMain, timerEnd);
    }

    function enterSaveScreen() {
        if (animState === 'save') return;
        clearAllTimers();
        stopTimeFlow();
        renderConversations();

        saveLayer.style.transition = 'none';
        saveLayer.classList.add('visible');
        saveLayer.style.opacity = '0';
        void saveLayer.offsetHeight;

        saveLayer.style.transition = 'opacity 0.6s ease';
        mainLayer.style.transition = 'opacity 0.6s ease';

        mainLayer.classList.remove('visible');
        mainLayer.style.opacity = '0';
        saveLayer.style.opacity = '1';
        animState = 'save';
    }

    function backToMain() {
        saveLayer.style.transition = 'opacity 0.5s ease';
        mainLayer.style.transition = 'opacity 0.5s ease';
        saveLayer.classList.remove('visible');
        saveLayer.style.opacity = '0';
        mainLayer.classList.add('visible');
        mainLayer.style.opacity = '1';
        animState = 'main';
    }

    function enterDialogScreen(conv) {
        clearAllTimers();
        currentConvId = conv.id;

        dialogLayer.style.transition = 'none';
        dialogLayer.classList.add('visible');
        dialogLayer.style.opacity = '0';
        void dialogLayer.offsetHeight;

        dialogLayer.style.transition = 'opacity 0.6s ease';
        saveLayer.style.transition = 'opacity 0.6s ease';

        saveLayer.classList.remove('visible');
        saveLayer.style.opacity = '0';
        dialogLayer.style.opacity = '1';
        animState = 'dialog';

        dialogTitle.textContent = conv.name;

        dialogLog.innerHTML = '';
        conv.state.history.forEach((m) => {
            appendMessage(m.role, m.text);
        });

        diaryPage = 0;
        diaryPanel.classList.remove('open');
        diaryToggleBtn.classList.remove('active');
        mapPanel.classList.remove('open');
        mapToggleBtn.classList.remove('active');
        bagPanel.classList.remove('open');
        bagToggleBtn.classList.remove('active');

        renderStats();
        updateInfo();
        renderDiaries();
        renderBag();
        startTimeFlow();
    }

    function backToSave() {
        stopTimeFlow();
        dialogLayer.style.transition = 'opacity 0.5s ease';
        saveLayer.style.transition = 'opacity 0.5s ease';
        dialogLayer.classList.remove('visible');
        dialogLayer.style.opacity = '0';
        saveLayer.classList.add('visible');
        saveLayer.style.opacity = '1';
        animState = 'save';
        currentConvId = null;
        renderConversations();
    }

    // ============================================================
    // 序章
    // ============================================================
    const PROLOGUE_SEGMENTS = [
        { day: '第0天', body: '我从地上醒来，什么都不记得了。', cls: 'first' },
        { day: '', body: '只记得一句话"你能复活，但他们不能"\n我不明白', cls: 'quote' },
        { day: '第6天', body: '我在洞穴碰到个人，他说他叫老王，是个伐木工', cls: '' },
        { day: '第18天', body: '我和老王搭的高炉出海绵铁了。我留给老王，给他打了把斧子。', cls: '' },
        { day: '', body: '老王高兴得像个小孩，坐在磨石边哼歌。调子跑得没边，斧刃却磨得发亮。\n他喜欢哼歌。我记住了。', cls: '' },
        { day: '第37天', body: '小满喜欢把野花插进空罐头瓶。\n老陈喝粥要稀，说像小时候他娘熬的。\n\n我都记住了。', cls: '' },
        { day: '第81天', body: '疫病来了。\n药箱里只剩四支。发烧的却有七个人。', cls: '' },
        { day: '', body: '老王把药推给阿满，说："我老了，先给他们。"\n没人劝得住。', cls: 'quote' },
        { day: '第82天', body: '老王烧得说胡话。\n他手里还攥着那把斧子，嘴里哼着跑调的歌。', cls: '' },
        { day: '', body: '我把湿布搭在他额头上，他笑了一下："今天天不错。"', cls: 'quote' },
        { day: '第85天', body: '老王没了。\n我把他埋在高炉边。斧子插在土里，刃朝上。\n风一吹，我好像又听见他哼歌。', cls: '' },
        { day: '第86天', body: '小满也没了。罐头瓶里的花枯了。\n老陈的粥，一天比一天稠。', cls: '' },
        { day: '第104天', body: '老陈走了。\n锅里还剩半锅稠粥。\n我把它吃了。', cls: '' },
        { day: '', body: '很难吃。\n但我没倒。', cls: 'quote' },
        { day: '第143天', body: '营地还在。我活着。\n我记得每个人喜欢什么。\n可他们，我再也见不到了。', cls: '' },
        { day: '第239天', body: '营地规模大了一倍，越来越多的幸存者来了\n他们叫我"管事的"。\n可我记得的，还是那几个名字。', cls: '' },
        { day: '第397天', body: '今天有人问我："你叫什么？"\n我张了张嘴，发现自己还是想不起来。', cls: '' },
        { day: '', body: '但我记得老王哼歌，记得小满插花，记得老陈的稀粥。\n我记得他们。\n那我就还算活着。', cls: 'last' },
    ];

    const PROLOGUE_FADE_IN = 900;
    const PROLOGUE_HOLD = 2400;
    const PROLOGUE_FADE_OUT = 900;
    const PROLOGUE_GAP = 250;

    function clearPrologueTimers() {
        prologueTimers.forEach(t => clearTimeout(t));
        prologueTimers = [];
    }

    function showPrologueSegment(index) {
        if (index >= PROLOGUE_SEGMENTS.length) {
            showPrologueEnd();
            return;
        }

        const seg = PROLOGUE_SEGMENTS[index];
        prologueDay.textContent = seg.day || '';
        prologueBody.textContent = seg.body;
        prologueBody.className = 'prologue-body ' + (seg.cls || '');

        prologueText.classList.remove('hidden');
        prologueText.classList.add('visible');

        const t1 = setTimeout(() => {
            if (!prologuePlaying) return;
            prologueText.classList.remove('visible');
            prologueText.classList.add('hidden');

            const t2 = setTimeout(() => {
                if (!prologuePlaying) return;
                prologueIndex++;
                showPrologueSegment(prologueIndex);
            }, PROLOGUE_FADE_OUT + PROLOGUE_GAP);
            prologueTimers.push(t2);
        }, PROLOGUE_FADE_IN + PROLOGUE_HOLD);
        prologueTimers.push(t1);
    }

    function showPrologueEnd() {
        prologuePlaying = false;
        clearPrologueTimers();
        prologueText.classList.remove('visible');
        prologueText.classList.add('hidden');
        prologueSkip.classList.remove('visible');
        prologueEnd.classList.add('visible');
    }

    function startPrologue() {
        prologueIndex = 0;
        prologuePlaying = true;
        prologueEnd.classList.remove('visible');
        prologueLayer.classList.add('visible');
        showPrologueSegment(0);

        const t = setTimeout(() => {
            if (prologuePlaying) prologueSkip.classList.add('visible');
        }, 2500);
        prologueTimers.push(t);
    }

    function closePrologue() {
        prologuePlaying = false;
        clearPrologueTimers();
        prologueLayer.classList.remove('visible');
        prologueText.classList.remove('visible');
        prologueText.classList.add('hidden');
        prologueSkip.classList.remove('visible');
        prologueEnd.classList.remove('visible');
    }

    // ============================================================
    // 游戏介绍
    // ============================================================
    function openIntro() {
        introLayer.classList.add('visible');
    }

    function closeIntro() {
        introLayer.classList.remove('visible');
    }

    // ============================================================
    // 新建/编辑 选择弹窗
    // ============================================================
    function openActionMenu() {
        actionOverlay.classList.add('visible');
    }

    function closeActionMenu() {
        actionOverlay.classList.remove('visible');
    }

    function openEditSelect() {
        closeActionMenu();
        editSelectList.innerHTML = '';
        if (conversations.length === 0) {
            editSelectList.innerHTML = '<div class="expand-empty" style="text-align:center;padding:12px 0;">还没有对话</div>';
        } else {
            conversations.forEach((conv) => {
                const item = document.createElement('button');
                item.className = 'edit-select-item';
                item.type = 'button';
                const eraName = getEraName(conv.era);
                const stateName = getStateName(conv.worldState);
                const diffName = DIFFICULTY_LABELS[conv.difficulty] || '';
                const tag = [diffName, eraName, stateName].filter(Boolean).join('·');
                item.innerHTML = '<span class="es-name">' + escapeHtml(conv.name) + '</span><span class="es-tag">' + escapeHtml(tag) + '</span>';
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeEditSelect();
                    openEditDialog(conv.id);
                });
                editSelectList.appendChild(item);
            });
        }
        editSelectOverlay.classList.add('visible');
    }

    function closeEditSelect() {
        editSelectOverlay.classList.remove('visible');
    }

    // ============================================================
    // 编辑弹窗
    // ============================================================
    function openEditDialog(convId) {
        const conv = conversations.find((c) => c.id === convId);
        if (!conv) return;
        editingConvId = convId;

        editNameInput.value = conv.name;
        editNameInput.style.borderColor = '';

        editDiffOptions.querySelectorAll('.edit-option').forEach((btn) => {
            btn.classList.toggle('selected', btn.getAttribute('data-value') === conv.difficulty);
        });

        const eraName = getEraName(conv.era) || '—';
        const stateName = getStateName(conv.worldState) || '—';
        editEraReadonly.innerHTML = '<span class="edit-readonly-tag">' + escapeHtml(eraName) + '</span>';
        editStateReadonly.innerHTML = '<span class="edit-readonly-tag">' + escapeHtml(stateName) + '</span>';

        editOverlay.classList.add('visible');
    }

    function closeEditDialog() {
        editOverlay.classList.remove('visible');
        editingConvId = null;
    }

    function saveEditDialog() {
        const conv = conversations.find((c) => c.id === editingConvId);
        if (!conv) return;

        const name = editNameInput.value.trim();
        if (!name) {
            editNameInput.style.borderColor = '#e74c3c';
            setTimeout(() => { editNameInput.style.borderColor = ''; }, 600);
            return;
        }

        conv.name = name;
        const sel = editDiffOptions.querySelector('.edit-option.selected');
        if (sel) conv.difficulty = sel.getAttribute('data-value');

        saveConversations(conversations);
        closeEditDialog();
        renderConversations();
    }

    function deleteConv() {
        const conv = conversations.find((c) => c.id === editingConvId);
        if (!conv) return;
        if (!confirm('确定要删除「' + conv.name + '」吗？此操作不可恢复。')) return;
        conversations = conversations.filter((c) => c.id !== editingConvId);
        saveConversations(conversations);
        closeEditDialog();
        renderConversations();
    }

    // ============================================================
    // Wizard
    // ============================================================
    function openWizard() {
        wizardName = '';
        wizardDiff = '';
        wizardEra = '';
        wizardState = '';
        wizardNameInput.value = '';
        showWizardStep('name');
        wizardOverlay.classList.add('visible');
        setTimeout(() => wizardNameInput.focus(), 100);
    }

    function closeWizard() {
        wizardOverlay.classList.remove('visible');
        wizardNameInput.blur();
    }

    function showWizardStep(step) {
        wizardStepName.style.display = step === 'name' ? 'flex' : 'none';
        wizardStepDiff.style.display = step === 'diff' ? 'flex' : 'none';
        wizardStepEra.style.display = step === 'era' ? 'flex' : 'none';
        wizardStepState.style.display = step === 'state' ? 'flex' : 'none';

        if (step === 'era') renderEraOptions();
        if (step === 'state') renderStateOptions();
    }

    function renderEraOptions() {
        const cfg = window.WORLD_OPTIONS && window.WORLD_OPTIONS.era;
        if (!cfg) return;
        wizardEraTitle.textContent = '选择' + (cfg.title || '时代');
        wizardEraOptions.innerHTML = '';
        cfg.options.forEach((opt) => {
            const btn = document.createElement('button');
            btn.className = 'wizard-option' + (wizardEra === opt.id ? ' selected' : '');
            btn.type = 'button';
            btn.setAttribute('data-value', opt.id);
            btn.innerHTML = '<span class="opt-name">' + escapeHtml(opt.name) + '</span>';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                wizardEra = opt.id;
                renderEraOptions();
            });
            wizardEraOptions.appendChild(btn);
        });
    }

    function renderStateOptions() {
        const cfg = window.WORLD_OPTIONS && window.WORLD_OPTIONS.state;
        if (!cfg) return;
        wizardStateTitle.textContent = '选择' + (cfg.title || '状态');
        wizardStateOptions.innerHTML = '';
        cfg.options.forEach((opt) => {
            const btn = document.createElement('button');
            btn.className = 'wizard-option' + (wizardState === opt.id ? ' selected' : '');
            btn.type = 'button';
            btn.setAttribute('data-value', opt.id);
            btn.innerHTML = '<span class="opt-name">' + escapeHtml(opt.name) + '</span>';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                wizardState = opt.id;
                renderStateOptions();
            });
            wizardStateOptions.appendChild(btn);
        });
    }

    function wizardNameNextStep() {
        const name = wizardNameInput.value.trim();
        if (!name) {
            wizardNameInput.style.borderColor = '#e74c3c';
            setTimeout(() => { wizardNameInput.style.borderColor = ''; }, 600);
            return;
        }
        wizardName = name;
        showWizardStep('diff');
    }

    function wizardDiffNextStep() {
        if (!wizardDiff) {
            wizardDiff = 'normal';
        }
        showWizardStep('era');
    }

    function wizardEraNextStep() {
        if (!wizardEra) {
            const cfg = window.WORLD_OPTIONS && window.WORLD_OPTIONS.era;
            if (cfg && cfg.options.length) wizardEra = cfg.options[0].id;
        }
        showWizardStep('state');
    }

    function wizardFinish() {
        if (!wizardState) {
            const cfg = window.WORLD_OPTIONS && window.WORLD_OPTIONS.state;
            if (cfg && cfg.options.length) wizardState = cfg.options[0].id;
        }

        const state = newConvState();
        const opening = getOpening(wizardEra, wizardState);
        if (opening) {
            state.history.push({ role: 'ai', text: opening });
            state.logs.push({ role: 'assistant', content: JSON.stringify({ narrator: opening }) });
        }

        const conv = {
            id: 'conv_' + Date.now(),
            name: wizardName,
            difficulty: wizardDiff,
            era: wizardEra,
            worldState: wizardState,
            faved: false,
            state: state,
        };

        conversations.push(conv);
        saveConversations(conversations);
        closeWizard();
        renderConversations();
        openConversation(conv.id);
    }

    function getOpening(eraId, stateId) {
        const w = window.WORLD_OPTIONS;
        if (!w) return '';
        const key = eraId + '_' + stateId;
        if (w.openings && w.openings[key]) return w.openings[key];
        if (stateId === 'none') {
            const eraOpt = w.era && w.era.options.find((o) => o.id === eraId);
            if (eraOpt && eraOpt.opening) return eraOpt.opening;
        }
        return '';
    }

    function openConversation(id) {
        const conv = conversations.find((c) => c.id === id);
        if (!conv) return;
        enterDialogScreen(conv);
    }

    // ============================================================
    // 日记（翻页）
    // ============================================================
    function renderDiaries() {
        const conv = getCurrentConv();
        if (!conv) return;
        const list = conv.state.diaries || [];
        const total = list.length;

        if (total === 0) {
            diaryDayLabel.textContent = '—';
            diaryContent.textContent = '还没有日记';
            diaryPageNum.textContent = '— / —';
            diaryPrevBtn.disabled = true;
            diaryNextBtn.disabled = true;
            return;
        }

        if (diaryPage < 0) diaryPage = 0;
        if (diaryPage >= total) diaryPage = total - 1;

        const d = list[diaryPage];
        diaryDayLabel.textContent = '第' + d.day + '天';
        diaryContent.textContent = d.text;
        diaryPageNum.textContent = (diaryPage + 1) + ' / ' + total;

        diaryPrevBtn.disabled = (diaryPage === 0);
        diaryNextBtn.disabled = (diaryPage === total - 1);
    }

    function diaryPrev() {
        if (diaryPage > 0) {
            diaryPage--;
            renderDiaries();
        }
    }

    function diaryNext() {
        const conv = getCurrentConv();
        if (!conv) return;
        const total = (conv.state.diaries || []).length;
        if (diaryPage < total - 1) {
            diaryPage++;
            renderDiaries();
        }
    }

    // ============================================================
    // 地图（拖动 + 缩放）
    // ============================================================
    const MAP_UNIT_SIZE = 20;
    const MAP_MIN_SCALE = 0.2;
    const MAP_MAX_SCALE = 5;

    function renderMap() {
        const conv = getCurrentConv();
        if (!conv) return;

        const scale = MAP_UNIT_SIZE * mapScale;

        // viewport 整体位移 + 缩放
        mapViewport.style.transform =
            'translate(' + (-mapOffsetX * scale) + 'px, ' + (mapOffsetY * scale) + 'px) scale(' + mapScale + ')';

        // 网格大小
        const gridEl = mapViewport.querySelector('.map-grid');
        if (gridEl) {
            gridEl.style.backgroundSize = MAP_UNIT_SIZE + 'px ' + MAP_UNIT_SIZE + 'px';
        }

        // 比例尺
        const km = 40 / scale;
        let scaleLabel;
        if (km >= 1) {
            scaleLabel = km.toFixed(km >= 10 ? 0 : 1) + ' km';
        } else {
            scaleLabel = Math.round(km * 1000) + ' m';
        }
        mapScaleText.textContent = scaleLabel;

        // 画点
        mapPoints.innerHTML = '';
        const places = conv.state.savedPlaces || [];
        const cur = conv.state.currentPos || { x: 0, y: 0 };

        function toPx(x, y) {
            return {
                px: (x - mapOffsetX) * MAP_UNIT_SIZE,
                py: -(y - mapOffsetY) * MAP_UNIT_SIZE,
            };
        }

        places.forEach((p) => {
            const pos = toPx(p.x, p.y);
            const dot = document.createElement('div');
            dot.className = 'map-point';
            dot.style.left = pos.px + 'px';
            dot.style.top = pos.py + 'px';
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm('删除地点「' + p.name + '」？')) return;
                const idx = conv.state.savedPlaces.indexOf(p);
                if (idx >= 0) {
                    conv.state.savedPlaces.splice(idx, 1);
                    saveConversations(conversations);
                    renderMap();
                }
            });
            mapPoints.appendChild(dot);

            const label = document.createElement('div');
            label.className = 'map-point-label';
            label.style.left = pos.px + 'px';
            label.style.top = pos.py + 'px';
            label.textContent = p.name + '(' + p.x + ',' + p.y + ')';
            mapPoints.appendChild(label);
        });

        const curPos = toPx(cur.x, cur.y);
        const curDot = document.createElement('div');
        curDot.className = 'map-point current';
        curDot.style.left = curPos.px + 'px';
        curDot.style.top = curPos.py + 'px';
        mapPoints.appendChild(curDot);
    }

    function mapZoom(delta) {
        mapScale = Math.max(MAP_MIN_SCALE, Math.min(MAP_MAX_SCALE, mapScale * delta));
        renderMap();
    }

    function initMapDrag() {
        mapArea.addEventListener('mousedown', startMapDrag);
        mapArea.addEventListener('mousemove', moveMapDrag);
        mapArea.addEventListener('mouseup', endMapDrag);
        mapArea.addEventListener('mouseleave', endMapDrag);

        mapArea.addEventListener('touchstart', startMapDrag, { passive: true });
        mapArea.addEventListener('touchmove', moveMapDrag, { passive: false });
        mapArea.addEventListener('touchend', endMapDrag);
        mapArea.addEventListener('touchcancel', endMapDrag);
    }

    function getMapPointer(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    }

    function startMapDrag(e) {
        if (e.target.closest('.map-zoom')) return;
        if (e.target.classList && e.target.classList.contains('map-point')) return;
        const p = getMapPointer(e);
        mapDragging = true;
        mapDragStartX = p.x;
        mapDragStartY = p.y;
        mapDragStartOffsetX = mapOffsetX;
        mapDragStartOffsetY = mapOffsetY;
    }

    function moveMapDrag(e) {
        if (!mapDragging) return;
        if (e.cancelable) e.preventDefault();
        const p = getMapPointer(e);
        const dx = (p.x - mapDragStartX) / (MAP_UNIT_SIZE * mapScale);
        const dy = (p.y - mapDragStartY) / (MAP_UNIT_SIZE * mapScale);
        mapOffsetX = mapDragStartOffsetX - dx;
        mapOffsetY = mapDragStartOffsetY + dy;
        renderMap();
    }

    function endMapDrag() {
        mapDragging = false;
    }

    // ============================================================
    // 背包（含物资存放点）
    // ============================================================
    function renderBag() {
        const conv = getCurrentConv();
        if (!conv) return;

        // === 背包 ===
        const inv = conv.state.inventory || [];
        const sel = conv.state.selected || [];

        if (sel.length === 0) {
            bagCurrent.textContent = '当前：空手';
        } else {
            const names = sel.map((id) => {
                const item = inv.find((x) => x.id === id);
                if (!item) return '';
                return item.name + (item.count > 1 ? '×' + item.count : '');
            }).filter(Boolean);
            bagCurrent.textContent = '当前：' + names.join('、');
        }

        bagList.innerHTML = '';
        if (inv.length === 0) {
            bagList.innerHTML = '<div class="bag-empty">背包空空如也</div>';
        } else {
            inv.forEach((item) => {
                const card = createBagCard(item, sel.indexOf(item.id) >= 0, 'bag');
                bagList.appendChild(card);
            });
        }

        // === 物资存放点 ===
        const storage = conv.state.storage;
        const storageItems = conv.state.storageItems || [];
        const cur = conv.state.currentPos || { x: 0, y: 0 };

        const atStorage = storage && storage.x === cur.x && storage.y === cur.y;

        if (storage) {
            storageTitle.textContent = '📦 ' + storage.name + ' (' + storage.x + ',' + storage.y + ')';
        } else {
            storageTitle.textContent = '📦 物资存放点';
        }

        if (!storage) {
            storageCurrent.textContent = '未设置';
            storageList.innerHTML = '<div class="bag-empty">未设置物资存放点</div>';
            storageTitle.classList.add('storage-disabled');
            storageCurrent.classList.add('storage-disabled');
            storageList.classList.add('storage-disabled');
            return;
        }

        if (atStorage) {
            storageCurrent.textContent = '可存取';
            storageTitle.classList.remove('storage-disabled');
            storageCurrent.classList.remove('storage-disabled');
            storageList.classList.remove('storage-disabled');
        } else {
            storageCurrent.textContent = '需在存放点位置才能存取';
            storageTitle.classList.add('storage-disabled');
            storageCurrent.classList.add('storage-disabled');
            storageList.classList.add('storage-disabled');
        }

        storageList.innerHTML = '';
        if (storageItems.length === 0) {
            storageList.innerHTML = '<div class="bag-empty">空</div>';
        } else {
            storageItems.forEach((item) => {
                const card = createBagCard(item, false, 'storage');
                storageList.appendChild(card);
            });
        }
    }

    function createBagCard(item, selected, source) {
        const card = document.createElement('div');
        card.className = 'bag-card' + (selected ? ' selected' : '');
        card.setAttribute('data-id', item.id);
        card.setAttribute('data-source', source);

        const icon = item.type === 'tool' ? '🔧' : '📦';

        let html = '<div class="bag-card-icon">' + icon + '</div>';
        html += '<div class="bag-card-name">' + escapeHtml(item.name) + '</div>';

        if (item.type === 'tool') {
            const cur2 = typeof item.durability === 'number' ? item.durability : 0;
            const max = typeof item.maxDurability === 'number' ? item.maxDurability : 100;
            const pct = max > 0 ? Math.max(0, Math.min(100, (cur2 / max) * 100)) : 0;
            html += '<div class="bag-card-count">' + cur2 + '/' + max + '</div>';
            html += '<div class="bag-card-bar"><div style="width:' + pct + '%;background:#9b59b6"></div></div>';
        } else {
            html += '<div class="bag-card-count">×' + (item.count || 1) + '</div>';
        }

        card.innerHTML = html;

        let pressTimer = null;
        let longPressed = false;

        const startPress = () => {
            longPressed = false;
            pressTimer = setTimeout(() => {
                longPressed = true;
                onLongPress(item, source);
            }, 600);
        };

        const cancelPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        };

        card.addEventListener('mousedown', startPress);
        card.addEventListener('mouseup', cancelPress);
        card.addEventListener('mouseleave', cancelPress);
        card.addEventListener('touchstart', startPress, { passive: true });
        card.addEventListener('touchend', cancelPress);
        card.addEventListener('touchcancel', cancelPress);

        card.addEventListener('click', (e) => {
            e.stopPropagation();
            if (longPressed) {
                longPressed = false;
                return;
            }
            if (source === 'bag') {
                toggleSelect(item.id);
            }
        });

        return card;
    }

    function toggleSelect(itemId) {
        const conv = getCurrentConv();
        if (!conv) return;
        if (!Array.isArray(conv.state.selected)) conv.state.selected = [];
        const idx = conv.state.selected.indexOf(itemId);
        if (idx >= 0) {
            conv.state.selected.splice(idx, 1);
        } else {
            conv.state.selected.push(itemId);
        }
        saveConversations(conversations);
        renderBag();
    }

    // 长按
    function onLongPress(item, source) {
        const conv = getCurrentConv();
        if (!conv) return;

        if (source === 'bag') {
            if (!conv.state.storage) {
                showItemAction('未设置物资存放点，无法存入', null);
                return;
            }
            const cur = conv.state.currentPos || { x: 0, y: 0 };
            const s = conv.state.storage;
            if (s.x !== cur.x || s.y !== cur.y) {
                showItemAction('需要站在存放点位置才能存入', null);
                return;
            }
            longPressItem = item;
            longPressSource = 'bag';
            showItemAction('存入「' + s.name + '」？', () => {
                const inv = conv.state.inventory;
                const idx = inv.indexOf(item);
                if (idx >= 0) inv.splice(idx, 1);
                const si = conv.state.selected.indexOf(item.id);
                if (si >= 0) conv.state.selected.splice(si, 1);

                const existing = conv.state.storageItems.find((x) => x.name === item.name && x.type === item.type);
                if (existing) {
                    existing.count = (existing.count || 1) + (item.count || 1);
                } else {
                    conv.state.storageItems.push(item);
                }

                saveConversations(conversations);
                renderBag();
            });
        } else if (source === 'storage') {
            const cur = conv.state.currentPos || { x: 0, y: 0 };
            const s = conv.state.storage;
            if (!s || s.x !== cur.x || s.y !== cur.y) {
                showItemAction('需要站在存放点位置才能取出', null);
                return;
            }
            longPressItem = item;
            longPressSource = 'storage';
            showItemAction('取回背包？', () => {
                const sInv = conv.state.storageItems;
                const idx = sInv.indexOf(item);
                if (idx >= 0) sInv.splice(idx, 1);

                const existing = conv.state.inventory.find((x) => x.name === item.name && x.type === item.type);
                if (existing) {
                    existing.count = (existing.count || 1) + (item.count || 1);
                } else {
                    conv.state.inventory.push(item);
                }

                saveConversations(conversations);
                renderBag();
            });
        }
    }

    function showItemAction(title, onOk) {
        itemActionTitle.textContent = title;
        if (onOk) {
            itemActionOk.style.display = 'block';
            itemActionOk.onclick = (e) => {
                e.stopPropagation();
                onOk();
                closeItemAction();
            };
        } else {
            itemActionOk.style.display = 'none';
        }
        itemActionOverlay.classList.add('visible');
    }

    function closeItemAction() {
        itemActionOverlay.classList.remove('visible');
        longPressItem = null;
        longPressSource = null;
    }

    // ============================================================
    // 记录地点
    // ============================================================
    function openRecordDialog() {
        const conv = getCurrentConv();
        if (!conv) return;
        const p = conv.state.currentPos || { x: 0, y: 0 };
        recordPos.textContent = '当前位置：(' + p.x + ', ' + p.y + ')';
        recordInput.value = '';
        recordSetStorage.checked = false;
        recordOverlay.classList.add('visible');
        setTimeout(() => recordInput.focus(), 100);
    }

    function closeRecordDialog() {
        recordOverlay.classList.remove('visible');
        recordInput.blur();
    }

    function confirmRecord() {
        const conv = getCurrentConv();
        if (!conv) return;
        const name = recordInput.value.trim();
        if (!name) {
            recordInput.style.borderColor = '#e74c3c';
            setTimeout(() => { recordInput.style.borderColor = ''; }, 600);
            return;
        }
        const p = conv.state.currentPos || { x: 0, y: 0 };
        const exist = conv.state.savedPlaces.find((x) => x.name === name);
        if (exist) {
            exist.x = p.x;
            exist.y = p.y;
        } else {
            conv.state.savedPlaces.push({ name: name, x: p.x, y: p.y });
        }

        if (recordSetStorage.checked) {
            conv.state.storage = { name: name, x: p.x, y: p.y };
        }

        saveConversations(conversations);
        closeRecordDialog();
        renderMap();
        renderBag();
    }

    // ============================================================
    // 拾取
    // ============================================================
    function showPickupDialog(items) {
        pendingPickups = items || [];
        renderPickupList();
        pickupOverlay.classList.add('visible');
    }

    function renderPickupList() {
        pickupList.innerHTML = '';
        pendingPickups.forEach((item, idx) => {
            const btn = document.createElement('button');
            btn.className = 'pickup-item';
            btn.type = 'button';
            const tag = item.type === 'tool' ? '工具' : '物品';
            btn.innerHTML = '<span class="pi-name">' + escapeHtml(item.name) + ' ×' + (item.count || 1) + '</span><span class="pi-tag">' + tag + '</span>';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                pickupItem(idx);
            });
            pickupList.appendChild(btn);
        });
    }

    function closePickupDialog() {
        pickupOverlay.classList.remove('visible');
        pendingPickups = [];
    }

    function pickupItem(idx) {
        const conv = getCurrentConv();
        if (!conv) return;
        const item = pendingPickups[idx];
        if (!item) return;

        const inv = conv.state.inventory || [];
        const existing = inv.find((x) => x.name === item.name && x.type === item.type);
        if (existing) {
            existing.count = (existing.count || 1) + (item.count || 1);
        } else {
            const newItem = {
                id: genId('item_'),
                name: item.name,
                type: item.type === 'tool' ? 'tool' : 'item',
                count: item.count || 1,
            };
            if (newItem.type === 'tool') {
                newItem.durability = typeof item.durability === 'number' ? item.durability : 100;
                newItem.maxDurability = typeof item.maxDurability === 'number' ? item.maxDurability : 100;
            }
            inv.push(newItem);
        }
        conv.state.inventory = inv;
        saveConversations(conversations);
        renderBag();

        pendingPickups.splice(idx, 1);

        if (pendingPickups.length === 0) {
            closePickupDialog();
        } else {
            renderPickupList();
        }
    }

    // ============================================================
    // 日记总结
    // ============================================================
    async function triggerDiarySummary(conv) {
        const day = getDay(conv.state.gameSeconds);
        const summaryDay = day - 1;
        if (summaryDay < 0) return;
        if (conv.state.diaries && conv.state.diaries.some((d) => d.day === summaryDay)) return;

        const cfg = loadConfig();
        if (!cfg.apiKey || !cfg.baseURL || !cfg.model) return;

        const prompt = '请用最简短的几句话总结游戏第 ' + summaryDay + ' 天发生的事（要点齐全：主要事件、状态变化、重要节点）。只输出纯文本，不要 JSON，不要 markdown。';

        try {
            const res = await fetch(cfg.baseURL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + cfg.apiKey,
                },
                body: JSON.stringify({
                    model: cfg.model,
                    messages: [
                        { role: 'system', content: '你是游戏日志记录员，只输出简短的日记总结。' },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.5,
                    max_tokens: 200,
                    stream: false,
                }),
            });
            const data = await res.json();
            const text = data.choices && data.choices[0] && data.choices[0].message
                ? data.choices[0].message.content.trim()
                : '';
            if (text) {
                conv.state.diaries.push({ day: summaryDay, text: text });
                saveConversations(conversations);
                if (currentConvId === conv.id) {
                    diaryPage = conv.state.diaries.length - 1;
                    renderDiaries();
                }
            }
        } catch (e) {
            // 静默失败
        }
    }

    // ============================================================
    // 发送策略
    // ============================================================
    function shouldSendFull(round) {
        if (round < 5) return true;
        if (round % 10 === 0) return true;
        return false;
    }

    // ============================================================
    // AI 调用
    // ============================================================
    function buildSystemPrompt(conv, isFull) {
        if (!isFull) {
            return OUTPUT_PROTOCOL;
        }

        const diffLine = '【难度】\n' + (DIFFICULTY_PROMPTS[conv.difficulty] || DIFFICULTY_PROMPTS.normal);

        let eraLine = '';
        const eraCfg = window.WORLD_OPTIONS && window.WORLD_OPTIONS.era;
        if (eraCfg && conv.era) {
            const opt = eraCfg.options.find((o) => o.id === conv.era);
            if (opt && opt.prompt) eraLine = '【时代】\n' + opt.prompt;
        }

        let stateLine = '';
        const stateCfg = window.WORLD_OPTIONS && window.WORLD_OPTIONS.state;
        if (stateCfg && conv.worldState) {
            const opt = stateCfg.options.find((o) => o.id === conv.worldState);
            if (opt && opt.prompt) stateLine = '【状态】\n' + opt.prompt;
        }

        const extra = [diffLine, eraLine, stateLine].filter(Boolean).join('\n\n');

        const p = conv.state.currentPos || { x: 0, y: 0 };
        const places = conv.state.savedPlaces || [];
        let placesText = '';
        if (places.length > 0) {
            placesText = '\n已记录地点：\n' + places.map((pl) => '- ' + pl.name + ' (' + pl.x + ', ' + pl.y + ')').join('\n');
        }
        const coordInfo = '【当前坐标】\n位置：(' + p.x + ', ' + p.y + ')' + placesText;

        const inv = conv.state.inventory || [];
        let bagText = '（空）';
        if (inv.length > 0) {
            bagText = inv.map((item) => {
                if (item.type === 'tool') {
                    const dur = (typeof item.durability === 'number' ? item.durability : 0) + '/' +
                                (typeof item.maxDurability === 'number' ? item.maxDurability : 100);
                    return item.name + '（工具，耐久 ' + dur + '）';
                }
                return item.name + ' ×' + (item.count || 1);
            }).join('\n');
        }
        const bagInfo = '【背包】\n' + bagText;

        let storageText = '（未设置）';
        if (conv.state.storage) {
            const s = conv.state.storage;
            const sItems = conv.state.storageItems || [];
            let itemsText = '（空）';
            if (sItems.length > 0) {
                itemsText = sItems.map((item) => {
                    if (item.type === 'tool') {
                        const dur = (typeof item.durability === 'number' ? item.durability : 0) + '/' +
                                    (typeof item.maxDurability === 'number' ? item.maxDurability : 100);
                        return item.name + '（工具，耐久 ' + dur + '）';
                    }
                    return item.name + ' ×' + (item.count || 1);
                }).join('\n');
            }
            storageText = s.name + ' (' + s.x + ',' + s.y + ')\n' + itemsText;
        }
        const storageInfo = '【物资存放点】\n' + storageText;

        return CORE_RULES + '\n\n' + extra + '\n\n' + coordInfo + '\n\n' + bagInfo + '\n\n' + storageInfo + '\n\n' + OUTPUT_PROTOCOL;
    }

    function buildStateSnapshot(conv) {
        const s = conv.state.stats;
        const p = conv.state.currentPos || { x: 0, y: 0 };
        const sel = conv.state.selected || [];
        const inv = conv.state.inventory || [];

        let selText = '空手';
        if (sel.length > 0) {
            selText = sel.map((id) => {
                const item = inv.find((x) => x.id === id);
                if (!item) return '';
                return item.name + (item.count > 1 ? '×' + item.count : '');
            }).filter(Boolean).join('、');
        }

        return '【当前状态】\n' +
            '天数：' + getDay(conv.state.gameSeconds) + '\n' +
            '游戏时间：' + formatGameTime(conv.state.gameSeconds) + '\n' +
            '位置：(' + p.x + ', ' + p.y + ')\n' +
            '状态：生命' + s.hp + ' 饱食' + s.food + ' 水分' + s.water + ' 体力' + s.stamina + '\n' +
            '选中：' + selText;
    }

    async function callAIStream(conv, userText, onDelta) {
        const cfg = loadConfig();
        if (!cfg.apiKey) throw new Error('请先在设置中填写 API Key');
        if (!cfg.baseURL) throw new Error('请先在设置中填写接口地址');
        if (!cfg.model) throw new Error('请先在设置中填写模型名');

        const isFull = shouldSendFull(conv.state.round);
        const systemPrompt = buildSystemPrompt(conv, isFull);
        const recentLogs = conv.state.logs.slice(-HISTORY_LIMIT);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...recentLogs,
            { role: 'user', content: userText + '\n' + buildStateSnapshot(conv) },
        ];

        if (conv.state.frozen && conv.state.frozenRounds > 3) {
            messages.push({
                role: 'user',
                content: '【系统提示】你已连续冻结时间超过 3 轮。请确认当前场景是否仍需暂停时间。如仍需暂停，请继续返回 time_freeze: true；否则请省略该字段或返回 false。'
            });
            conv.state.frozenRounds = 0;
        }

        const res = await fetch(cfg.baseURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + cfg.apiKey,
            },
            body: JSON.stringify({
                model: cfg.model,
                messages: messages,
                temperature: TEMPERATURE,
                max_tokens: 1500,
                stream: true,
            }),
        });

        if (!res.ok) {
            let msg = '请求失败 HTTP ' + res.status;
            try {
                const errData = await res.json();
                if (errData && errData.error) {
                    msg = typeof errData.error === 'string' ? errData.error : (errData.error.message || JSON.stringify(errData.error));
                }
            } catch (e) {}
            throw new Error(msg);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (dataStr === '[DONE]') continue;
                try {
                    const json = JSON.parse(dataStr);
                    const delta = json.choices && json.choices[0] && json.choices[0].delta;
                    if (delta && delta.content) {
                        fullText += delta.content;
                        if (onDelta) onDelta(fullText, delta.content);
                    }
                } catch (e) {}
            }
        }

        return fullText;
    }

    // ============================================================
    // JSON 解析与本地结算
    // ============================================================
    function parseAIOutput(text) {
        if (!text) return null;
        let s = String(text).trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start >= 0 && end > start) s = s.slice(start, end + 1);

        try { return JSON.parse(s); } catch (e) {}

        let fixed = s.replace(/([:,\[])\s*\+(\d+(?:\.\d+)?)/g, '$1 $2');
        try { return JSON.parse(fixed); } catch (e) {}

        fixed = fixed.replace(/,\s*([}\]])/g, '$1');
        try { return JSON.parse(fixed); } catch (e) {}

        fixed = fixed.replace(/'/g, '"');
        try { return JSON.parse(fixed); } catch (e) {}

        return null;
    }

    function applyAIResult(conv, parsed) {
        if (parsed.stats && typeof parsed.stats === 'object') {
            for (const key of STAT_KEYS) {
                const delta = parsed.stats[key];
                if (typeof delta === 'number') {
                    conv.state.stats[key] = clamp(conv.state.stats[key] + delta, 0, 100);
                }
            }
        }

        if (typeof parsed.time_delta === 'number') {
            conv.state.gameSeconds += Math.round(parsed.time_delta) * 60;
        }

        if (parsed.time_freeze === true) {
            conv.state.frozen = true;
            conv.state.frozenRounds = (conv.state.frozenRounds || 0) + 1;
        } else {
            conv.state.frozen = false;
            conv.state.frozenRounds = 0;
        }

        if (parsed.move && typeof parsed.move === 'object') {
            const dx = typeof parsed.move.dx === 'number' ? parsed.move.dx : 0;
            const dy = typeof parsed.move.dy === 'number' ? parsed.move.dy : 0;
            conv.state.currentPos.x += Math.round(dx);
            conv.state.currentPos.y += Math.round(dy);
        }

        if (Array.isArray(parsed.consume)) {
            const inv = conv.state.inventory || [];
            parsed.consume.forEach((c) => {
                if (!c || typeof c.name !== 'string') return;
                const count = typeof c.count === 'number' ? Math.max(1, Math.round(c.count)) : 1;
                const item = inv.find((x) => x.name === c.name);
                if (!item) return;
                item.count = (item.count || 1) - count;
                if (item.count <= 0) {
                    const idx = inv.indexOf(item);
                    if (idx >= 0) inv.splice(idx, 1);
                    const si = conv.state.selected.indexOf(item.id);
                    if (si >= 0) conv.state.selected.splice(si, 1);
                }
            });
        }

        if (Array.isArray(parsed.durability_cost)) {
            const inv = conv.state.inventory || [];
            parsed.durability_cost.forEach((c) => {
                if (!c || typeof c.name !== 'string') return;
                const amount = typeof c.amount === 'number' ? Math.max(0, Math.round(c.amount)) : 0;
                const item = inv.find((x) => x.name === c.name && x.type === 'tool');
                if (!item) return;
                item.durability = Math.max(0, (item.durability || 0) - amount);
                if (item.durability <= 0) {
                    const idx = inv.indexOf(item);
                    if (idx >= 0) inv.splice(idx, 1);
                    const si = conv.state.selected.indexOf(item.id);
                    if (si >= 0) conv.state.selected.splice(si, 1);
                }
            });
        }

        if (Array.isArray(parsed.offer_pickup) && parsed.offer_pickup.length > 0 && parsed.inventory_full !== true) {
            showPickupDialog(parsed.offer_pickup);
        }

        conv.state.round += 1;
    }

    // ============================================================
    // 发送指令
    // ============================================================
    async function sendCommand(text) {
        if (busy) return;
        const cmd = (text || '').trim();
        if (!cmd) return;

        const conv = getCurrentConv();
        if (!conv) return;

        busy = true;
        dialogSendBtn.disabled = true;

        // 构造发给 AI 的消息（带物品前缀）
        const selectedItems = (conv.state.selected || []).map((id) => {
            const item = (conv.state.inventory || []).find((x) => x.id === id);
            if (!item) return null;
            return item.name + (item.count > 1 ? '×' + item.count : '');
        }).filter(Boolean);

        let messageToAI;
        if (selectedItems.length > 0) {
            messageToAI = '玩家想用 [' + selectedItems.join(']、[') + '] 进行 [' + cmd + ']';
        } else {
            messageToAI = '玩家想用 [空手且无工具和物品] 进行 [' + cmd + ']';
        }

        conv.state.history.push({ role: 'user', text: cmd });
        conv.state.logs.push({ role: 'user', content: messageToAI });
        appendMessage('user', cmd);

        const aiBubble = appendMessage('ai', '');

        try {
            let fullText = await callAIStream(conv, messageToAI, (full) => {
                const preview = extractNarratorPreview(full);
                aiBubble.textContent = preview || full;
                dialogLog.scrollTop = dialogLog.scrollHeight;
            });

            let parsed = parseAIOutput(fullText);
            let retried = 0;
            while (!parsed && retried < 2) {
                retried++;
                const feedback = '【系统提示】你上一条回复不是合法 JSON，游戏无法结算。请只输出一个合法 JSON 对象，不要任何其他文字或 markdown 围栏。';
                conv.state.logs.push({ role: 'assistant', content: fullText });
                conv.state.logs.push({ role: 'user', content: feedback });
                fullText = await callAIStream(conv, messageToAI, (full) => {
                    const preview = extractNarratorPreview(full);
                    aiBubble.textContent = preview || full;
                    dialogLog.scrollTop = dialogLog.scrollHeight;
                });
                conv.state.logs.pop();
                conv.state.logs.pop();
                parsed = parseAIOutput(fullText);
            }

            if (parsed) {
                applyAIResult(conv, parsed);

                const narrator = typeof parsed.narrator === 'string' ? parsed.narrator : fullText;
                aiBubble.textContent = narrator;
                conv.state.history.push({ role: 'ai', text: narrator });
                conv.state.logs.push({ role: 'assistant', content: JSON.stringify(parsed) });

                if (typeof parsed.event === 'string' && parsed.event) {
                    appendMessage('sys', parsed.event);
                    conv.state.history.push({ role: 'sys', text: parsed.event });
                }

                if (typeof parsed.diary === 'string' && parsed.diary.trim()) {
                    const day = getDay(conv.state.gameSeconds);
                    conv.state.diaries.push({ day: day, text: parsed.diary.trim() });
                }

                if (parsed.inventory_full === true) {
                    appendMessage('sys', '背包已满，无法拾取更多物品。');
                }

                renderStats();
                updateInfo();
                renderDiaries();
                renderBag();
                renderMap();
            } else {
                aiBubble.textContent = fullText || '（AI 未返回有效内容）';
                conv.state.history.push({ role: 'ai', text: fullText || '（AI 未返回有效内容）' });
                appendMessage('sys', '⚠️ AI 未按协议返回 JSON，本次未结算状态');
            }
        } catch (e) {
            aiBubble.textContent = '⚠️ ' + e.message;
            conv.state.history.push({ role: 'sys', text: '⚠️ ' + e.message });
        }

        saveConversations(conversations);
        busy = false;
        dialogSendBtn.disabled = false;
        dialogInput.value = '';
    }

    function extractNarratorPreview(full) {
        const m = full.match(/"narrator"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) {
            return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        return '';
    }

    // ============================================================
    // 设置
    // ============================================================
    function openSettings() {
        const cfg = loadConfig();
        settingsApiKey.value = cfg.apiKey;
        settingsBaseUrl.value = cfg.baseURL;
        settingsModel.value = cfg.model;
        settingsOverlay.classList.add('visible');
    }

    function closeSettings() {
        settingsOverlay.classList.remove('visible');
    }

    function saveSettings() {
        const cfg = {
            apiKey: settingsApiKey.value.trim(),
            baseURL: settingsBaseUrl.value.trim() || 'https://api.deepseek.com/chat/completions',
            model: settingsModel.value.trim() || 'deepseek-chat',
        };
        saveConfig(cfg);
        closeSettings();
    }

    // ============================================================
    // 初始化与事件绑定
    // ============================================================
    function init() {
        conversations = loadConversations();

        buildSplashText();
        buildStars();
        initMapDrag();
        splashLayer.style.display = 'flex';
        splashLayer.style.opacity = '1';
        void splashLayer.offsetHeight;
        setTimeout(startAnimationSequence, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 主界面
    startBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterSaveScreen();
    });

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings();
    });

    titleMain.addEventListener('click', (e) => {
        e.stopPropagation();
        startPrologue();
    });

    prologueLayer.addEventListener('click', (e) => {
        if (!prologuePlaying) return;
        if (e.target === prologueBackBtn) return;
        showPrologueEnd();
    });

    prologueBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closePrologue();
    });

    introBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openIntro();
    });

    introBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeIntro();
    });

    // 存档界面
    saveBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        backToMain();
    });

    saveAddCircle.addEventListener('click', (e) => {
        e.stopPropagation();
        openActionMenu();
    });

    actionCancelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeActionMenu();
    });

    actionOverlay.addEventListener('click', (e) => {
        if (e.target === actionOverlay) closeActionMenu();
    });

    actionNewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeActionMenu();
        openWizard();
    });

    actionEditBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditSelect();
    });

    editSelectCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        closeEditSelect();
    });

    editSelectOverlay.addEventListener('click', (e) => {
        if (e.target === editSelectOverlay) closeEditSelect();
    });

    editCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        closeEditDialog();
    });

    editOk.addEventListener('click', (e) => {
        e.stopPropagation();
        saveEditDialog();
    });

    editDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConv();
    });

    editOverlay.addEventListener('click', (e) => {
        if (e.target === editOverlay) closeEditDialog();
    });

    editDiffOptions.addEventListener('click', (e) => {
        const btn = e.target.closest('.edit-option');
        if (!btn) return;
        e.stopPropagation();
        editDiffOptions.querySelectorAll('.edit-option').forEach((b) => {
            b.classList.toggle('selected', b === btn);
        });
    });

    // Wizard
    wizardNameCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        closeWizard();
    });

    wizardNameNext.addEventListener('click', (e) => {
        e.stopPropagation();
        wizardNameNextStep();
    });

    wizardNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.stopPropagation();
            wizardNameNextStep();
        }
    });

    wizardDiffBack.addEventListener('click', (e) => {
        e.stopPropagation();
        showWizardStep('name');
    });

    wizardDiffNext.addEventListener('click', (e) => {
        e.stopPropagation();
        wizardDiffNextStep();
    });

    $('wizardDiffOptions').addEventListener('click', (e) => {
        const btn = e.target.closest('.wizard-option');
        if (!btn) return;
        e.stopPropagation();
        wizardDiff = btn.getAttribute('data-value');
        $('wizardDiffOptions').querySelectorAll('.wizard-option').forEach((b) => {
            b.classList.toggle('selected', b === btn);
        });
    });

    wizardEraBack.addEventListener('click', (e) => {
        e.stopPropagation();
        showWizardStep('diff');
    });

    wizardEraNext.addEventListener('click', (e) => {
        e.stopPropagation();
        wizardEraNextStep();
    });

    wizardStateBack.addEventListener('click', (e) => {
        e.stopPropagation();
        showWizardStep('era');
    });

    wizardStateCreate.addEventListener('click', (e) => {
        e.stopPropagation();
        wizardFinish();
    });

    wizardOverlay.addEventListener('click', (e) => {
        if (e.target === wizardOverlay) closeWizard();
    });

    // 对话界面
    dialogBackBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        backToSave();
    });

    document.querySelectorAll('.dialog-cmd-btn[data-cmd]').forEach((btn) => {
        const cmd = btn.getAttribute('data-cmd');
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            sendCommand(cmd);
        });
    });

    recordBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRecordDialog();
    });

    recordCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        closeRecordDialog();
    });

    recordOk.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmRecord();
    });

    recordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.stopPropagation();
            confirmRecord();
        }
    });

    recordOverlay.addEventListener('click', (e) => {
        if (e.target === recordOverlay) closeRecordDialog();
    });

    // 日记
    diaryToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !diaryPanel.classList.contains('open');
        mapPanel.classList.remove('open');
        mapToggleBtn.classList.remove('active');
        bagPanel.classList.remove('open');
        bagToggleBtn.classList.remove('active');
        if (willOpen) {
            diaryPanel.classList.add('open');
            diaryToggleBtn.classList.add('active');
            const conv = getCurrentConv();
            if (conv) {
                const total = (conv.state.diaries || []).length;
                if (total > 0) diaryPage = total - 1;
            }
            renderDiaries();
        } else {
            diaryPanel.classList.remove('open');
            diaryToggleBtn.classList.remove('active');
        }
    });

    diaryPrevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        diaryPrev();
    });

    diaryNextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        diaryNext();
    });

    // 地图
    mapToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !mapPanel.classList.contains('open');
        diaryPanel.classList.remove('open');
        diaryToggleBtn.classList.remove('active');
        bagPanel.classList.remove('open');
        bagToggleBtn.classList.remove('active');
        if (willOpen) {
            mapPanel.classList.add('open');
            mapToggleBtn.classList.add('active');
            renderMap();
        } else {
            mapPanel.classList.remove('open');
            mapToggleBtn.classList.remove('active');
        }
    });

    mapZoomIn.addEventListener('click', (e) => {
        e.stopPropagation();
        mapZoom(1.3);
    });

    mapZoomOut.addEventListener('click', (e) => {
        e.stopPropagation();
        mapZoom(1 / 1.3);
    });

    // 背包
    bagToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !bagPanel.classList.contains('open');
        diaryPanel.classList.remove('open');
        diaryToggleBtn.classList.remove('active');
        mapPanel.classList.remove('open');
        mapToggleBtn.classList.remove('active');
        if (willOpen) {
            bagPanel.classList.add('open');
            bagToggleBtn.classList.add('active');
            renderBag();
        } else {
            bagPanel.classList.remove('open');
            bagToggleBtn.classList.remove('active');
        }
    });

    // 拾取
    pickupSkip.addEventListener('click', (e) => {
        e.stopPropagation();
        closePickupDialog();
    });

    pickupOverlay.addEventListener('click', (e) => {
        if (e.target === pickupOverlay) closePickupDialog();
    });

    // 长按确认
    itemActionCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        closeItemAction();
    });

    itemActionOverlay.addEventListener('click', (e) => {
        if (e.target === itemActionOverlay) closeItemAction();
    });

    // 发送
    dialogSendBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sendCommand(dialogInput.value);
    });

    dialogInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.stopPropagation();
            sendCommand(dialogInput.value);
        }
    });

    // 设置
    settingsCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSettings();
    });

    settingsOk.addEventListener('click', (e) => {
        e.stopPropagation();
        saveSettings();
    });

    settingsOverlay.addEventListener('click', (e) => {
        if (e.target === settingsOverlay) closeSettings();
    });

})();
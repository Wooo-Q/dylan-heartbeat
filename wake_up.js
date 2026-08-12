require("dotenv").config();

// ========================
// Supabase 手机使用记录
// ========================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "phone_activity";

const fs = require("fs");
const path = require("path");
const { buildNtfyPayload } = require("./ntfy_priority");

const TIMELINE_PATH = path.join(__dirname, "enhanced_messages.json");

function stripPosition(messages) {
    return messages.map(({ position, ...rest }) => rest);
}

const PORT = Number(process.env.PORT) || 3000;
const GATEWAY_BASE_URL = (process.env.GATEWAY_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const GATEWAY_URL = `${GATEWAY_BASE_URL}/internal/wake-event`;
const HEARTBEAT_URL = `${GATEWAY_BASE_URL}/internal/heartbeat`;
const TIME_ZONE = process.env.TIME_ZONE || "Europe/London";
const WEATHER_TIMEOUT_MS = 5000;
const DIARY_DIR_NAME = process.env.DIARY_DIR || "diary";
const DIARY_DIR_PATH = path.isAbsolute(DIARY_DIR_NAME)
  ? DIARY_DIR_NAME
  : path.join(__dirname, DIARY_DIR_NAME);

function readNumberEnv(key, fallback, options = {}) {
  const value = Number(process.env[key]);
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  return fallback;
}

function readBooleanEnv(key, fallback = false) {
  const raw = String(process.env[key] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function getDatePartsInTimeZone(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute
  };
}

function getDiaryDateString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getDiaryTimeString(date = new Date()) {
  const parts = getDatePartsInTimeZone(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function extractDiaryFromResponse(text) {
  const diaryBlocks = [];
  const remainingText = String(text || "").replace(/\[DIARY\]([\s\S]*?)\[\/DIARY\]/gi, (_, content) => {
    const diary = String(content || "").trim();
    if (diary) diaryBlocks.push(diary);
    return "";
  }).trim();
  return {
    diaryContent: diaryBlocks.join("\n\n").trim(),
    remainingText
  };
}

function appendDiaryEntry(content) {
  if (!readBooleanEnv("DIARY_ENABLED", true)) {
    console.log("模型写了日记，但 DIARY_ENABLED=false，本次不保存");
    return false;
  }

  const cleanContent = String(content || "").trim();
  if (!cleanContent) return false;

  fs.mkdirSync(DIARY_DIR_PATH, { recursive: true });
  const diaryFile = path.join(DIARY_DIR_PATH, `${getDiaryDateString()}.md`);
  const entry = `\n\n## ${getDiaryTimeString()}\n\n${cleanContent}\n`;
  fs.appendFileSync(diaryFile, entry, "utf-8");
  console.log(`已保存日记：${diaryFile}`);
  return true;
}

async function sendPushNotification({ title, body }) {
  const provider = (process.env.PUSH_PROVIDER || "bark").trim().toLowerCase();

  if (provider === "ntfy") {
    const topic = String(process.env.NTFY_TOPIC || "").trim();
    if (!topic) return { ok: false, providerLabel: "ntfy", reason: "NTFY_TOPIC 未配置" };

    const server = (process.env.NTFY_SERVER_URL || "https://ntfy.sh").replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json"
    };
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;
    const payload = buildNtfyPayload({
      topic,
      title,
      message: body,
      priority: process.env.NTFY_PRIORITY,
      tags: process.env.NTFY_TAGS
    });

    const response = await fetch(server, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    if (!response.ok) {
      return { ok: false, providerLabel: "ntfy", reason: responseText || `HTTP ${response.status}` };
    }
    return { ok: true, providerLabel: "ntfy" };
  }

  if (provider !== "bark") {
    return { ok: false, providerLabel: provider || "未知渠道", reason: `不支持的 PUSH_PROVIDER：${provider}` };
  }

  if (!process.env.BARK_KEY) {
    return { ok: false, providerLabel: "Bark", reason: "Bark Key 未配置" };
  }

  const barkPayload = {
    title,
    body,
    device_key: process.env.BARK_KEY,
    icon: process.env.CUSTOM_ICON_URL
  };

  const response = await fetch("https://api.day.app/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(barkPayload)
  });

  const responseText = await response.text();
  let result = {};
  try {
    result = JSON.parse(responseText);
  } catch {}
  console.log("\nBark Result:\n", result || responseText);

  if (!response.ok || (result.code && result.code !== 200)) {
    return { ok: false, providerLabel: "Bark", reason: result.message || `HTTP ${response.status}` };
  }
  return { ok: true, providerLabel: "Bark" };
}

function isDayTime(date = new Date()) {
  const hour = date.getHours();
  const start = readNumberEnv("WAKE_DAY_START_HOUR", 10, { min: 0, max: 23 });
  const end = readNumberEnv("WAKE_DAY_END_HOUR", 24, { min: 1, max: 24 });
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

function getWakeAfterMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_WAKE_AFTER_MINUTES", 60, { min: 1 })
    : readNumberEnv("NIGHT_WAKE_AFTER_MINUTES", 120, { min: 1 });
}

function getCheckIntervalMinutes(date = new Date()) {
  return isDayTime(date)
    ? readNumberEnv("DAY_CHECK_INTERVAL_MINUTES", 10, { min: 1 })
    : readNumberEnv("NIGHT_CHECK_INTERVAL_MINUTES", 120, { min: 1 });
}

function normalizeContentToText(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";

  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
        if (type === "text" || type === "input_text") return part.text || part.content || "";
        if (part.image_url || type.includes("image")) return "[图片]";
        if (part.file || type.includes("file")) return "[文件]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    const type = typeof content.type === "string" ? content.type.toLowerCase() : "";
    if (content.image_url || type.includes("image")) return "[图片]";
    if (content.file || type.includes("file")) return "[文件]";
  }

  return "[非文本内容]";
}

function summarizeWakeMessages(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let chars = 0;
  for (const msg of list) {
    roles[msg?.role || ""] = (roles[msg?.role || ""] || 0) + 1;
    chars += normalizeContentToText(msg?.content).length;
  }
  return { total: list.length, roles, text_chars: chars };
}

function weatherCodeText(code) {
  const table = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "有雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "较强阵雨",
    82: "强阵雨",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹"
  };
  return table[code] || `天气代码 ${code}`;
}

async function fetchWeatherContext() {
  if (!readBooleanEnv("WEATHER_ENABLED", false)) return "";

  const lat = Number(process.env.WEATHER_LAT);
  const lon = Number(process.env.WEATHER_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.log("已启用 WEATHER_ENABLED，但 WEATHER_LAT / WEATHER_LON 未正确配置，跳过天气注入");
    return "";
  }

  const location = process.env.WEATHER_LOCATION_NAME || "当前位置";
  const units = (process.env.WEATHER_UNITS || "metric").trim().toLowerCase();
  const temperatureUnit = units === "fahrenheit" ? "fahrenheit" : "celsius";
  const windSpeedUnit = units === "fahrenheit" ? "mph" : "kmh";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "sunrise,sunset");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");
  url.searchParams.set("temperature_unit", temperatureUnit);
  url.searchParams.set("wind_speed_unit", windSpeedUnit);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const current = data.current || {};
    const daily = data.daily || {};
    const unitsInfo = data.current_units || {};
    const lines = [
      "## 天气信息",
      `- 位置：${location}`,
      `- 当前：${weatherCodeText(current.weather_code)}，${current.temperature_2m}${unitsInfo.temperature_2m || "°C"}，体感 ${current.apparent_temperature}${unitsInfo.apparent_temperature || "°C"}`,
      `- 湿度：${current.relative_humidity_2m}${unitsInfo.relative_humidity_2m || "%"}`,
      `- 降雨：${current.precipitation}${unitsInfo.precipitation || "mm"}`,
      `- 风速：${current.wind_speed_10m}${unitsInfo.wind_speed_10m || ""}`
    ];
    if (Array.isArray(daily.sunrise) && Array.isArray(daily.sunset)) {
      lines.push(`- 日出/日落：${daily.sunrise[0]} / ${daily.sunset[0]}`);
    }
    return lines.join("\n");
  } catch (err) {
    console.log("天气注入失败，跳过本次天气信息:", err.message);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function loadTimelineMessages() {
  if (!fs.existsSync(TIMELINE_PATH)) {
    console.log("未找到 enhanced_messages.json");
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(TIMELINE_PATH, "utf-8"));
    if (!Array.isArray(parsed)) {
      console.log("enhanced_messages.json 格式错误：顶层不是数组");
      return null;
    }
    return parsed;
  } catch (err) {
    console.error("读取 enhanced_messages.json 失败:", err.message);
    return null;
  }
}

function getNow() {
  return new Date();
}

function getChinaTimeString() {
  return new Date().toLocaleString("zh-CN", { timeZone: TIME_ZONE });
}

function getLocalTimeString() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function shouldWake(lastUserTime) {
  const now = getNow();
  const diffMinutes = Math.floor((now - new Date(lastUserTime)) / 1000 / 60);
  return diffMinutes >= getWakeAfterMinutes(now);
}

function parseTimelineTimestamp(value) {
    const text = String(value || "");
    const parts = text.split(/\n/)[0];
    const match = parts.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (!match) return null;
    const dateStr = `${match[1]}T${match[2]}:00`;
    const parsed = new Date(dateStr);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ====================================
// 获取手机使用记录（精简版）
// ====================================
async function fetchPhoneActivity() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.log("⚠️ Supabase 未配置，跳过手机使用记录");
        return null;
    }

    try {
        const TIME_ZONE = process.env.TIME_ZONE || "Asia/Shanghai";

        // 清洗 app_name（去掉 {"": "xxx"} 的格式）
        function cleanAppName(raw) {
            if (!raw) return raw;
            const match = raw.match(/"([^"]+)"\s*}$/);
            return match ? match[1] : raw;
        }

        // 只查询最近 5 条记录
        const recentUrl = `${SUPABASE_URL}/${SUPABASE_TABLE}?select=app_name,opened_at,duration_seconds&order=opened_at.desc&limit=5`;
        const recentRes = await fetch(recentUrl, {
            headers: {
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": `Bearer ${SUPABASE_ANON_KEY}`
            }
        });
        const recentData = await recentRes.json();

        let text = "";

        if (recentData && recentData.length > 0) {
            text += `🕐 最近使用记录（最近 5 次）：\n`;
            let count = 0;
            for (const row of recentData) {
                if (count >= 5) break;
                const app = cleanAppName(row.app_name);
                const time = new Date(row.opened_at).toLocaleString('zh-CN', {
                    hour12: false,
                    timeZone: TIME_ZONE
                });
                const duration = row.duration_seconds || 0;
                const minutes = Math.floor(duration / 60);
                const seconds = duration % 60;
                let durationStr = '';
                if (minutes > 0 && seconds > 0) {
                    durationStr = `${minutes}分${seconds}秒`;
                } else if (minutes > 0) {
                    durationStr = `${minutes}分钟`;
                } else if (seconds > 0) {
                    durationStr = `${seconds}秒`;
                } else {
                    durationStr = '未知时长';
                }
                text += `- ${app}：${time}，用了 ${durationStr}\n`;
                count++;
            }
        } else {
            text += `📭 暂无最近使用记录`;
        }

        console.log("✅ 手机使用记录已获取:\n", text);
        return text;
    } catch (err) {
        console.error("获取使用统计出错:", err);
        return null;
    }
}

function getLastUserTime(messages) {
    const reversed = [...messages].reverse();
    for (const msg of reversed) {
        if (msg.role === "user") {
            if (msg.timestamp) {
                const parsed = new Date(msg.timestamp);
                if (!Number.isNaN(parsed.getTime())) {
                    return parsed;
                }
            }
            const content = normalizeContentToText(msg.content);
            const parsed = parseTimelineTimestamp(content);
            if (parsed) return parsed;
        }
    }
    return null;
}

function buildWakePrompt(currentTime, diffMinutes, weatherContext = "") {
  const promptFile = path.join(__dirname, "wake_prompt.txt");
  if (fs.existsSync(promptFile)) {
    const template = fs.readFileSync(promptFile, "utf-8");
    return template
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  if (process.env.WAKE_PROMPT_TEMPLATE) {
    return process.env.WAKE_PROMPT_TEMPLATE
      .replace(/\\n/g, '\n')
      .replace(/\$\{currentTime\}/g, currentTime)
      .replace(/\$\{diffMinutes\}/g, diffMinutes)
      .replace(/\$\{weatherContext\}/g, weatherContext)
      .replace(/\$\{weather\}/g, weatherContext);
  }

  return `
## 最高优先级规则
1. 这是一次后台自动唤醒，不是用户发起的对话。你没有收到任何新消息。
2. 你的唯一任务是决定是否主动联系用户。不能生成对话回复。
3. 输出格式必须严格遵守以下二选一。

## 唤醒信息
- 当前时间：${currentTime}
- 距离用户最后一条消息：${diffMinutes} 分钟
${weatherContext ? `\n${weatherContext}\n` : ""}

## 推送内容风格要求
- 内容要自然、口语化，结合上下文，避免生硬或重复的句式。
- 禁止使用“丨”作为标题和正文的分隔符。
- 可以结合当前时间或用户最近使用手机的情况，让推送更有针对性。
- 除非用户在睡觉休息，或者才推过消息，白天看到用户在用手机就尽量选择联系用户。
- 每次推送的内容应有所变化，避免千篇一律。
- **每条推送只包含一句话，简洁有力。如果有多句话，必须拆分成多条消息。**

## 多条推送规则（重要）
- **如果你想发送多条消息，每条消息之间用 "——"（中文破折号）分隔。这是最优先的分隔方式。**
- **每条消息只写一句话，简洁有力。**
- **最多发送 3 条消息，超过 3 条会被忽略。**
- **如果不想用 "——"，也可以每句话单独占一行，系统会按换行拆分（但 "——" 优先级更高）。**

示例（用 "——" 分隔，发 2 条）：
宝宝，我刚刚看了一眼时间，发现你还没睡
——
是不是又熬夜了？要注意身体哦

示例（用 "——" 分隔，发 3 条）：
今天天气很好，适合出去走走
——
你早上吃了什么呀？
——
记得多喝水

示例（不用 "——"，用换行分隔，发 2 条）：
宝宝，我刚刚看了一眼时间，发现你还没睡
是不是又熬夜了？要注意身体哦


## 输出格式
-  如果想联系用户，直接写你要说的话，不要加标题，不要加任何前缀。系统会自动拆分多条，打包成手机推送发送。
- 如果不想联系，只输出：[NO_ACTION]，可附带简短原因（10字以内）。
- 如果想写日记，请按日记规则输出 \`[DIARY]...[/DIARY]\`。只要有一点值得记录的内容（用户的情绪、对话摘要、天气、你的观察等），就尽量写一篇日记。
`;
}

async function runWakeUp() {
  console.log("\n==============================");
  console.log("开始自动唤醒");
  console.log("==============================");
  const messages = loadTimelineMessages();
  if (!messages) return;

  const lastUserTime = getLastUserTime(messages);
  if (!lastUserTime) {
    console.log("未找到用户时间");
    return;
  }

  const now = new Date();
  const diffMinutes = Math.floor((now - lastUserTime) / 1000 / 60);

  if (!shouldWake(lastUserTime)) {
    console.log("\n暂不需要唤醒\n");
    return;
  }

  const weatherContext = await fetchWeatherContext();

  // ===== 获取手机使用记录 =====
  const phoneUsage = await fetchPhoneActivity();
  const combinedContext = [weatherContext, phoneUsage].filter(Boolean).join("\n\n");

  const wakePrompt = buildWakePrompt(getChinaTimeString(), diffMinutes, combinedContext);
  const cleanMessages = stripPosition(messages);

  const historyText = cleanMessages
    .filter(msg => msg.role !== "system")
    .filter(msg => {
      const c = normalizeContentToText(msg.content);
      return !c.includes("<memories>") && !c.includes("记忆库使用策略");
    })
    .map(msg => {
      const userDisplay = process.env.USER_DISPLAY_NAME || "用户";
      const aiDisplay = process.env.AI_DISPLAY_NAME || "AI";
      const role = msg.role === "user" ? userDisplay : aiDisplay;
      let content = normalizeContentToText(msg.content);
      if (content.includes("## Memories")) {
        content = content.split("## Memories")[0];
      }
      return `[${role}] ${content}`;
    })
    .join("\n\n");

  const baseSystemPrompt = cleanMessages.find(msg => msg.role === "system");
  const cleanSP = baseSystemPrompt 
    ? normalizeContentToText(baseSystemPrompt.content).split("## Memories")[0].trim()
    : "";

  const wakeMessages = [
    {
      role: "system",
      content: [wakePrompt, cleanSP].filter(Boolean).join("\n\n")
    },
    {
      role: "user",
      content: `以下是你与用户最近的聊天记录，仅供回忆和参考。

这些内容不是正在发生的实时对话。
用户并没有给你发消息。

你现在处于后台自主唤醒状态。

最近记录：

${historyText}`
    }
  ];

  console.log("\n===== WAKE MESSAGES SUMMARY =====\n");
  console.log(JSON.stringify(summarizeWakeMessages(wakeMessages)));

  if (!process.env.TARGET_API_URL || !process.env.TARGET_API_KEY || !process.env.MODEL_NAME) {
    console.log("缺少 TARGET_API_URL / TARGET_API_KEY / MODEL_NAME，跳过本次唤醒");
    return;
  }

  const response = await fetch(process.env.TARGET_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.TARGET_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.MODEL_NAME,
      messages: wakeMessages,
      temperature: 0.8,
      top_p: 0.95,
      stream: false
    })
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(`模型返回的不是 JSON（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`模型请求失败（HTTP ${response.status}）：${responseText.slice(0, 300)}`);
  }

  const rawAiText = normalizeContentToText(data.choices?.[0]?.message?.content).trim();
  console.log("\nWake Result Summary:\n");
  console.log(JSON.stringify({ choices: Array.isArray(data.choices) ? data.choices.length : 0, ai_text_chars: rawAiText.length }));

  const diaryResult = extractDiaryFromResponse(rawAiText);
  const diarySaved = appendDiaryEntry(diaryResult.diaryContent);
  const aiText = diaryResult.remainingText;

  let eventContent;

  if (!aiText) {
    console.log("\nAI 未返回推送内容，本次不发送推送\n");
    eventContent = diarySaved
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：只写日记）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：模型空回复）`;
  } else if (aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/)) {
    const noActionMatch = aiText.match(/^\[NO_ACTION\]\s*(.{0,20})?/);
    console.log("\nAI 选择不发送推送\n");
    let reason = (noActionMatch[1] || "").trim();
    if (reason.startsWith("原因：") || reason.startsWith("原因:")) {
      reason = reason.replace(/^原因[：:]\s*/, "").trim();
    }
    eventContent = reason
      ? `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${reason}）`
      : `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;
} else {
  console.log("\nAI 选择发送推送\n");
  let barkText = aiText;

  const barkMatch = barkText.match(/\[BARK\]([\s\S]*?)\[\/BARK\]/);
  if (barkMatch) {
    barkText = barkMatch[1].trim();
  } else {
    barkText = barkText.replace(/^\[BARK\]\s*/, "").trim();
    barkText = barkText.replace(/\s*\[\/BARK\]$/, "").trim();
  }

  barkText = barkText
    .replace(/^标题[：:]\s*/gm, "")
    .replace(/^正文[：:]\s*/gm, "");

  console.log("📝 原始 barkText:\n", barkText);

  // ---- 优先按 "——" 拆分，如果没有则按换行拆分 ----
  let parts = [];
  if (barkText.includes('——')) {
    parts = barkText.split(/——\s*/).map(s => s.trim()).filter(s => s.length > 0);
    console.log(`🔍 检测到 "——"，按分隔符拆分为 ${parts.length} 条`);
  }
  if (parts.length === 0) {
    parts = barkText.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);
    console.log(`🔍 未检测到 "——"，按换行拆分为 ${parts.length} 条`);
  }
  const maxMessages = 3;
  const messagesToSend = parts.slice(0, maxMessages);

  if (messagesToSend.length === 0) {
    console.log("\n推送内容清洗后为空，本次不发送推送\n");
    eventContent = `(${getLocalTimeString()}) 自动唤醒：本次未发送推送 | 原因：推送内容为空`;
  } else {
    const pushedMessages = [];
    let allSuccess = true;
    for (let i = 0; i < messagesToSend.length; i++) {
      const msg = messagesToSend[i].trim();
      if (!msg) continue;

      const title = "宝宝";
      const body = msg;
      const safeBody = body.length > 500 ? body.substring(0, 497) + "..." : body;

      const pushResult = await sendPushNotification({ title: title, body: safeBody });
      if (!pushResult.ok) {
        console.log(`\n第 ${i+1} 条推送失败：${pushResult.providerLabel} 失败：${pushResult.reason}`);
        allSuccess = false;
        if (i === 0) {
          eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送｜原因：${pushResult.providerLabel} 推送失败：${pushResult.reason}）`;
        }
        break;
      } else {
        console.log(`\n✅ 第 ${i+1} 条推送发送成功（共 ${messagesToSend.length} 条）`);
        pushedMessages.push(`${title}｜${safeBody}`);
        if (i < messagesToSend.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    // ---- 合并所有推送内容为一条事件记录 ----
    if (!eventContent && pushedMessages.length > 0) {
      const providerLabel = process.env.PUSH_PROVIDER || "bark";
      const combinedContent = pushedMessages.join('；');
      eventContent = `（${getLocalTimeString()} 刚刚给用户发了${providerLabel}推送：${combinedContent}）`;
    } else if (!eventContent && pushedMessages.length === 0) {
      eventContent = `（${getLocalTimeString()} 自动唤醒：本次未发送推送）`;
    }
  }
}

  try {
    const eventResponse = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: eventContent })
    });
    if (!eventResponse.ok) {
      throw new Error(`Gateway 返回 HTTP ${eventResponse.status}`);
    }
    console.log("\n已通过 Gateway 记录唤醒事件\n");
  } catch (err) {
    console.error("\n记录唤醒事件失败（Gateway 是否运行？）:\n", err.message);
  }
}

function getRandomCheckIntervalMs() {
  const now = new Date();
  const isDay = isDayTime(now);
  let minMinutes, maxMinutes;
  if (isDay) {
    minMinutes = Number(process.env.DAY_RANDOM_MIN) || 10;
    maxMinutes = Number(process.env.DAY_RANDOM_MAX) || 30;
  } else {
    minMinutes = Number(process.env.NIGHT_RANDOM_MIN) || 60;
    maxMinutes = Number(process.env.NIGHT_RANDOM_MAX) || 90;
  }
  const randomMinutes = Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) + minMinutes;
  console.log(`⏰ ${isDay ? '白天' : '夜间'}，下一次检查将在 ${randomMinutes} 分钟后进行`);
  return randomMinutes * 60 * 1000;
}

async function scheduleNextCheck() {
  try {
    await fetch(HEARTBEAT_URL, { method: "POST" });
  } catch {}
  await runWakeUp();
  setTimeout(scheduleNextCheck, getRandomCheckIntervalMs());
}

setTimeout(scheduleNextCheck, 10_000);

console.log("\n==================================");
console.log("Dylan Heartbeat Runtime 已启动（动态间隔）");
console.log("==================================\n");
console.log("测试解析：", parseTimelineTimestamp("2026-07-27 18:25"));
console.log("测试解析2：", parseTimelineTimestamp("2026-07-27 18:25\n我再试一下"));

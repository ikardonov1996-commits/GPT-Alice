// Навык Алисы, который пересылает вопросы в ChatGPT (OpenAI API).
// Без внешних зависимостей: нужен только Node.js 18+.

const http = require('http');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
// Алиса ждёт ответ навыка ~3 секунды, поэтому ждём OpenAI чуть меньше.
const ANSWER_TIMEOUT_MS = Number(process.env.ANSWER_TIMEOUT_MS || 2500);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 10);
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  'Ты голосовой помощник в умной колонке. Отвечай по-русски, коротко и по делу: ' +
  '1–3 предложения, без списков, markdown, эмодзи и ссылок — ответ будет произнесён вслух.';

const MAX_TEXT = 1024; // лимит Алисы на поля text и tts
const SESSION_TTL_MS = 30 * 60 * 1000;

const EXIT_WORDS = ['хватит', 'стоп', 'выход', 'выйти', 'закончить', 'пока'];
const CONTINUE_WORDS = ['дальше', 'продолжи', 'продолжай', 'ну что', 'готово', 'ответ', 'что там'];

// session_id -> { history: [{role, content}], pending: Promise|null, result: string|null, touched }
const sessions = new Map();

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = { history: [], pending: null, result: null, touched: Date.now() };
    sessions.set(id, s);
  }
  s.touched = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL_MS) sessions.delete(id);
}, 60 * 1000).unref();

async function askChatGPT(history) {
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// Запускает запрос к ChatGPT в фоне; результат сохраняется в сессии.
function startQuestion(session, question) {
  session.history.push({ role: 'user', content: question });
  session.result = null;
  session.pending = askChatGPT(session.history)
    .then((answer) => {
      session.history.push({ role: 'assistant', content: answer });
      session.history.splice(0, Math.max(0, session.history.length - MAX_HISTORY));
      session.result = answer || 'ChatGPT ничего не ответил.';
    })
    .catch((err) => {
      console.error(err);
      session.history.pop();
      session.result = 'Не получилось связаться с ChatGPT. Попробуйте ещё раз.';
    })
    .finally(() => { session.pending = null; });
}

// Ждём готовый ответ не дольше ANSWER_TIMEOUT_MS.
async function waitForResult(session) {
  if (session.pending) {
    await Promise.race([session.pending, new Promise((r) => setTimeout(r, ANSWER_TIMEOUT_MS))]);
  }
  if (session.result !== null) {
    const text = session.result;
    session.result = null;
    return text;
  }
  return null;
}

function cleanText(text) {
  return text.replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(text) {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.slice(0, MAX_TEXT - 1);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > MAX_TEXT / 2 ? cut.slice(0, end + 1) : cut + '…';
}

const has = (utterance, words) => words.some((w) => utterance === w || utterance.startsWith(w + ' '));

async function handleAlice(req) {
  const utterance = (req.request?.original_utterance || req.request?.command || '').trim();
  const command = (req.request?.command || '').toLowerCase().trim();
  const session = getSession(req.session?.session_id || 'default');
  console.log(`[alice] new=${!!req.session?.new} client=${req.meta?.client_id || "?"} utterance="${utterance}"`);

  // Проверочный запрос от Яндекса.
  if (utterance === 'ping') return { text: 'pong' };

  if (req.session?.new && !command) {
    session.history = [];
    return { text: 'Привет! Я подключила ChatGPT. Задайте любой вопрос.' };
  }

  if (has(command, EXIT_WORDS)) {
    sessions.delete(req.session?.session_id);
    return { text: 'До встречи!', end_session: true };
  }

  if (!OPENAI_API_KEY) return { text: 'Не задан ключ OpenAI. Добавьте OPENAI_API_KEY в настройках сервера.' };

  const isContinue = has(command, CONTINUE_WORDS) || !command;
  if (!(isContinue && (session.pending || session.result !== null))) {
    if (!command) return { text: 'Я вас слушаю. Задайте вопрос.' };
    if (session.pending) return { text: 'Я ещё думаю над прошлым вопросом. Скажите «дальше» через пару секунд.' };
    startQuestion(session, utterance);
  }

  const answer = await waitForResult(session);
  if (answer === null) {
    return {
      text: 'Секунду, ChatGPT думает. Скажите «дальше», чтобы услышать ответ.',
      buttons: [{ title: 'Дальше', hide: true }],
    };
  }
  return { text: answer };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Alice ChatGPT skill is running');
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw || '{}'); } catch {
      res.writeHead(400);
      return res.end('Bad JSON');
    }
    let response;
    try {
      response = await handleAlice(body);
    } catch (err) {
      console.error(err);
      response = { text: 'Произошла ошибка. Попробуйте ещё раз.' };
    }
    const text = truncate(cleanText(response.text));
    const out = {
      version: body.version || '1.0',
      response: { ...response, text, end_session: !!response.end_session },
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out));
  });
});

server.listen(PORT, () => console.log(`Alice ChatGPT skill listening on port ${PORT}`));

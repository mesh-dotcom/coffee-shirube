// 収集スクリプトの共通部品（依存パッケージなし・Node 20以上）
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export const BOT_TOKEN = 'CoffeeShirubeBot';
// お店の担当者がアクセス元を確かめて連絡できるように、名前と連絡先（CONTACT_URL。既定はリポジトリの Issues）を名乗る
export const UA = `${BOT_TOKEN}/0.2 (+${process.env.CONTACT_URL || 'https://github.com/'})`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
// 日本時間の日付（YYYY-MM-DD）
export const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// お店のURLから id を作る（例: https://www.example-coffee.jp/ → example-coffee）
export const slug = (host) => String(host).toLowerCase().replace(/^www\./, '').replace(/\.(co\.jp|ne\.jp|or\.jp|jp|com|net|shop|coffee|store|org|tokyo)$/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'shop';

// GitHub Actions の実行結果のページに、まとめ（Markdown）と注意書きを出す。手元で動かすときは何もしない
export async function stepSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + '\n', 'utf8');
}
export function warn(message) {
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${String(message).replace(/\r?\n/g, ' ')}`);
}

export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

export async function writeJSON(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/* ---------- お店に負担をかけない取得 ----------
   ・robots.txt に従う（RFC 9309）。自分あての指定があればそれだけを、なければ「*」の指定を使う
   ・robots.txt がサーバーエラーや通信エラーで読めないときは、そのお店から何も取得しない
   ・同じお店へのアクセスは既定で3秒以上あける。Crawl-delay がそれより長ければそれに従う
     （30秒より長い指定は毎日の収集では守りきれないので、そのお店からは取得しない）
   ・ログインやパスワードが必要なページには入らない */
const GAP_MS = Number(process.env.REQUEST_GAP_MS ?? 3000);
const MAX_GAP_MS = 30000;
const lastHit = new Map();
const robotsCache = new Map();

function patternToRegex(p) {
  let end = false;
  if (p.endsWith('$')) { end = true; p = p.slice(0, -1); }
  const body = p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (end ? '$' : ''));
}

export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (!line || i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      if (val) cur.rules.push({ allow: key === 'allow', path: val, re: patternToRegex(val) }); // 空の Disallow は「制限なし」
    } else if (key === 'crawl-delay') {
      const n = parseFloat(val);
      if (Number.isFinite(n) && n >= 0) cur.delay = Math.max(cur.delay || 0, n);
    }
  }
  const me = BOT_TOKEN.toLowerCase();
  const mine = groups.filter((g) => g.agents.some((a) => a.split('/')[0] === me));
  const picked = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let delay = null;
  for (const g of picked) if (g.delay != null) delay = Math.max(delay || 0, g.delay);
  return { rules: picked.flatMap((g) => g.rules), delay, blockAll: false };
}

async function loadRobots(origin) {
  let res;
  try {
    res = await fetch(origin + '/robots.txt', { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch {
    return { rules: [], delay: null, blockAll: true };
  }
  if (res.status >= 500) return { rules: [], delay: null, blockAll: true };
  if (!res.ok) return { rules: [], delay: null, blockAll: false }; // 404 などは「制限なし」
  return parseRobots(await res.text());
}

async function robotsFor(origin) {
  if (!robotsCache.has(origin)) robotsCache.set(origin, await loadRobots(origin));
  return robotsCache.get(origin);
}

export async function isAllowed(url) {
  const u = new URL(url);
  const r = await robotsFor(u.origin);
  if (r.blockAll) return false;
  const target = u.pathname + u.search;
  let best = null;
  for (const rule of r.rules) {
    if (!rule.re.test(target)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return !best || best.allow;
}

const LOGIN_PATH = /\/(password|account\/login|login|signin|sign_in|members?\/login)(\/|$)/i;

export async function politeFetch(url, { as = 'text', timeout = 20000, full = false } = {}) {
  if (!(await isAllowed(url))) {
    const e = new Error(`robots.txt で許可されていないため取得しません: ${url}`);
    e.robots = true;
    throw e;
  }
  const origin = new URL(url).origin;
  const r = await robotsFor(origin);
  const want = (r.delay || 0) * 1000;
  if (want > MAX_GAP_MS) {
    const e = new Error(`robots.txt の Crawl-delay（${r.delay}秒）が長く、守りきれないため取得しません: ${url}`);
    e.robots = true;
    throw e;
  }
  const gap = Math.max(GAP_MS, want);
  const wait = (lastHit.get(origin) || 0) + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(origin, Date.now());
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : 'text/html,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  const finalUrl = res.url || url;
  if (LOGIN_PATH.test(new URL(finalUrl).pathname)) {
    const e = new Error(`ログインが必要なページのため取得しません: ${url}`);
    e.login = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}: ${url}`);
    e.status = res.status;
    throw e;
  }
  const body = as === 'json' ? await res.json() : await res.text();
  return full ? { body, headers: res.headers, url: finalUrl } : body;
}

// お店から「少し間をおいて」と言われたら、そのお店の取得はその回で打ち切る
export const isHardStop = (e) => e && (e.status === 429 || e.status >= 500);

// ページの meta robots や X-Robots-Tag で収集を断っている（noindex / none）か
export function robotsMetaBlocks(html, headers) {
  const me = BOT_TOKEN.toLowerCase();
  const blocks = (s) => /(^|[\s,])(noindex|none)([\s,]|$)/i.test(s);
  const xr = headers && typeof headers.get === 'function' ? headers.get('x-robots-tag') : null;
  if (xr) {
    const m = String(xr).match(/^\s*([a-z0-9_-]+)\s*:\s*(.*)$/i);
    if (m && !/^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/i.test(m[1])) {
      if (m[1].toLowerCase() === me && blocks(m[2])) return true;
    } else if (blocks(xr)) return true;
  }
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const name = (tag.match(/\bname\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    const content = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    if (name && (name.toLowerCase() === 'robots' || name.toLowerCase() === me) && blocks(content)) return true;
  }
  return false;
}

// ページを取得し、収集を断られていないか確かめる（断られていれば null）
export async function fetchCollectablePage(url) {
  const { body, headers, url: finalUrl } = await politeFetch(url, { full: true });
  if (robotsMetaBlocks(body, headers)) return null;
  return { html: body, url: finalUrl };
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t') // 表のセルの区切り（見出しのセル → 値のセル を読めるように残す）
    .replace(/<\/(p|div|li|h[1-6]|tr|dt|dd|section|article|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ').replace(/&yen;/g, '¥')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/[ 　]+/g, ' ')
    .replace(/ *\t[ \t]*/g, '\t')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ページの本文（<main> の中。無ければ全体）を文章にする
export function mainText(html) {
  const m = String(html || '').match(/<main\b[\s\S]*?<\/main>/i);
  return htmlToText(m ? m[0] : html);
}

/* ---------- Shopify ---------- */
const GOODS_JA = /(ドリッパー|電動ミル|手動ミル|コーヒーミル|グラインダー|ケトル|マグカップ|グラス|タンブラー|ボトル|Tシャツ|トートバッグ|ギフトカード|定期便|セミナー|ツアー|ペーパーフィルター|サーバー|シロップ|クッキー|スイーツ|ドリップバッグ|コーヒーバッグ|ステッカー|スプーン|キャニスター|スケール|ワークショップ)/;
const GOODS_EN = /\b(dripper|grinder|kettle|mug|tumbler|bottle|t-?shirt|tee|tote|gift ?card|subscription|seminar|workshop|tour|filter paper|syrup|cookie|drip ?bags?|coffee ?bags?|sticker|spoon|canister|scale)\b/i;
const GOODS_TYPE = /(グッズ|器具|雑貨|goods|equipment|merch|apparel|accessor)/i;

// 明らかに豆ではない商品を、読み取りの前にふるい落とす
export function looksLikeGoods(title, productType = '') {
  return GOODS_JA.test(title) || GOODS_EN.test(title) || GOODS_TYPE.test(productType);
}

export async function isShopify(origin) {
  try {
    const d = await politeFetch(`${origin}/products.json?limit=1`, { as: 'json', timeout: 15000 });
    return Array.isArray(d?.products);
  } catch {
    return false;
  }
}

// トップページで、お店全体が収集を断っていないか（noindex・パスワード保護）を確かめる
export async function checkStorefront(shop) {
  const origin = new URL(shop.url).origin;
  const page = await fetchCollectablePage(origin + '/');
  if (!page) {
    const e = new Error('トップページで検索エンジン向けの収集を断っている（noindex）ため取得しません');
    e.noindex = true;
    throw e;
  }
}

export async function listShopify(shop) {
  await checkStorefront(shop);
  const origin = new URL(shop.url).origin;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await politeFetch(`${origin}/products.json?limit=250&page=${page}`, { as: 'json' });
    const products = Array.isArray(data?.products) ? data.products : [];
    for (const p of products) {
      if (looksLikeGoods(p.title || '', p.product_type || '')) continue;
      const variants = (p.variants || []).map((v) => ({
        title: [v.option1, v.option2, v.option3].filter((x) => x && x !== 'Default Title').join(' / ') || v.title || '',
        price: Math.round(parseFloat(v.price)),
        available: v.available !== false,
      }));
      out.push({
        key: `${shop.id}:${p.handle}`,
        url: `${origin}/products/${p.handle}`,
        name: p.title,
        productType: p.product_type || '',
        tags: Array.isArray(p.tags) ? p.tags.join(', ') : String(p.tags || ''),
        text: htmlToText(p.body_html).slice(0, 6000), // 読み取りに使うだけで、保存はしない
        variants,
      });
    }
    if (products.length < 250) break;
  }
  return out;
}

export function gramsOf(title) {
  const m = String(title).normalize('NFKC').match(/(\d+(?:[.,]\d+)*)\s*(kg|g|グラム)(?![a-z])/i);
  if (!m) return null;
  let s = m[1];
  s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^kg$/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

// 「豆のまま」かつ在庫ありのうち、一番小さい容量の価格を代表にする
export function pickPrice(variants) {
  const isGround = (t) => /(粉|挽|ground|ドリップ用|エスプレッソ用|ペーパー用|フレンチプレス用)/i.test(t);
  let vs = variants.filter((v) => v.available && v.price > 0);
  const whole = vs.filter((v) => !isGround(v.title));
  if (whole.length) vs = whole;
  if (!vs.length) return null;
  const from = new Set(vs.map((v) => v.price)).size > 1;
  const sized = vs.map((v) => ({ ...v, g: gramsOf(v.title) })).filter((v) => v.g);
  if (sized.length) {
    sized.sort((a, b) => a.g - b.g || a.price - b.price);
    return { price: sized[0].price, grams: sized[0].g, from };
  }
  vs.sort((a, b) => a.price - b.price);
  return { price: vs[0].price, grams: null, from };
}

/* ---------- 利用規約で掲載してよいお店か ----------
   shops.json の terms.status が ok（自動収集の禁止なし）か permission（許諾あり）のお店だけ集める。
   サイトを収益化している（shops.json の commercial が true）ときは、
   情報の商業利用を禁止しているお店も、許諾がなければ集めない。 */
export function termsGate(shop, commercial) {
  const t = shop.terms || {};
  if (t.status === 'permission') return { ok: true };
  if (t.status === 'ng') return { ok: false, reason: '利用規約で自動収集が禁止されています（お店から許諾をもらったら、「お店の管理」で「掲載の許諾をもらった」を記録）' };
  if (t.status !== 'ok') return { ok: false, reason: '利用規約の確認がまだです（規約を読んで、「お店の管理」で「規約を確認した」を記録）' };
  if (commercial && t.commercial !== 'ok') return { ok: false, reason: '利用規約で情報の商業利用が禁止または未確認のため、収益化中は対象外です' };
  return { ok: true };
}

// 目で確かめた結果を記録する（status: ok / ng / permission）
export function markTerms(shop, status, { commercial, note } = {}) {
  if (!['ok', 'ng', 'permission'].includes(status)) throw new Error('判定は ok / ng / permission のどれかにしてください');
  const t = { ...(shop.terms || {}) };
  delete t.changed; // 規約が変わったという知らせは、読み直したので消す
  shop.terms = {
    ...t, status,
    commercial: commercial || (status === 'permission' ? 'ok' : t.commercial || 'review'),
    manual: true, checkedAt: today(), checkedBy: '目視確認',
    note: note || t.note,
  };
  return shop.terms;
}

/* ---------- Claude API ---------- */
export async function claude(body, { retries = 5 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300000),
    });
    if (res.ok) return res.json();
    const text = await res.text();
    const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retryable || attempt >= retries) throw new Error(`Claude API ${res.status}: ${text.slice(0, 300)}`);
    const ra = Number(res.headers.get('retry-after'));
    await sleep(ra > 0 ? ra * 1000 : Math.min(60000, 2000 * 2 ** attempt));
  }
}

// 文字列の前後の空白・改行を落とす（新しいモデルは値の末尾に改行を付けることがある）
const trimDeep = (v) => (typeof v === 'string' ? v.trim()
  : Array.isArray(v) ? v.map(trimDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimDeep(x)]))
  : v);

// ツールの入力を取り出す。出力が上限で切れた応答や、断られた応答は使わない
export function toolInput(resp, name) {
  if (!resp || resp.stop_reason === 'max_tokens' || resp.stop_reason === 'refusal') return null;
  const b = (resp.content || []).find((c) => c.type === 'tool_use' && c.name === name);
  return b ? trimDeep(b.input) : null;
}

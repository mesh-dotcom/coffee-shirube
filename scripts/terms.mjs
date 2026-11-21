#!/usr/bin/env node
/*
  お店の利用規約の確認
    node scripts/terms.mjs                  確認がまだのお店・90日以上たったお店の利用規約を読み取って判定する
    node scripts/terms.mjs --force          すべてのお店を確認しなおす（目で確かめた記録は残す）
    node scripts/terms.mjs --list           お店ごとの判定を一覧で表示する
    node scripts/terms.mjs --mark ID 判定 [--commercial ok|ng] [--note "メモ"]
                                            目で確かめた結果を記録する（判定は ok / ng / permission）
  判定（shops.json の terms.status）
    ok          自動収集の禁止なし → 集める
    ng          自動収集を禁止 → 集めない（許諾を得たら permission にする）
    review      規約が見つからない・判断がつかない → 集めない。目で確かめて --mark で記録する
    permission  お店から掲載の許諾を得た → 集める（商業利用も含めて許諾がある前提）
  商業利用（terms.commercial）: ok / ng / review。サイトを収益化するとき（shops.json の commercial を true）に使う
  判定の方法: 既定はキーワード（API なし）。EXTRACTOR が hybrid / claude で ANTHROPIC_API_KEY があれば Claude が読む
  どちらの判定も目安です。公開前に --list の結果を見て、規約を目で確かめてください。

  規約の見張り
    集めているお店（ok / permission）の規約ページは、30日ごとに読みなおす。
    自動収集を禁止する書き方が新しく加わっていたら、そのお店の収集を止めて知らせる（permission のお店は知らせるだけ）。
    それ以外の変化は「変わったようです」と知らせるだけで、収集は続ける。
*/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { politeFetch, isHardStop, htmlToText, mainText, claude, toolInput, readJSON, writeJSON, today, daysBetween, markTerms, stepSummary, warn } from './lib.mjs';
import { judgeTermsByRules } from './rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const SHOPS_FILE = path.join(DATA, 'shops.json');
const MODEL = process.env.CLAUDE_TERMS_MODEL || process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const RECHECK_DAYS = 90; // 自動で判定したお店を判定しなおす間隔
const WATCH_DAYS = 30; // 集めているお店の規約ページを読みなおす間隔
const USE_CLAUDE = ['claude', 'hybrid'].includes((process.env.EXTRACTOR || '').trim().toLowerCase()) && !!process.env.ANTHROPIC_API_KEY;
const CHECKED_BY = USE_CLAUDE ? 'Claude（自動判定）' : 'キーワード（自動判定）';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const log = (...a) => console.log(...a);

const LEVEL = { type: 'string', enum: ['prohibited', 'allowed', 'not_mentioned', 'unclear'] };
const TERMS_TOOL = {
  name: 'record_terms',
  description: 'お店の利用規約から、情報の自動収集や利用に関わる決まりを記録する。',
  input_schema: {
    type: 'object',
    properties: {
      is_terms: { type: 'boolean', description: 'このページが利用規約（またはそれに準じる規約）なら true' },
      automated_access: { ...LEVEL, description: 'クローリング・スクレイピング・ロボット・スパイダーなど、自動的な手段でのアクセスや情報収集の扱い' },
      commercial_use: { ...LEVEL, description: 'サイトから得た情報を商業目的で利用することの扱い' },
      reproduction: { ...LEVEL, description: '文章・画像などのコンテンツを複製・転載することの扱い' },
      clauses: {
        type: 'array', maxItems: 5,
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: '条項番号や見出し（例: 第6条5号）' },
            summary: { type: 'string', description: '内容を自分の言葉で40字以内に要約したもの（原文を写さない）' },
          },
          required: ['ref', 'summary'],
        },
      },
    },
    required: ['is_terms', 'automated_access', 'commercial_use', 'reproduction', 'clauses'],
  },
};

const SYSTEM = `あなたはお店のウェブサイトの利用規約を読み、情報の自動収集と利用に関わる条項を整理する担当です。
- 書かれていることだけで判断します。
- 「クロール・スクレイピング・ロボット・自動的な手段での収集」を明示的に禁止していれば automated_access は prohibited です。
- 「サーバーに過度な負荷をかける行為」や「当社が不適切と判断する行為」のような一般的な条項だけなら、prohibited にせず not_mentioned にします。
- 「本サービスで得た情報の商業的利用」を禁止していれば commercial_use は prohibited です。
- 判断がつかない書き方なら unclear にします。
- 要約は自分の言葉で短く書き、原文をそのまま写しません。`;

// 禁止 → ng、禁止なし → ok、それ以外（不明・想定外の値）→ review（集めない）
const toStatus = (v) => (v === 'prohibited' ? 'ng' : v === 'allowed' || v === 'not_mentioned' ? 'ok' : 'review');

async function findTermsPages(shop) {
  const origin = new URL(shop.url).origin;
  const urls = [`${origin}/policies/terms-of-service`];
  try {
    const html = await politeFetch(origin + '/');
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const text = htmlToText(m[2]);
      if (!/(利用規約|ご利用規約|サイト規約|規約|terms)/i.test(text + ' ' + m[1])) continue;
      try {
        const u = new URL(m[1], origin);
        if (u.origin === origin && !urls.includes(u.href)) urls.push(u.href);
      } catch { /* 読めないリンクは飛ばす */ }
    }
  } catch (e) {
    if (isHardStop(e)) throw e;
  }
  return urls.slice(0, 4);
}

const watchOf = (r, day) => ({ automated: r.automated_access, commercial: r.commercial_use, reproduction: r.reproduction, at: day });

async function checkShop(shop) {
  for (const url of await findTermsPages(shop)) {
    let text;
    try {
      text = mainText(await politeFetch(url)); // メニューやフッターの文言で判定がぶれないよう、本文だけを読む
    } catch (e) {
      if (isHardStop(e)) throw e;
      continue;
    }
    if (text.length < 200) continue;
    const byRules = judgeTermsByRules(text);
    let r = byRules;
    if (USE_CLAUDE) {
      const resp = await claude({
        model: MODEL, max_tokens: 1200, system: SYSTEM,
        tools: [TERMS_TOOL], tool_choice: { type: 'tool', name: TERMS_TOOL.name },
        messages: [{ role: 'user', content: `お店: ${shop.name}\nURL: ${url}\n\n${text.slice(0, 14000)}` }],
      });
      r = toolInput(resp, TERMS_TOOL.name);
    }
    if (!r || !r.is_terms) continue;
    return {
      status: toStatus(r.automated_access),
      commercial: toStatus(r.commercial_use),
      reproduction: r.reproduction,
      url,
      clauses: (r.clauses || []).map((c) => `${c.ref}: ${String(c.summary).slice(0, 60)}`),
      checkedAt: today(),
      checkedBy: CHECKED_BY,
      watch: watchOf(byRules, today()),
    };
  }
  return { status: 'review', commercial: 'review', checkedAt: today(), checkedBy: CHECKED_BY, note: '利用規約のページが見つからないか、読めませんでした。目で確かめて、「お店の管理」から記録してください' };
}

// 集めているお店の規約ページを読みなおし、前回と比べる。起きたこと（知らせる文）を返す
async function watchShop(shop, day) {
  const t = shop.terms;
  let text;
  try {
    text = mainText(await politeFetch(t.url));
  } catch (e) {
    if (isHardStop(e)) throw e;
    return []; // 読めなかった日は、次の回に読みなおす
  }
  const now = watchOf(judgeTermsByRules(text), day);
  const before = t.watch;
  t.watch = now;
  const newly = (k) => now[k] === 'prohibited' && (!before || before[k] !== 'prohibited');
  if (!before) {
    // 見張りはじめ。記録（集めてよい）とキーワードの判定が食い違っていたら、知らせるだけにする
    if (now.automated === 'prohibited' && t.status === 'ok') {
      t.changed = day;
      return ['キーワードの判定では、自動収集を禁止する書き方が見つかりました。規約を読みなおしてください（収集は続けています）'];
    }
    return [];
  }
  if (newly('automated') && t.status === 'ok') {
    t.status = 'ng';
    t.changed = day;
    t.note = `${day} 規約のページに自動収集を禁止する書き方が加わったため、収集を止めました。読みなおして、問題がなければ「規約を確認した」を記録してください`;
    return ['規約に自動収集を禁止する書き方が加わったため、このお店の収集を止めました'];
  }
  if (newly('commercial') && t.commercial === 'ok') {
    t.commercial = 'ng';
    t.changed = day;
    return ['規約に情報の商業利用を禁止する書き方が加わりました（収益化しているときは対象外になります）'];
  }
  if (['automated', 'commercial', 'reproduction'].some((k) => before[k] !== now[k])) {
    t.changed = day;
    return ['規約の内容が変わったようです。読みなおしてください（収集は続けています）'];
  }
  return [];
}

function list(conf) {
  for (const s of conf.shops) {
    const t = s.terms || {};
    const flag = s.enabled === false ? '（休止中）' : '';
    log(`${s.id}${flag}: 自動収集 ${t.status || '未確認'} / 商業利用 ${t.commercial || '未確認'} / ${t.checkedAt || '-'} ${t.checkedBy || ''}`);
    if (t.url) log(`  規約: ${t.url}`);
    for (const c of t.clauses || []) log(`  - ${c}`);
    if (t.note) log(`  メモ: ${t.note}`);
    if (t.changed) log(`  ※ ${t.changed} に規約の変化を見つけました。読みなおして記録してください`);
  }
}

async function main() {
  const conf = await readJSON(SHOPS_FILE);
  if (has('--list')) return list(conf);

  if (has('--mark')) {
    const id = opt('--mark');
    const status = args[args.indexOf('--mark') + 2];
    const shop = conf.shops.find((s) => s.id === id);
    if (!shop) throw new Error(`お店が見つかりません: ${id}`);
    const t = markTerms(shop, status, { commercial: opt('--commercial'), note: opt('--note') });
    await writeJSON(SHOPS_FILE, conf);
    log(`${id}: 自動収集 ${t.status} / 商業利用 ${t.commercial} を記録しました`);
    return;
  }

  const force = has('--force');
  const day = today();
  let checked = 0;
  const news = [];
  for (const shop of conf.shops) {
    if (shop.enabled === false) continue;
    const t = shop.terms;
    try {
      if (!t?.manual && (force || !t?.checkedAt || daysBetween(t.checkedAt, day) >= RECHECK_DAYS)) {
        // まだ確かめていないお店・自動の判定から90日たったお店（目で確かめた記録は上書きしない）
        log(`■ ${shop.name}`);
        shop.terms = await checkShop(shop);
        log(`  自動収集 ${shop.terms.status} / 商業利用 ${shop.terms.commercial}${shop.terms.url ? `（${shop.terms.url}）` : ''}`);
        news.push(`${shop.name}: 利用規約を読みました（自動収集 ${shop.terms.status} / 商業利用 ${shop.terms.commercial}）${shop.terms.url ? ` → ${shop.terms.url}` : ''}`);
        checked++;
      } else if (t?.url && ['ok', 'permission'].includes(t.status) && (force || !t.watch?.at || daysBetween(t.watch.at, day) >= WATCH_DAYS)) {
        for (const ev of await watchShop(shop, day)) {
          log(`■ ${shop.name}: ${ev}`);
          news.push(`${shop.name}: ${ev} → ${t.url}`);
          warn(`${shop.name}: ${ev}`);
        }
      }
    } catch (e) {
      log(`  ! ${shop.name}: 確認できませんでした: ${e.message}`);
    }
  }
  await writeJSON(SHOPS_FILE, conf);
  log(`利用規約を判定したお店: ${checked}店`);
  if (news.length) await stepSummary(['## 利用規約の確認', '', ...news.map((x) => `- ${x}`), ''].join('\n'));
}

await main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

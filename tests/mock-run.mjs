// 偽のお店と偽の Claude で、収集・規約の確認・お店の管理の流れを一通り確かめる（ネット接続・APIキー不要）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const todayJST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 9 * 3600e3 - n * 864e5).toISOString().slice(0, 10);
const baseEnv = { ...process.env, ANTHROPIC_API_KEY: 'test', REQUEST_GAP_MS: '0', EXTRACTOR: '', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', GITHUB_OUTPUT: '' };
const run = (dir, script, args = [], extra = {}) => execFileSync('node', ['--import', './tests/mock-fetch.mjs', script, ...args], { env: { ...baseEnv, DATA_DIR: dir, ...extra }, encoding: 'utf8' });
const readJ = (f) => JSON.parse(readFileSync(f, 'utf8'));
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const tmp = (name) => mkdtempSync(path.join(tmpdir(), `shirube-${name}-`));
const dirs = [];

// 部品ごとのチェック
console.log(execFileSync('node', ['--import', './tests/mock-fetch.mjs', 'tests/unit.mjs'], { env: baseEnv, encoding: 'utf8' }));

/* ---------- 収集 ---------- */
const dir = tmp('collect'); dirs.push(dir);
const shopsFile = path.join(dir, 'shops.json');
const beansFile = path.join(dir, 'beans.json');
const cacheFile = path.join(dir, 'cache.json');
const OK = { status: 'ok', commercial: 'ok', manual: true, checkedAt: todayJST, checkedBy: '目視確認' };
writeFileSync(shopsFile, JSON.stringify({ commercial: false, shops: [
  { id: 'a', name: 'A店', url: 'https://shop-a.test/', shipping: '¥300', ad: 'affiliate', terms: { ...OK, commercial: 'ng' } },
  { id: 'b', name: 'B店', url: 'https://shop-b.test/', listUrls: ['/collections/beans'], terms: { ...OK, checkedBy: 'キーワード（自動判定）' } },
  { id: 'c', name: 'C店', url: 'https://shop-c.test/', terms: OK },
  { id: 'n', name: '未確認の店', url: 'https://unchecked.test/' },
  { id: 'ng', name: '規約で禁止の店', url: 'https://ngshop.test/', terms: { status: 'ng' } },
  { id: 'ni', name: 'noindexの店', url: 'https://noindex.test/', terms: OK },
  { id: 'pw', name: 'パスワードの店', url: 'https://pw.test/', terms: OK },
  { id: 'sp', name: '自分あて拒否の店', url: 'https://specific.test/', terms: OK },
  { id: 'off', name: '休止中', url: 'https://off.test/', enabled: false },
] }));

const log1 = path.join(dir, 'req1.log');
const sum1 = path.join(dir, 'summary1.md');
console.log(run(dir, 'scripts/collect.mjs', [], { MOCK_LOG: log1, CONTACT_URL: 'https://github.com/me/coffee-shirube/issues', GITHUB_STEP_SUMMARY: sum1 }));
const out = readJ(beansFile);
const byId = (o) => Object.fromEntries(o.beans.map((b) => [b.id, b]));
let beans = byId(out);
const reqs1 = read(log1);
assert.ok(!/^api /m.test(reqs1), '既定（ルール）では API を一度も呼ばない');

assert.equal(out.beans.length, 6, '掲載は6件（A店5＋B店1）');
assert.equal(out.contact, 'https://github.com/me/coffee-shirube/issues', 'お問い合わせ先をサイトに渡す');
const eth = beans['a:eth-gesha'];
assert.deepEqual([eth.price, eth.grams, eth.from], [3000, 100, true], '豆のまま・最小容量の価格');
assert.equal(eth.maker, 'ゲシャ・ビレッジ', '「農園」を外す');
assert.deepEqual(eth.varieties, ['ゲイシャ'], 'Gesha→ゲイシャ');
assert.deepEqual([eth.country, eth.region, eth.makerKind, eth.roast, eth.processGroups, eth.altitude, eth.notes], ['エチオピア', 'ベンチ・マジ', '農園', '浅煎り', ['ナチュラル'], '1,900–2,100m', ['ジャスミン', 'ピーチ']], 'ルールで見出しから読み取る');
assert.equal(eth.ad, 'affiliate', 'アフィリエイトのお店の豆には印が付く');
assert.equal(eth.checkedAt, todayJST, '確かめた日が入る');
const col = beans['a:col-gesha'];
assert.equal(col.name, 'Colombia El Paraíso Geisha Thermal', '商品名の【NEW】は外す');
assert.deepEqual([col.price, col.grams, col.country, col.processNote], [2800, 50, 'コロンビア', 'ダブルアナエロビック'], '1,000g より 50g を代表に');
const longLot = beans['a:long-notes'];
assert.deepEqual(longLot.notes, ['ジャスミン', 'りんご', 'カシス'], '長い文はそのまま載せず、中にある風味の言葉だけ拾う');
assert.equal(longLot.processNote, undefined, '長い精製の説明は載せない');
const monte = beans['a:page-spec'];
assert.deepEqual([monte.country, monte.region, monte.maker, monte.makerKind, monte.producer, monte.varieties, monte.processGroups, monte.altitude, monte.roast],
  ['コスタリカ', 'タラス', 'Monte Verde', '農園', 'Juan Perez,Maria Sánchez', ['カトゥアイ'], ['ハニー'], '1,700–1,800m', undefined], '説明に無い項目は、商品ページの仕様欄から読む');
assert.deepEqual(monte.notes, ['青りんご', 'フローラル', 'クッキー'], '見出しが無ければ、説明の文から風味の言葉だけ拾う');
assert.ok(!beans['a:hidden-lot'], 'noindex の商品ページは載せない');
assert.ok(!beans['a:glass'] && !beans['a:tasting'] && !beans['a:blend'] && !beans['a:kenya-so'], 'グラス・飲み比べ・ブレンド・売り切れは載せない');
const b = out.beans.find((x) => x.shop === 'b');
assert.deepEqual([b.country, b.varieties, b.maker, b.price, b.grams], ['グアテマラ', ['パカマラ'], 'エル・インヘルト', 1800, 200], 'Shopify 以外のお店');

assert.deepEqual(out.errors.map((e) => e.shop).sort(), ['c', 'ni', 'pw', 'sp'], 'robots拒否・noindex・パスワード・自分あて拒否は取得しない');
assert.deepEqual(out.skipped.map((s) => s.shop).sort(), ['n', 'ng'], '規約が未確認・禁止のお店は対象外');
assert.ok(!/unchecked\.test|ngshop\.test|off\.test/.test(reqs1), '対象外のお店には一度もアクセスしない');
assert.ok(!/specific\.test\/products\.json\?limit=250/.test(reqs1), '自分あてに拒否されたお店の一覧は取らない');
assert.ok(!out.shops.off && !out.shops.n && !out.shops.ng, '対象外・休止中のお店は出さない');
assert.deepEqual([out.shops.a.ad, out.shops.a.shipping], ['affiliate', '¥300']);
let cache = readJ(cacheFile);
assert.equal(cache._v, 2);
assert.equal(cache['a:hidden-lot'].data.blocked, true, 'noindex だったことを覚えておく');
for (const text of [JSON.stringify(cache), JSON.stringify(out)]) {
  assert.ok(!/果実感をフローラルな印象|全国送料300円|72時間タンク|ジューシーな果実感/.test(text), '説明文は、キャッシュにも掲載データにも残さない');
}
const summary = read(sum1);
assert.match(summary, /\| A店 \| 5件 \| 3 \/ 3 \/ 3 \| 更新しました \|/, '実行結果のまとめに、お店ごとの件数と読めた項目の数が出る');
assert.match(summary, /\| C店 \| 0件 .*取得できませんでした（載せられる情報がありません）/);
assert.match(summary, /\| 未確認の店 \| – \| – \| 対象外: 利用規約の確認がまだです/);
assert.match(summary, /B店: 利用規約を自分の目で確かめた記録がまだありません/, '目で確かめていないお店を知らせる');
assert.ok(!/A店: 利用規約を/.test(summary), '目で確かめたお店は知らせない');

// 2回目：前に読んだ内容を使い、商品ページは開かない
out.beans.find((x) => x.id === 'a:eth-gesha').firstSeen = '2026-01-01';
writeFileSync(beansFile, JSON.stringify(out));
const log2 = path.join(dir, 'req2.log');
const second = run(dir, 'scripts/collect.mjs', [], { MOCK_LOG: log2 });
assert.match(second, /新しく読み取った商品: 0件 \/ ページを確かめなおした商品: 0件/, '2回目は読みなおさない');
assert.ok(!/shop-a\.test\/products\/[a-z]/.test(read(log2)), '2回目は商品ページを開かない');
let again = readJ(beansFile);
assert.equal(byId(again)['a:eth-gesha'].firstSeen, '2026-01-01', '初めて載った日は引き継ぐ');
assert.equal(again.beans.length, 6);

// 値段が変わっても、商品ページは開かず、価格だけ新しくなる
const log3 = path.join(dir, 'req3.log');
run(dir, 'scripts/collect.mjs', [], { MOCK_LOG: log3, MOCK_PRICE_UP: '1' });
assert.ok(!/shop-a\.test\/products\/[a-z]/.test(read(log3)), '値段が変わっただけなら商品ページを開かない');
assert.equal(byId(readJ(beansFile))['a:eth-gesha'].price, 3300, '価格は毎回の一覧から新しくする');

// 2〜3週間たった商品ページは開きなおす。noindex になっていたら載せるのをやめる
cache = readJ(cacheFile);
cache['a:eth-gesha'].page = daysAgo(40);
cache['a:page-spec'].page = daysAgo(40);
writeFileSync(cacheFile, JSON.stringify(cache));
const log4 = path.join(dir, 'req4.log');
const fourth = run(dir, 'scripts/collect.mjs', [], { MOCK_LOG: log4, MOCK_NOINDEX: 'page-spec' });
assert.match(read(log4), /shop-a\.test\/products\/eth-gesha\n/, '日がたった商品ページは確かめなおす');
assert.ok(!/shop-a\.test\/products\/col-gesha/.test(read(log4)), '日がたっていない商品ページは開かない');
assert.match(fourth, /ページを確かめなおした商品: 1件/);
again = readJ(beansFile);
assert.ok(byId(again)['a:eth-gesha'] && !byId(again)['a:page-spec'], 'あとから noindex になった商品は載せない');
assert.equal(readJ(cacheFile)['a:eth-gesha'].page, todayJST);
run(dir, 'scripts/collect.mjs'); // noindex が外れても、次に確かめなおす日までは載らない
assert.ok(!byId(readJ(beansFile))['a:page-spec']);
cache = readJ(cacheFile);
cache['a:page-spec'].page = daysAgo(40);
writeFileSync(cacheFile, JSON.stringify(cache));
run(dir, 'scripts/collect.mjs');
assert.equal(byId(readJ(beansFile))['a:page-spec'].region, 'タラス', 'noindex が外れたら、確かめなおしたときにまた載る');

// 途中でお店が混んだ（429）ら打ち切り、この回に確かめた分と前回までの分を重ねずに載せる
cache = readJ(cacheFile);
delete cache['a:long-notes'];
writeFileSync(cacheFile, JSON.stringify(cache));
run(dir, 'scripts/collect.mjs', [], { MOCK_BUSY_PAGE: 'long-notes' });
again = readJ(beansFile);
assert.ok(again.errors.some((e) => e.shop === 'a' && /429/.test(e.message)), '429 で打ち切る');
const aIds = again.beans.filter((x) => x.shop === 'a').map((x) => x.id);
assert.equal(new Set(aIds).size, aIds.length, '同じ豆を二重に載せない');
assert.deepEqual(aIds.sort(), ['a:col-gesha', 'a:eth-gesha', 'a:long-notes', 'a:mystery', 'a:page-spec'], '打ち切った先の豆は前回の情報で残す');

// 7日以内に確かめた情報だけ残す
again.beans.forEach((x) => { if (x.shop === 'b') x.checkedAt = daysAgo(3); });
writeFileSync(beansFile, JSON.stringify(again));
run(dir, 'scripts/collect.mjs', [], { MOCK_BUSY_B: '1' });
again = readJ(beansFile);
assert.equal(again.beans.filter((x) => x.shop === 'b').length, 1, '3日前に確かめた情報は残す');
again.beans.forEach((x) => { if (x.shop === 'b') x.checkedAt = daysAgo(10); });
writeFileSync(beansFile, JSON.stringify(again));
run(dir, 'scripts/collect.mjs', [], { MOCK_BUSY_B: '1' });
assert.equal(readJ(beansFile).beans.filter((x) => x.shop === 'b').length, 0, '10日前の情報は載せない');

// 収益化したら、情報の商業利用を禁止しているお店は対象外
let conf = readJ(shopsFile);
conf.commercial = true;
writeFileSync(shopsFile, JSON.stringify(conf));
run(dir, 'scripts/collect.mjs');
again = readJ(beansFile);
assert.ok(again.skipped.some((s) => s.shop === 'a' && /商業利用/.test(s.reason)), '商業利用の禁止で対象外');
assert.equal(again.beans.filter((x) => x.shop === 'a').length, 0, 'そのお店の豆は消える');
conf.commercial = false;
writeFileSync(shopsFile, JSON.stringify(conf));
run(dir, 'scripts/collect.mjs');

// 日本・円の指定をしても円で返さないお店（Shopify の Markets でドルになる）は、間違った価格を出さないよう載せない
run(dir, 'scripts/collect.mjs', [], { MOCK_USD_ALWAYS: '1' });
again = readJ(beansFile);
assert.ok(again.errors.some((e) => e.shop === 'a' && /USD/.test(e.message)), '円以外の通貨なら、そのお店は取得しない');
assert.equal(again.beans.filter((x) => x.shop === 'a').length, 0, '前回までの価格も、通貨が違うかもしれないので残さない');
run(dir, 'scripts/collect.mjs');
again = readJ(beansFile);
assert.equal(again.beans.filter((x) => x.shop === 'a').length, 5, '円で返るようになれば、また載る');
assert.equal(byId(again)['a:eth-gesha'].price, 3000, '円の価格で載る');

console.log(run(dir, 'scripts/collect.mjs', ['--probe', 'https://shop-a.test/']));

/* ---------- お店の管理（フォームから） ---------- */
const outFile = path.join(dir, 'github-output.txt');
const manage = (env) => run(dir, 'scripts/manage.mjs', [], { GITHUB_OUTPUT: outFile, ...env });
console.log(manage({ ACTION: 'お店を足す', TARGET: 'www.shop-d.test', NOTE: 'テスト' }));
assert.match(read(outFile), /^shop=shop-d-test$/m, '足したお店の id を次の手順に渡す');
let d = readJ(shopsFile).shops.find((s) => s.id === 'shop-d-test');
assert.deepEqual([d.name, d.url, d.enabled, d.addedBy], ['D COFFEE ROASTERS', 'https://www.shop-d.test/', true, 'manage'], '店名はサイトの題名から付ける');
run(dir, 'scripts/terms.mjs');
run(dir, 'scripts/collect.mjs', [], { ONLY_SHOP: 'shop-d-test' });
again = readJ(beansFile);
assert.ok(again.skipped.some((s) => s.shop === 'shop-d-test' && /確認がまだ/.test(s.reason)), '規約を確かめるまでは集めない');
assert.equal(again.beans.filter((x) => x.shop === 'a').length, 5, '1店だけ更新するとき、ほかのお店は前回のまま');
manage({ ACTION: '規約を確認した（掲載してよい）', TARGET: 'D COFFEE ROASTERS', COMMERCIAL: '禁止されていない', NOTE: '規約を読んだ' });
d = readJ(shopsFile).shops.find((s) => s.id === 'shop-d-test');
assert.deepEqual([d.terms.status, d.terms.commercial, d.terms.manual, d.terms.checkedBy, d.terms.note], ['ok', 'ok', true, '目視確認', '規約を読んだ'], '店名でも指定できる');
run(dir, 'scripts/collect.mjs', [], { ONLY_SHOP: 'shop-d-test' });
assert.equal(readJ(beansFile).beans.filter((x) => x.shop === 'shop-d-test').length, 5, '規約を確かめたら載る');
manage({ ACTION: 'お店を止める', TARGET: 'https://shop-a.test/', NOTE: '掲載停止の依頼' });
run(dir, 'scripts/collect.mjs', [], { ONLY_SHOP: 'a' });
again = readJ(beansFile);
assert.equal(again.beans.filter((x) => x.shop === 'a').length, 0, '止めたお店の豆は、すぐサイトから消える');
assert.ok(!again.shops.a && again.beans.some((x) => x.shop === 'shop-d-test'), 'ほかのお店はそのまま');
manage({ ACTION: 'お店を再開する', TARGET: 'a' });
assert.equal(readJ(shopsFile).shops.find((s) => s.id === 'a').enabled, true);
manage({ ACTION: '掲載の許諾をもらった', TARGET: 'a', NOTE: 'メールで許諾' });
assert.deepEqual([readJ(shopsFile).shops.find((s) => s.id === 'a').terms.status, readJ(shopsFile).shops.find((s) => s.id === 'a').terms.commercial], ['permission', 'ok'], '許諾は商業利用も含む');
assert.throws(() => manage({ ACTION: 'お店を止める', TARGET: 'どこにも無い店' }), /登録されていません/, '知らないお店はエラーにする');
assert.throws(() => manage({ ACTION: 'お店を足す', TARGET: 'https://shop-a.test/' }), /すでに登録されています/, '同じお店は二重に足さない');
assert.throws(() => manage({ ACTION: 'お店を足す', TARGET: 'https://noindex.test/x' }), /すでに登録されています|noindex/);
assert.throws(() => manage({ ACTION: 'お店を足す', TARGET: 'https://shop-e.test/' }), /開けませんでした/, '開けないお店は足さない');
assert.throws(() => manage({ ACTION: 'お店を足す', TARGET: 'https://plain.test/' }), /Shopify のお店ではない/, 'Shopify 以外は、一覧ページのURLが要る');
manage({ ACTION: 'お店を足す', TARGET: 'https://plain.test/', LIST_URLS: '/items, /items?page=2' });
d = readJ(shopsFile).shops.find((s) => s.id === 'plain-test');
assert.deepEqual([d.name, d.listUrls], ['Plain Coffee', ['/items', '/items?page=2']], 'Shopify 以外のお店は、一覧ページを添えて足せる');

// お店探し（Claude の Web 検索）で見つけたお店は、利用規約の確認が済むまで集めない
conf = readJ(shopsFile);
conf.shops = conf.shops.filter((s) => s.id !== 'shop-d-test');
writeFileSync(shopsFile, JSON.stringify(conf));
const logD = path.join(dir, 'reqD.log');
console.log(run(dir, 'scripts/discover.mjs', ['--auto-add'], { MOCK_LOG: logD }));
assert.match(read(logD), /^api web_search,submit_shops claude-sonnet-5-5$/m, 'お店探しは Sonnet 5.5');
const found = readJ(shopsFile).shops;
d = found.find((s) => s.url === 'https://www.shop-d.test/');
assert.ok(d && d.enabled && d.addedBy === 'discover', 'Shopify の候補を追加');
assert.ok(!found.some((s) => s.url.includes('shop-e')), '読めない店は追加しない');
assert.equal(found.filter((s) => s.url.includes('shop-a')).length, 1, '登録済みは重複させない');
run(dir, 'scripts/collect.mjs');
assert.ok(readJ(beansFile).skipped.some((s) => s.shop === d.id && /確認がまだ/.test(s.reason)), '規約の確認前は対象外');
assert.throws(() => run(dir, 'scripts/discover.mjs', [], { ANTHROPIC_API_KEY: '' }), /ANTHROPIC_API_KEY が必要/, 'キーが無ければ、お店探しは動かさない');

/* ---------- 利用規約の確認と見張り ---------- */
const dir2 = tmp('terms'); dirs.push(dir2);
const shops2 = path.join(dir2, 'shops.json');
const watched = { status: 'ok', commercial: 'ok', manual: true, checkedAt: todayJST, checkedBy: '目視確認', url: 'https://t-watch.test/policies/terms-of-service' };
writeFileSync(shops2, JSON.stringify({ commercial: false, shops: [
  { id: 'tok', name: '規約OKの店', url: 'https://t-ok.test/' },
  { id: 'tng', name: '規約で禁止の店', url: 'https://t-ng.test/' },
  { id: 'tnone', name: '規約が無い店', url: 'https://t-none.test/' },
  { id: 'man', name: '目で確かめた店', url: 'https://t-ng.test/', terms: { status: 'ok', commercial: 'ok', manual: true, checkedAt: '2026-10-01', checkedBy: '目視確認' } },
  { id: 'tw', name: '規約が変わる店', url: 'https://t-watch.test/', terms: watched },
  { id: 'tp', name: '許諾をもらった店', url: 'https://t-watch.test/', terms: { ...watched, status: 'permission' } },
] }));
const logT = path.join(dir2, 'reqT.log');
console.log(run(dir2, 'scripts/terms.mjs', [], { MOCK_LOG: logT }));
assert.ok(!/^api /m.test(read(logT)), '既定（キーワード）の規約確認では API を呼ばない');
let t = Object.fromEntries(readJ(shops2).shops.map((s) => [s.id, s.terms]));
assert.deepEqual([t.tok.status, t.tok.url], ['ok', 'https://t-ok.test/policies/terms-of-service'], '禁止がなければ ok');
assert.deepEqual([t.tng.status, t.tng.commercial, t.tng.url], ['ng', 'ng', 'https://t-ng.test/terms'], 'スクレイピング禁止なら ng。規約はトップページのリンクから見つける');
assert.equal(t.tnone.status, 'review', '規約が見つからなければ要確認');
assert.equal(t.man.checkedBy, '目視確認', '目で確かめた記録は上書きしない');
assert.deepEqual([t.tw.status, t.tw.changed, t.tw.watch.automated, t.tw.watch.at], ['ok', undefined, 'not_mentioned', todayJST], '集めているお店の規約を見張りはじめる（メニューの文言は読まない）');
// 30日たって読みなおしたら、自動収集の禁止が加わっていた
conf = readJ(shops2);
conf.shops.forEach((s) => { if (s.terms?.watch) s.terms.watch.at = daysAgo(31); });
writeFileSync(shops2, JSON.stringify(conf));
const sumT = path.join(dir2, 'summaryT.md');
run(dir2, 'scripts/terms.mjs', [], { MOCK_TERMS_NEW: '1', GITHUB_STEP_SUMMARY: sumT });
t = Object.fromEntries(readJ(shops2).shops.map((s) => [s.id, s.terms]));
assert.deepEqual([t.tw.status, t.tw.changed, t.tw.watch.automated], ['ng', todayJST, 'prohibited'], '禁止が加わったら、そのお店の収集を止める');
assert.deepEqual([t.tp.status, t.tp.changed], ['permission', todayJST], '許諾のあるお店は、知らせるだけで止めない');
assert.match(read(sumT), /規約が変わる店: 規約に自動収集を禁止する書き方が加わったため、このお店の収集を止めました/);
run(dir2, 'scripts/terms.mjs', ['--mark', 'tw', 'ok', '--note', '読みなおして問題なし']);
t = Object.fromEntries(readJ(shops2).shops.map((s) => [s.id, s.terms]));
assert.deepEqual([t.tw.status, t.tw.changed, t.tw.note], ['ok', undefined, '読みなおして問題なし'], '読みなおして記録すると、知らせは消える');
run(dir2, 'scripts/terms.mjs', [], { MOCK_TERMS_NEW: '1' });
assert.equal(readJ(shops2).shops.find((s) => s.id === 'tw').terms.status, 'ok', '同じ内容のままなら、もう止めない');
run(dir2, 'scripts/terms.mjs', ['--mark', 'tng', 'permission', '--note', '2026-10-20 メールで許諾']);
t = Object.fromEntries(readJ(shops2).shops.map((s) => [s.id, s.terms]));
assert.deepEqual([t.tng.status, t.tng.commercial, t.tng.manual], ['permission', 'ok', true], '許諾を記録できる');
assert.match(run(dir2, 'scripts/terms.mjs', ['--list']), /tng: 自動収集 permission/);

/* ---------- Claude を使う設定（キーがあるときだけ） ---------- */
const dir3 = tmp('claude'); dirs.push(dir3);
writeFileSync(path.join(dir3, 'shops.json'), JSON.stringify({ commercial: false, shops: [{ id: 'a', name: 'A店', url: 'https://shop-a.test/', terms: OK }, { id: 'tng', name: '規約で禁止の店', url: 'https://t-ng.test/' }] }));
const logC = path.join(dir3, 'reqC.log');
run(dir3, 'scripts/collect.mjs', [], { MOCK_LOG: logC, EXTRACTOR: 'claude' });
const c3 = Object.fromEntries(readJ(path.join(dir3, 'beans.json')).beans.map((x) => [x.id, x]));
assert.match(read(logC), /^api record_bean claude-haiku-5-5$/m, 'claude では Haiku 5.5 で読む');
const e3 = c3['a:eth-gesha'];
assert.deepEqual([e3.country, e3.makerKind, e3.roast, e3.processGroups, e3.notes], ['エチオピア', '農園', '浅煎り', ['ナチュラル'], ['ジャスミン', 'ピーチ']], 'Claude の値の末尾の改行を落とす');
assert.deepEqual(c3['a:long-notes'].notes, ['ジャスミン'], '長い文や句点のある風味は載せない');
assert.ok(!c3['a:glass']);
const logT3 = path.join(dir3, 'reqT.log');
run(dir3, 'scripts/terms.mjs', [], { MOCK_LOG: logT3, EXTRACTOR: 'claude' });
assert.match(read(logT3), /^api record_terms claude-haiku-5-5$/m, 'claude では規約も Claude が読む');
assert.equal(readJ(path.join(dir3, 'shops.json')).shops.find((s) => s.id === 'tng').terms.status, 'ng', 'Claude の値の末尾に改行があっても ng');

// hybrid：ルールで読めなかった商品だけ Claude に任せる
const dir4 = tmp('hybrid'); dirs.push(dir4);
writeFileSync(path.join(dir4, 'shops.json'), JSON.stringify({ commercial: false, shops: [{ id: 'a', name: 'A店', url: 'https://shop-a.test/', terms: OK }] }));
const logH = path.join(dir4, 'reqH.log');
run(dir4, 'scripts/collect.mjs', [], { MOCK_LOG: logH, EXTRACTOR: 'hybrid' });
assert.equal((read(logH).match(/^api record_bean /gm) || []).length, 1, 'Claude に任せたのは1件だけ');
assert.equal(readJ(path.join(dir4, 'beans.json')).beans.find((x) => x.name === 'Mystery Lot').country, 'ペルー', '読めなかった商品は Claude が補う');
// キーが無ければ、claude を指定してもルールで動く
assert.match(run(dir4, 'scripts/collect.mjs', [], { EXTRACTOR: 'claude', ANTHROPIC_API_KEY: '' }), /ルールで読み取ります/);
// 古い形式のキャッシュは作りなおす
writeFileSync(path.join(dir4, 'cache.json'), JSON.stringify({ abc123: { data: { is_coffee_beans: true }, used: todayJST } }));
run(dir4, 'scripts/collect.mjs');
assert.deepEqual([readJ(path.join(dir4, 'cache.json'))._v, readJ(path.join(dir4, 'cache.json')).abc123], [2, undefined]);

/* ---------- データの保存（実行中に手で編集されていても保存できる） ---------- */
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
if (hasGit) {
  const g = tmp('git'); dirs.push(g);
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  const origin = path.join(g, 'origin.git'); const bot = path.join(g, 'bot'); const me = path.join(g, 'me');
  git(g, 'init', '-q', '--bare', '-b', 'main', origin);
  git(g, 'clone', '-q', origin, me);
  mkdirSync(path.join(me, 'data'));
  writeFileSync(path.join(me, 'data', 'shops.json'), '{\n  "shops": [\n    "a"\n  ]\n}\n');
  writeFileSync(path.join(me, 'data', 'beans.json'), '{"beans":1}\n');
  writeFileSync(path.join(me, 'README.md'), 'v1\n');
  git(me, 'add', '.'); git(me, 'commit', '-q', '-m', 'init'); git(me, 'push', '-q', 'origin', 'HEAD:main');
  git(g, 'clone', '-q', origin, bot);
  mkdirSync(path.join(bot, '.github'));
  cpSync('.github/save-data.sh', path.join(bot, '.github', 'save-data.sh'));
  // 実行のあいだに、手で README とお店の一覧を編集した
  writeFileSync(path.join(me, 'README.md'), 'v2\n');
  writeFileSync(path.join(me, 'data', 'shops.json'), '{\n  "shops": [\n    "a-edited-by-hand"\n  ]\n}\n');
  git(me, 'commit', '-q', '-am', 'manual edit'); git(me, 'push', '-q', 'origin', 'HEAD:main');
  // 自動の実行は、豆のデータと、お店の一覧の同じ行を書きかえた
  writeFileSync(path.join(bot, 'data', 'beans.json'), '{"beans":2}\n');
  writeFileSync(path.join(bot, 'data', 'shops.json'), '{\n  "shops": [\n    "a-by-bot"\n  ]\n}\n');
  const saved = execFileSync('bash', ['.github/save-data.sh', 'テスト'], { cwd: bot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GITHUB_REF_NAME: 'main' } });
  assert.match(saved, /保存しました/);
  git(me, 'pull', '-q', 'origin', 'main');
  assert.equal(read(path.join(me, 'data', 'beans.json')), '{"beans":2}\n', '豆のデータは保存される');
  assert.equal(read(path.join(me, 'README.md')), 'v2\n', '手で編集した内容は消さない');
  assert.match(read(path.join(me, 'data', 'shops.json')), /a-edited-by-hand/, '同じ行がぶつかったら、手で編集した内容を優先する');
  assert.match(execFileSync('bash', ['.github/save-data.sh'], { cwd: bot, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: 'main' } }), /変更はありませんでした/);
}

for (const p of dirs) if (existsSync(p)) rmSync(p, { recursive: true, force: true });
console.log('すべてのチェックに通りました');

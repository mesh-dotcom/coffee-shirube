// API を使わずに、商品ページの文章から事実の項目を読み取る（決まった見出しと言葉の辞書で探す）
// 読み取れなかった項目は空のまま。推測では埋めない。
// 実際のお店の書き方（英語の見出し、「English（カタカナ）」の併記、表、商品ページだけにある仕様欄）に合わせてある。
export const RULES_VERSION = 'r3'; // 読み取りのルールを変えたら上げる（キャッシュが作り直される）

const nfkc = (s) => String(s ?? '').normalize('NFKC');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s) => nfkc(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim(); // Nariño → narino
const KATA = 'ァ-ヶー';
const HAS_JA = /[ぁ-んァ-ヶ一-龠]/;

/* ---------- 辞書 ---------- */
const COUNTRIES = [
  ['エチオピア', ['ethiopia']], ['ケニア', ['ケニヤ', 'kenya']], ['ルワンダ', ['rwanda']], ['ブルンジ', ['burundi', 'ブルンディ']],
  ['タンザニア', ['tanzania']], ['ウガンダ', ['uganda']], ['コンゴ民主共和国', ['コンゴ', 'congo', 'drc']], ['マラウイ', ['マラウィ', 'malawi']],
  ['ザンビア', ['zambia']], ['イエメン', ['yemen']], ['パナマ', ['panama']], ['コスタリカ', ['costa rica']],
  ['エルサルバドル', ['エルサルバトール', 'エルサルバドール', 'el salvador']], ['グアテマラ', ['グァテマラ', 'ガテマラ', 'guatemala']],
  ['ホンジュラス', ['ホンデュラス', 'honduras']], ['ニカラグア', ['nicaragua']], ['メキシコ', ['mexico']], ['ジャマイカ', ['jamaica']],
  ['ドミニカ共和国', ['dominican']], ['ハイチ', ['haiti']], ['キューバ', ['cuba']], ['コロンビア', ['colombia']], ['エクアドル', ['ecuador']],
  ['ペルー', ['peru']], ['ボリビア', ['bolivia']], ['ブラジル', ['brazil', 'brasil']], ['中国', ['雲南', 'china', 'yunnan']], ['台湾', ['taiwan']],
  ['インドネシア', ['スマトラ', 'indonesia', 'sumatra']], ['東ティモール', ['ティモール', 'timor']], ['パプアニューギニア', ['papua new guinea']],
  ['ベトナム', ['ヴェトナム', 'vietnam', 'viet nam']], ['タイ', ['thailand']], ['ラオス', ['laos']], ['ミャンマー', ['myanmar']],
  ['フィリピン', ['philippines']], ['インド', ['india']], ['ネパール', ['nepal']], ['アメリカ（ハワイ）', ['ハワイ', 'hawaii', 'kona']],
];

const VARIETIES = [
  ['ピンクブルボン', ['pink bourbon']], ['レッドブルボン', ['red bourbon']], ['イエローブルボン', ['yellow bourbon']], ['オレンジブルボン', ['orange bourbon']],
  ['ブルボン', ['bourbon']], ['ゲイシャ', ['ゲシャ', 'geisha', 'gesha']], ['ティピカ', ['typica']], ['カトゥーラ', ['カツーラ', 'カトゥラ', 'caturra']],
  ['イエローカトゥアイ', ['イエローカツアイ', 'yellow catuai']], ['レッドカトゥアイ', ['レッドカツアイ', 'red catuai']], ['カトゥアイ', ['カツアイ', 'catuai']],
  ['パカマラ', ['pacamara']], ['パカス', ['pacas']], ['マラカトゥーラ', ['maracaturra']], ['マラゴジッペ', ['maragogype', 'maragogipe']],
  ['SL28', ['sl28', 'sl-28', 'sl 28']], ['SL34', ['sl34', 'sl-34', 'sl 34']], ['SL14', ['sl14', 'sl-14', 'sl 14']], ['ルイル11', ['ruiru 11', 'ruiru11', 'ルイル 11']],
  ['バティアン', ['batian']], ['K7', ['k7']], ['カスティージョ', ['カスティーヨ', 'castillo']], ['シドラ', ['sidra']],
  ['ウシュウシュ', ['ウシュ・ウシュ', 'wush wush', 'wushwush']], ['ジャバニカ', ['javanica']], ['ジャバ', ['java']], ['ムンドノーボ', ['ムンドノボ', 'mundo novo']],
  ['アカイア', ['acaia']], ['ビジャサルチ', ['ヴィラサルチ', 'villa sarchi', 'villasarchi']], ['ビジャロボス', ['villalobos']], ['カティモール', ['catimor']],
  ['サルチモール', ['sarchimor']], ['パライネマ', ['parainema']], ['ラウリーナ', ['laurina', 'bourbon pointu', 'ブルボンポワントゥ']], ['オバタ', ['obata']],
  ['マルセレッサ', ['marsellesa']], ['センテナリオ', ['centenario']], ['タビ', ['tabi']], ['チロソ', ['chiroso']], ['ルメスーダン', ['rume sudan', 'ルメ・スーダン']],
  ['ケント', ['kent']], ['S795', ['s795', 's.795']], ['イカトゥ', ['icatu']], ['ティモールハイブリッド', ['timor hybrid']], ['パチェ', ['pache']],
  ['エチオピア原種', ['ヘアルーム', 'エアルーム', 'ヘイルーム', 'heirloom', 'landrace', 'ランドレース', 'エチオピア在来種', '原生種']],
  ['74110', ['74110']], ['74112', ['74112']], ['74158', ['74158']], ['74165', ['74165']], ['クルメ', ['kurume']], ['ウォリショ', ['wolisho']], ['ディガ', ['dega']],
];

// 風味の言葉。3つ目は、サイトの風味タイプ（index.html の TASTES）でどこに入るはずか（テストで突き合わせる）
const FLAVORS = [
  ['ブルーベリー', ['blueberry'], 'fruity'], ['ラズベリー', ['raspberry'], 'fruity'], ['ストロベリー', ['いちご', '苺', 'strawberry'], 'fruity'],
  ['ブラックベリー', ['blackberry'], 'fruity'], ['クランベリー', ['cranberry'], 'fruity'], ['ベリー', ['ミックスベリー', 'berry', 'berries'], 'fruity'],
  ['カシス', ['blackcurrant', 'black currant', 'cassis'], 'fruity'], ['ブラックチェリー', ['black cherry'], 'fruity'], ['チェリー', ['さくらんぼ', 'cherry'], 'fruity'],
  ['プラム', ['すもも', 'plum'], 'fruity'], ['プルーン', ['prune'], 'fruity'], ['白桃', ['ホワイトピーチ', 'white peach'], 'fruity'],
  ['ピーチ', ['桃', 'イエローピーチ', 'peach'], 'fruity'], ['アプリコット', ['杏', 'あんず', 'apricot', 'appricot'], 'fruity'], ['ネクタリン', ['nectarine'], 'fruity'],
  ['ライチ', ['lychee', 'litchi'], 'fruity'], ['マンゴー', ['mango'], 'fruity'], ['パイナップル', ['pineapple'], 'fruity'],
  ['パッションフルーツ', ['passion fruit', 'passionfruit'], 'fruity'], ['トロピカルフルーツ', ['トロピカル', 'tropical fruit', 'tropical'], 'fruity'],
  ['グアバ', ['guava'], 'fruity'], ['パパイヤ', ['papaya'], 'fruity'], ['メロン', ['melon'], 'fruity'], ['スイカ', ['ウォーターメロン', 'watermelon'], 'fruity'],
  ['マスカット', ['muscat'], 'fruity'], ['巨峰', [], 'fruity'], ['デラウェア', [], 'fruity'], ['グレープ', ['ぶどう', 'ブドウ', 'grape'], 'fruity'],
  ['レーズン', ['raisin'], 'fruity'], ['青りんご', ['green apple'], 'fruity'], ['赤りんご', ['red apple'], 'fruity'], ['りんご', ['リンゴ', 'アップル', 'apple'], 'fruity'],
  ['洋梨', ['pear'], 'fruity'], ['和梨', [], 'fruity'], ['梨', [], 'fruity'], ['キウイ', ['kiwi'], 'fruity'], ['いちじく', ['イチジク', 'fig'], 'fruity'],
  ['ザクロ', ['pomegranate'], 'fruity'], ['ドライフルーツ', ['dried fruit'], 'fruity'], ['赤ワイン', ['red wine'], 'fruity'], ['ワイン', ['wine', 'winey', 'ワイニー'], 'fruity'],
  ['ココナッツ', ['coconut'], 'fruity'],
  ['ブラッドオレンジ', ['blood orange'], 'citrus'], ['オレンジ', ['orange'], 'citrus'], ['メイヤーレモン', ['マイヤーレモン', 'meyer lemon', 'mayer lemon'], 'citrus'],
  ['レモン', ['lemon'], 'citrus'], ['ライム', ['lime'], 'citrus'], ['グレープフルーツ', ['grapefruit'], 'citrus'], ['ゆず', ['柚子', 'yuzu'], 'citrus'],
  ['マンダリン', ['みかん', 'mandarin'], 'citrus'], ['タンジェリン', ['tangerine'], 'citrus'], ['ベルガモット', ['bergamot'], 'citrus'],
  ['シトラス', ['柑橘', 'citrus'], 'citrus'], ['すだち', [], 'citrus'], ['かぼす', [], 'citrus'],
  ['ジャスミンティー', ['jasmine tea'], 'floral'], ['ジャスミン', ['jasmine'], 'floral'], ['オレンジブロッサム', ['orange blossom'], 'floral'],
  ['フローラル', ['floral'], 'floral'], ['ローズ', ['バラ', 'rose'], 'floral'], ['ラベンダー', ['lavender'], 'floral'], ['キンモクセイ', ['金木犀', 'osmanthus'], 'floral'],
  ['エルダーフラワー', ['elderflower'], 'floral'], ['ハイビスカス', ['hibiscus'], 'floral'], ['カモミールティー', ['chamomile tea'], 'floral'],
  ['カモミール', ['chamomile'], 'floral'], ['バイオレット', ['すみれ', 'violet'], 'floral'],
  ['アールグレイ', ['earl grey', 'earl gray'], 'tea'], ['紅茶', ['black tea', 'tea'], 'tea'], ['緑茶', ['green tea'], 'tea'], ['烏龍茶', ['ウーロン茶', 'oolong'], 'tea'],
  ['ほうじ茶', [], 'tea'], ['ティーライク', ['tea-like', 'tea like'], 'tea'], ['レモングラス', ['lemongrass'], 'tea'], ['ハーブ', ['herbal', 'herb'], 'tea'],
  ['ミント', ['mint'], 'tea'], ['ルイボス', ['rooibos'], 'tea'],
  ['ミルクチョコレート', ['milk chocolate'], 'choco'], ['ダークチョコレート', ['dark chocolate'], 'choco'], ['チョコレート', ['チョコ', 'chocolate'], 'choco'],
  ['ココア', ['cocoa'], 'choco'], ['カカオ', ['cacao'], 'choco'], ['キャラメル', ['カラメル', 'caramel'], 'choco'], ['ブラウンシュガー', ['brown sugar'], 'choco'],
  ['黒糖', [], 'choco'], ['はちみつ', ['蜂蜜', 'ハチミツ', 'ハニー', 'honey'], 'choco'], ['メープル', ['maple'], 'choco'], ['バニラ', ['vanilla'], 'choco'],
  ['トフィー', ['toffee'], 'choco'], ['ヌガー', ['nougat'], 'choco'], ['プラリネ', ['praline'], 'choco'], ['モラセス', ['molasses'], 'choco'],
  ['ヘーゼルナッツ', ['hazelnut'], 'choco'], ['アーモンド', ['almond'], 'choco'], ['ピーナッツ', ['peanut'], 'choco'],
  ['マカダミアナッツ', ['マカダミア', 'macadamia'], 'choco'], ['カシューナッツ', ['cashew'], 'choco'], ['ピスタチオ', ['pistachio'], 'choco'],
  ['ナッツ', ['nutty', 'nuts', 'nut'], 'choco'], ['クッキー', ['cookie'], 'choco'], ['ビスケット', ['biscuit'], 'choco'],
  ['シナモン', ['cinnamon'], null], ['スパイス', ['spice', 'spicy'], null], ['クローブ', ['clove'], null], ['カルダモン', ['cardamom'], null],
  ['ジンジャー', ['ginger'], null], ['トマト', ['tomato'], null],
];
export const FLAVOR_GROUPS = new Map(FLAVORS.map(([name, , group]) => [name, group]));

// よく出てくる生産地域の英語表記 → カタカナ（お店によって英語とカタカナが混ざるのをそろえる）
const REGION_JA = {
  yirgacheffe: 'イルガチェフェ', 'yirga cheffe': 'イルガチェフェ', yrgacheffe: 'イルガチェフェ', sidama: 'シダマ', sidamo: 'シダマ', guji: 'グジ', oromia: 'オロミア',
  jimma: 'ジンマ', gedeo: 'ゲデオ', 'bench maji': 'ベンチ・マジ', limu: 'リム', limmu: 'リム', kaffa: 'カファ', harrar: 'ハラー', harar: 'ハラー', bensa: 'ベンサ',
  uraga: 'ウラガ', kochere: 'コチェレ', hambela: 'ハンベラ', shakiso: 'シャキッソ', 'west arsi': 'ウェストアルシ',
  nyeri: 'ニエリ', kirinyaga: 'キリニャガ', kiambu: 'キアンブ', embu: 'エンブ', muranga: 'ムランガ', "murang'a": 'ムランガ', machakos: 'マチャコス',
  nyamasheke: 'ニャマシェケ', huye: 'フイエ', gakenke: 'ガケンケ', rulindo: 'ルリンド', kayanza: 'カヤンザ', ngozi: 'ンゴジ',
  mbeya: 'ムベヤ', kilimanjaro: 'キリマンジャロ', arusha: 'アルーシャ', karatu: 'カラツ',
  huila: 'ウイラ', narino: 'ナリーニョ', cauca: 'カウカ', tolima: 'トリマ', antioquia: 'アンティオキア', risaralda: 'リサラルダ', quindio: 'キンディオ',
  caldas: 'カルダス', santander: 'サンタンデール', 'valle del cauca': 'バジェ・デル・カウカ', cundinamarca: 'クンディナマルカ',
  boquete: 'ボケテ', chiriqui: 'チリキ', volcan: 'ボルカン', tarrazu: 'タラス', 'west valley': 'ウエストバレー', 'central valley': 'セントラルバレー',
  'tres rios': 'トレスリオス', brunca: 'ブルンカ', antigua: 'アンティグア', huehuetenango: 'ウエウエテナンゴ', atitlan: 'アティトラン', coban: 'コバン',
  acatenango: 'アカテナンゴ', 'santa barbara': 'サンタバルバラ', marcala: 'マルカラ', copan: 'コパン', 'la paz': 'ラパス', intibuca: 'インティブカ',
  chalatenango: 'チャラテナンゴ', 'santa ana': 'サンタアナ', apaneca: 'アパネカ', ahuachapan: 'アウアチャパン', 'nueva segovia': 'ヌエバセゴビア',
  jinotega: 'ヒノテガ', matagalpa: 'マタガルパ', 'minas gerais': 'ミナスジェライス', cerrado: 'セラード', 'sul de minas': 'スルデミナス',
  'carmo de minas': 'カルモデミナス', mogiana: 'モジアナ', bahia: 'バイーア', 'espirito santo': 'エスピリトサント',
  cajamarca: 'カハマルカ', cusco: 'クスコ', junin: 'フニン', amazonas: 'アマソナス', loja: 'ロハ', pichincha: 'ピチンチャ', caranavi: 'カラナビ',
  yunnan: '雲南', aceh: 'アチェ', gayo: 'ガヨ', sumatra: 'スマトラ', toraja: 'トラジャ', bali: 'バリ', kintamani: 'キンタマーニ', flores: 'フローレス',
  'chiang mai': 'チェンマイ', 'chiang rai': 'チェンライ', alishan: '阿里山',
};

/* ---------- 言葉を探す ---------- */
// 短いカタカナ（タイ・インドなど）は、ほかの言葉の一部（スタイル・インドネシア）に当たらないように前後を見る
function aliasRegex(alias) {
  const a = nfkc(alias).toLowerCase();
  if (/^[a-z0-9][a-z0-9 .'-]*$/.test(a)) return new RegExp(`(?<![a-z0-9])${esc(a)}(?![a-z0-9])`, 'g');
  if (new RegExp(`^[${KATA}]{1,3}$`).test(a)) return new RegExp(`(?<![${KATA}])${esc(a)}(?![${KATA}])`, 'g');
  return new RegExp(esc(a), 'g');
}
function buildDict(entries) {
  const list = [];
  for (const [name, aliases] of entries) for (const a of [name, ...aliases]) list.push({ name, re: aliasRegex(a), len: [...a].length });
  return list.sort((x, y) => y.len - x.len); // 長い言葉から（ピンクブルボン → ブルボン）
}
// 商品名から地域を読むときに使う辞書。農園名や一般の言葉としてもよく出てくる名前は入れない
const TITLE_AMBIGUOUS = new Set(['santa barbara', 'santa ana', 'la paz', 'antigua', 'flores', 'bali', 'bahia', 'amazonas', 'cerrado', 'volcan', 'west valley',
  'central valley', 'loja', 'limu', 'limmu', 'harar', 'harrar', 'kaffa', 'copan', 'coban', 'brunca', 'sumatra', 'yunnan', 'caldas', 'santander', 'alishan']);
const TITLE_REGIONS = new Map();
for (const [en, name] of Object.entries(REGION_JA)) if (!TITLE_AMBIGUOUS.has(en)) TITLE_REGIONS.set(name, [...(TITLE_REGIONS.get(name) || []), en]);

// 国名として読むが、地域名でもある言葉（「生産地：スマトラ アチェ」から地域を取り出すときは消さない）
const REGION_LIKE = new Set(['スマトラ', 'sumatra', '雲南', 'yunnan', 'ハワイ', 'hawaii', 'kona']);
const DICT = {
  country: buildDict(COUNTRIES), variety: buildDict(VARIETIES), flavor: buildDict(FLAVORS),
  countryName: buildDict(COUNTRIES.map(([name, aliases]) => [name, aliases.filter((a) => !REGION_LIKE.has(a))])),
  region: buildDict([...TITLE_REGIONS]),
};

// 辞書の言葉が出てきた場所を空白に置きかえながら拾う（同じ場所を二重に数えない）
function sweep(dict, text) {
  let s = text;
  const hits = [];
  for (const d of dict) {
    d.re.lastIndex = 0;
    let m;
    while ((m = d.re.exec(s))) {
      hits.push({ name: d.name, at: m.index });
      s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
      d.re.lastIndex = m.index + m[0].length;
    }
  }
  const seen = new Set();
  return { rest: s, names: hits.sort((a, b) => a.at - b.at).map((h) => h.name).filter((n) => !seen.has(n) && seen.add(n)) };
}
// 文の中から辞書の言葉を、出てきた順に返す
const scan = (dict, text) => sweep(dict, nfkc(text).toLowerCase()).names;

// 風味ではない使われ方（コーヒーチェリー、ハニープロセス、品種名のオレンジブルボンなど）を除いてから風味の言葉を拾う
const NOT_FLAVOR = /コーヒーチェリー|coffee cherr(y|ies)|チェリー[をのが](収穫|選別|乾燥|摘|果肉|状態)|(ブラック|レッド|イエロー|ホワイト|ゴールデン)ハニー|ハニー(プロセス|製法|精製)|(black|red|yellow|white|golden) honey|honey process(ed)?|ワイン酵母|wine yeast/gi;
function scanFlavors(text) {
  const s = nfkc(text).toLowerCase().replace(NOT_FLAVOR, (m) => ' '.repeat(m.length));
  return sweep(DICT.flavor, sweep(DICT.variety, s).rest).names;
}

// 「Catuai（カトゥアイ）」「カトゥアイ（Catuai）」のような併記は、日本語のほうを使う
function ja(value) {
  const v = nfkc(value).trim();
  const m = /^([^()]*?)\s*\(([^()]+)\)\s*$/.exec(v);
  if (!m) return v;
  const [, a, b] = m;
  if (a && !HAS_JA.test(a) && HAS_JA.test(b)) return b.trim();
  if (HAS_JA.test(a) && !HAS_JA.test(b)) return a.trim();
  return v;
}
// 生産地域：英語だけならカタカナに直せるものは直す（「Oromia, Chewa」は直せる部分だけ）
function regionJa(value) {
  const v = ja(value);
  if (!v || HAS_JA.test(v)) return v;
  if (REGION_JA[fold(v)]) return REGION_JA[fold(v)];
  const parts = v.split(/\s*,\s*/);
  return parts.length > 1 ? parts.map((p) => REGION_JA[fold(p)] || p).join('、') : v;
}

/* ---------- 見出し（「品種：」など）を読む ---------- */
const LABELS = {
  country: ['生産国', '原産国', '国名', '国', 'country of origin', 'country'],
  origin: ['生産地', '原産地', '産地', 'origin'],
  region: ['生産地域', '生産エリア', '産地エリア', '生産地区', '地域名', '地域', '地区', '地方', 'エリア', '州', '県', 'region', 'area', 'province', 'department', 'zone'],
  farm: ['生産農園', '農園名', '農園', '農場', 'ファーム', 'エステート', 'farm name', 'farm', 'estate', 'finca'],
  producer: ['生産者名', '生産者', '農園主', '農家', 'オーナー', 'プロデューサー', 'producer', 'farmer', 'grower', 'owner'],
  station: ['ウォッシングステーション', 'ウォッシング・ステーション', '精製所名', '精製所', '水洗場', 'ウェットミル', 'ステーション', 'ファクトリー',
    'washing station', 'wet mill', 'processing station', 'station', 'factory', 'mill'],
  coop: ['生産組合', '組合', '農協', 'コーペラティブ', 'cooperative', 'co-op'],
  variety: ['栽培品種', '品種名', '品種', 'バラエティ', 'ヴァラエティ', 'varieties', 'variety', 'varietals', 'varietal', 'cultivar'],
  process: ['精製方法', '精製方式', '精製法', '精製', '精選方法', '精選', '生産処理', '加工方法', 'プロセス', 'processing method', 'process method', 'processing', 'process', 'method'],
  altitude: ['生産標高', '栽培標高', '標高', '高度', 'altitude', 'elevation', 'masl'],
  notes: ['テイスティングコメント', 'テイスティングノート', 'カッピングコメント', 'カッピングノート', 'カッピングプロファイル', 'カップコメント', 'カップノート',
    'カッププロファイル', 'フレーバーノート', 'フレーバープロファイル', 'フレーバーコメント', 'フレーバー特性', 'フレーバー', '風味特性', '風味の特徴', '風味', '味わい',
    'テイスティング', 'カッピング', 'テイスト', '香味', '香り', 'アロマ', 'tasting notes', 'tasting note', 'tasting comments', 'tasting comment', 'cupping notes',
    'cupping note', 'flavor notes', 'flavour notes', 'flavor profile', 'flavour profile', 'flavors', 'flavours', 'flavor', 'flavour', 'cup notes', 'cup profile',
    'notes', 'taste', 'aroma'],
  roast: ['焙煎度合い', '焙煎度数', '焙煎度', '焙煎', 'ローストレベル', 'ロースト度', 'ロースト', 'roast level', 'roast'],
};
const COFFEE_FIELDS = new Set(['variety', 'process', 'altitude']);
const WORD_FIELD = new Map();
for (const [f, ws] of Object.entries(LABELS)) for (const w of ws) WORD_FIELD.set(w.toLowerCase(), f);
const ALT = [...WORD_FIELD.keys()].sort((a, b) => b.length - a.length).map(esc).join('|');
const BULLET = '■□●○◆◇▶▷►★☆※・\\-';
const PRE = `(?:^|[\\s/|、,${BULLET}])`;
const RE_COLON = new RegExp(`${PRE}[【\\[(]?(${ALT})(?:\\s*/\\s*[a-z][a-z .]{0,20})?\\s*[】\\])]?\\s*[:：]`, 'gi');
const RE_BRACKET = new RegExp(`[【\\[](${ALT})[】\\]]`, 'gi');
const RE_LEADING = new RegExp(`^[${BULLET}\\s]*(${ALT})\\s+(.+)$`, 'i');
const RE_ALONE = new RegExp(`^[${BULLET}\\s【\\[(]*(${ALT})[】\\])]?\\s*[:：]?$`, 'i');
const isLabelLine = (l) => new RegExp(RE_COLON.source, 'i').test(l) || new RegExp(RE_BRACKET.source, 'i').test(l) || RE_ALONE.test(l) || !!cellLabel(l.split('\t')[0]);

// 表のセル（「品種 / Variety」のような併記も）が見出しなら、その項目名を返す
function cellLabel(cell) {
  const c = nfkc(cell).replace(new RegExp(`^[${BULLET}\\s【\\[(]+|[】\\])\\s:：]+$`, 'g'), '').toLowerCase();
  if (!c || c.length > 30) return null;
  if (WORD_FIELD.has(c)) return WORD_FIELD.get(c);
  for (const part of c.split(/\s*[/|]\s*/)) if (WORD_FIELD.has(part.trim())) return WORD_FIELD.get(part.trim());
  return null;
}

const cleanValue = (v) => v.replace(/\t/g, ' ').split(/。/)[0].replace(/^[\s:：]+/, '').replace(/[\s/|、,・.]+$/, '').trim();

// 文章から「見出し → 値」を拾う。entries は出てきた順（i は行番号）
export function readLabels(text) {
  const lines = nfkc(text).split('\n').map((l) => l.replace(/[ ]*\t[ ]*/g, '\t').trim()).filter(Boolean);
  const entries = [];
  const labelLines = new Set();
  const put = (i, field, value) => { if (field && value) { entries.push({ i, field, value }); labelLines.add(i); } };
  lines.forEach((raw, i) => {
    // 表の行：見出しのセル → 値のセル（1行に2組並ぶ表もある）
    if (raw.includes('\t')) {
      const cells = raw.split('\t').map((c) => c.trim()).filter(Boolean);
      let used = false;
      for (let k = 0; k + 1 < cells.length; k += 2) {
        const f = cellLabel(cells[k]);
        if (!f) break;
        put(i, f, cleanValue(k === 0 && cells.length % 2 ? cells.slice(1).join(' ') : cells[k + 1]));
        used = true;
        if (k === 0 && cells.length % 2) break;
      }
      if (used) return;
    }
    const line = raw.replace(/\t/g, ' ');
    const found = [];
    for (const re of [RE_COLON, RE_BRACKET]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) found.push({ field: WORD_FIELD.get(m[1].toLowerCase()), start: m.index, end: m.index + m[0].length });
    }
    found.sort((a, b) => a.start - b.start);
    const uniq = found.filter((f, k) => !k || f.start >= found[k - 1].end);
    if (uniq.length) {
      labelLines.add(i);
      uniq.forEach((f, k) => {
        let v = cleanValue(line.slice(f.end, k + 1 < uniq.length ? uniq[k + 1].start : undefined));
        if (!v && uniq.length === 1 && lines[i + 1] && !isLabelLine(lines[i + 1])) { v = cleanValue(lines[i + 1]); labelLines.add(i + 1); }
        put(i, f.field, v);
      });
      return;
    }
    const alone = RE_ALONE.exec(line); // 「品種」だけの行の次の行に値がある書き方
    if (alone && lines[i + 1] && !isLabelLine(lines[i + 1])) {
      put(i, WORD_FIELD.get(alone[1].toLowerCase()), cleanValue(lines[i + 1]));
      labelLines.add(i + 1);
      return;
    }
    const m = RE_LEADING.exec(line); // 「品種 ゲイシャ」のように空白で区切る書き方（日本語の見出しだけ）
    if (m && /[^\x00-\x7f]/.test(m[1])) put(i, WORD_FIELD.get(m[1].toLowerCase()), cleanValue(m[2]));
  });
  const fields = {};
  for (const e of entries) if (!fields[e.field]) fields[e.field] = e.value;
  return { fields, entries, labelLines, lines };
}

// 商品ページ全体の文章から、その豆の仕様欄（見出しが固まって並んでいるところ）だけを取り出す。
// 送料の表や関連商品を拾わないように、品種・精製・標高のどれかを含む、3項目以上のまとまりに限る。
export function specBlock(text) {
  const { entries, lines } = readLabels(text);
  const groups = [];
  for (const e of entries) {
    const g = groups[groups.length - 1];
    if (g && e.i - g.last <= 2) { g.entries.push(e); g.last = e.i; } else groups.push({ entries: [e], first: e.i, last: e.i });
  }
  let best = null;
  for (const g of groups) {
    const kinds = new Set(g.entries.map((e) => e.field));
    const coffee = [...kinds].filter((k) => COFFEE_FIELDS.has(k)).length;
    if (kinds.size < 3 || !coffee) continue;
    const score = coffee * 10 + kinds.size;
    if (!best || score > best.score) best = { ...g, score };
  }
  if (!best) return null;
  const fields = {};
  for (const e of best.entries) if (!fields[e.field]) fields[e.field] = e.value;
  return { fields, lines: lines.slice(best.first, best.last + 1).map((l) => l.replace(/\t/g, ' ')).slice(0, 30) };
}

/* ---------- 項目ごとの読み取り ---------- */
const PROCESS_RULES = [
  ['ハニー', /パルプド\s?ナチュラル|pulped natural|セミウォッシュ[トド]?|semi[- ]?washed/i],
  ['スマトラ式', /スマトラ式|wet[- ]?hull(ed)?|ウェットハル|ギリンバサ|giling basah/i],
  ['アナエロビック', /アナエロビック|アナエロ|anaerobic|嫌気性?/i],
  ['特殊発酵', /酵母|イースト|yeast|乳酸|lactic|カーボニック|carbonic|マセレーション|maceration|インフューズド|infused|インフュージョン|バレル|barrel|樽|サーマルショック|thermal shock|麹|koji|ファーメンテーション|fermentation|モスト|mosto/i],
  ['ハニー', /ハニー|honey/i],
  ['ウォッシュト', /ウォッシュ[トド]|washed|水洗/i],
  ['ナチュラル', /ナチュラル|natural|乾燥式|非水洗|dry process|天日乾燥/i],
];
function processGroups(text) {
  let s = nfkc(text);
  const hits = [];
  for (const [g, re] of PROCESS_RULES) {
    const r = new RegExp(re.source, 'gi');
    let m;
    while ((m = r.exec(s))) {
      hits.push(g);
      s = s.slice(0, m.index) + ' '.repeat(m[0].length) + s.slice(m.index + m[0].length);
    }
  }
  const order = ['ウォッシュト', 'ナチュラル', 'ハニー', 'アナエロビック', '特殊発酵', 'スマトラ式'];
  return [...new Set(hits)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
const PLAIN_PROCESS = /^(fully |full )?(washed|natural|honey|anaerobic)( process)?$|^(ウォッシュ[トド]|ナチュラル|ハニー|アナエロビック|水洗式|乾燥式|スマトラ式|フルウォッシュ[トド])(プロセス|製法)?$/i;
const PROCESS_NAME_JA = {
  'double anaerobic': 'ダブルアナエロビック', 'anaerobic natural': 'アナエロビックナチュラル', 'anaerobic washed': 'アナエロビックウォッシュト',
  'anaerobic honey': 'アナエロビックハニー', 'carbonic maceration': 'カーボニックマセレーション', 'thermal shock': 'サーマルショック',
  'black honey': 'ブラックハニー', 'red honey': 'レッドハニー', 'yellow honey': 'イエローハニー', 'white honey': 'ホワイトハニー',
  'pulped natural': 'パルプドナチュラル', 'semi washed': 'セミウォッシュト', 'double fermentation': 'ダブルファーメンテーション',
  'yeast fermentation': 'イースト発酵', 'lactic fermentation': '乳酸発酵',
};
function processNote(value) {
  const v = ja(value);
  if (!v || PLAIN_PROCESS.test(v)) return null;
  return PROCESS_NAME_JA[v.toLowerCase().replace(/[\s-]+/g, ' ')] || v;
}

const NUM = '(\\d{1,2}[,.]\\d{3}|\\d{3,4})';
const toNum = (s) => parseInt(s.replace(/[,.]/g, ''), 10);
const fmtM = (n) => n.toLocaleString('en-US');
function altitude(text, needUnit) {
  const s = nfkc(text);
  const range = new RegExp(`${NUM}\\s*(?:m|メートル|masl)?\\s*(?:-|~|〜|–|—|ー|to|から)\\s*${NUM}\\s*(m(?![a-z])|メートル|masl|meters?)?`, 'i').exec(s);
  if (range && (range[3] || !needUnit)) {
    const a = toNum(range[1]); const b = toNum(range[2]);
    if (a >= 300 && b <= 3500 && a < b) return `${fmtM(a)}–${fmtM(b)}m`;
  }
  const one = new RegExp(`${NUM}\\s*(m(?![a-z])|メートル|masl|meters?)${needUnit ? '' : '?'}`, 'i').exec(s);
  if (one && (one[2] || !needUnit)) {
    const a = toNum(one[1]);
    if (a >= 300 && a <= 3500) return `${fmtM(a)}m`;
  }
  return null;
}

// 焙煎度。「焙煎 LIGHT UP COFFEE」（焙煎したお店の名前）のような行を浅煎りと読まないよう、焙煎度の言葉そのものだけを見る
const ROAST_KANJI = /(極浅|極深|中浅|中深|浅|中|深)煎り?/;
const KANJI_ROAST = { 極浅: '浅煎り', 浅: '浅煎り', 中浅: '中浅煎り', 中: '中煎り', 中深: '中深煎り', 深: '深煎り', 極深: '深煎り' };
const ROAST_WORD = {
  ライト: '浅煎り', シナモン: '浅煎り', ミディアム: '中浅煎り', ハイ: '中煎り', シティ: '中深煎り', フルシティ: '中深煎り', フレンチ: '深煎り', イタリアン: '深煎り',
  light: '浅煎り', cinnamon: '浅煎り', 'medium light': '中浅煎り', 'light medium': '中浅煎り', medium: '中煎り', high: '中煎り', city: '中深煎り',
  'full city': '中深煎り', 'medium dark': '中深煎り', dark: '深煎り', french: '深煎り', italian: '深煎り',
};
function roastOf(value) {
  const v = nfkc(value).trim();
  const k = ROAST_KANJI.exec(v);
  if (k) return KANJI_ROAST[k[1]];
  const word = v.toLowerCase().replace(/\s*(ロースト|roast(ed)?)\s*$/i, '').replace(/[\s-]+/g, ' ').trim();
  return ROAST_WORD[word] || null;
}
const ROAST_EN = /(?<![a-z])(light|medium[- ]light|medium[- ]dark|medium|dark)[- ]roast(ed)?(?![a-z])/i;

/* ---------- 風味の言葉 ---------- */
const FLAVOR_EN = new Map();
for (const [name, aliases] of FLAVORS) for (const a of aliases) if (/^[a-z]/.test(a)) FLAVOR_EN.set(a, name);
const MODIFIER = {
  white: 'ホワイト', red: 'レッド', black: 'ブラック', green: 'グリーン', yellow: 'イエロー', pink: 'ピンク', purple: 'パープル', blue: 'ブルー', golden: 'ゴールデン',
  dark: 'ダーク', milk: 'ミルク', dried: 'ドライ', ripe: '完熟', fresh: 'フレッシュ', sweet: 'スイート', candied: 'キャンディ', baked: 'ベイクド', wild: 'ワイルド',
};
// 口当たりや余韻など、風味そのものではない言葉は載せない
const TEXTURE_PHRASE = /(余韻|口当たり|質感|ボディ|後味|アフターテイスト|マウスフィール|酸味|酸質|甘さ|甘み|バランス|コク|飲み心地|舌触り|フィニッシュ|テクスチャ)/;
const TEXTURE_WORD = /^(スイート|スウィート|ジューシー|クリーン|スムース|スムーズ|ラウンド|シルキー|クリーミー|なめらか|まろやか|すっきり|爽やか|さわやか|複雑|上品|ブライト|リッチ|シロッピー|ウェルバランス|透明感)$/;
const TEXTURE_EN = /^(smooth|round|juicy|clean|bright|silky|creamy|sweet|complex|balanced|well[- ]balanced|syrupy|delicate|elegant|rich|mellow|crisp|lingering|velvety|soft|long ?(after|finish)(taste)?|(.+ )?(body|acidity|finish|aftertaste|after ?taste|mouthfeel|sweetness|texture))$/i;

// 英語の風味（"White Grape"）をカタカナにする。辞書に無い言葉はそのまま
function noteFromEnglish(tok) {
  const t = tok.toLowerCase().replace(/\s+/g, ' ').trim();
  if (FLAVOR_EN.has(t)) return [FLAVOR_EN.get(t)];
  const words = t.split(' ');
  const mods = [];
  while (words.length > 1 && MODIFIER[words[0]]) mods.push(MODIFIER[words.shift()]);
  if (mods.length && FLAVOR_EN.has(words.join(' '))) return [mods.join('') + FLAVOR_EN.get(words.join(' '))];
  const hits = scanFlavors(t);
  return hits.length ? hits : [tok.trim()];
}
// 見出しの値（「ジャスミン、ピーチ」）を単語に分ける
function splitNotes(value) {
  const v = nfkc(value);
  let toks = v.split(/[、,/・;|&+]|\s{2,}|\s+-\s+|\s+and\s+/i);
  if (toks.length === 1 && / /.test(v) && !/[a-z]/i.test(v)) toks = v.split(/\s+/);
  const out = [];
  for (let t of toks) {
    t = t.trim().replace(/(など|等|etc\.?|のような|のよう|みたいな|のニュアンス|ニュアンス|like)$/i, '').trim();
    if (!t) continue;
    if (!HAS_JA.test(t)) { if (!TEXTURE_EN.test(t)) out.push(...noteFromEnglish(t)); continue; }
    if (TEXTURE_WORD.test(t)) continue;
    if (TEXTURE_PHRASE.test(t) || [...t].length > 16) { out.push(...scanFlavors(t)); continue; } // 文になっていたら、中の風味の言葉だけ拾う
    out.push(t);
  }
  return [...new Set(out)].filter((t) => [...t].length <= 16);
}

function makerOfTitle(title) {
  const m = /([^\s、,|/()「」[\]]{2,20}?)(農園|ファーム)/.exec(nfkc(title));
  return m ? m[1] : null;
}

/* ---------- 豆かどうか ---------- */
const NOT_BEANS = /(ドリップバッグ|ドリップパック|コーヒーバッグ|コーヒーパック|ティーバッグ|ティーパック|ディップ|dip ?style|dip ?bags?|\d+\s*bags?\b|[×x]\s*\d+\s*パック|カフェオレベース|リキッド|ボトル|缶コーヒー|インスタント|カプセル|capsule|カクテル|cocktail|drip ?bags?|coffee ?bags?|tea ?bags?|セット|\bset\b|飲み比べ|アソート|assort|詰め合わせ|セレクション|サンプラー|sampler|\btrio\b|トリオ|ギフト|\bgift\b|定期便|定期購入|サブスク|subscription|coffee ?club|コーヒークラブ|生豆|green (coffee|beans?)|福袋|みくじ|bundle|チケット|ticket|ワークショップ|workshop|セミナー|seminar|レッスン|(?<![a-z0-9])[2-9]\s*種)/i;
const COFFEE_CUE = /(コーヒー|珈琲|coffee|豆|bean|焙煎|roast|エスプレッソ|espresso|シングルオリジン|single origin)/i;
const BLEND = /(ブレンド|blend)/i;
const SINGLE = /(シングルオリジン|single ?origin)/i;
const SOLD_OUT = /(sold\s*out|売り切れ|売切れ|在庫切れ|品切れ|在庫なし)/i;

/* ---------- 本体 ---------- */
// item: { name, text, productType, tags, variants, pageSpec }（listShopify / listGeneric が作るもの）
//   text      商品説明の文章（products.json の body_html か、商品ページの本文）
//   pageSpec  商品ページにある仕様欄（specBlock の結果）。説明に見出しが無いお店は、ここから読む
export function extractByRules(item) {
  const title = nfkc(item.name);
  const head = `${title}\n${nfkc(item.productType)}`;
  const text = nfkc(item.text);
  const body = readLabels(text);
  const fields = { ...(item.pageSpec?.fields || {}), ...body.fields }; // 説明に書いてあれば、そちらを優先

  const titleCountries = scan(DICT.country, title);
  const country = (fields.country && scan(DICT.country, fields.country)[0])
    || (fields.origin && scan(DICT.country, fields.origin)[0]) || titleCountries[0] || scan(DICT.country, text)[0] || null;
  let region = fields.region || null;
  if (!region && fields.origin) { // 「生産地：エチオピア イルガチェフェ」「生産地：Tarrazu」→ 国名を除いた残りが地域
    const src = nfkc(fields.origin);
    const rest = sweep(DICT.countryName, src.toLowerCase()).rest;
    let kept = '';
    for (let k = 0; k < src.length; k++) kept += rest.length === src.length && rest[k] === ' ' ? ' ' : src[k];
    kept = kept.replace(/\s+/g, ' ').replace(/^[\s,、/・-]+|[\s,、/・-]+$/g, '');
    if (kept) region = kept;
  }
  region = region ? regionJa(region) : (sweep(DICT.region, fold(title)).names[0] || null); // 見出しが無ければ、商品名にある有名な産地名だけ

  let maker = null; let makerKind = null;
  if (fields.farm) { maker = ja(fields.farm); makerKind = '農園'; }
  else if (fields.station) { maker = ja(fields.station); makerKind = '精製所'; }
  else if (fields.producer) { maker = ja(fields.producer); makerKind = '生産者'; }
  else if (fields.coop) { maker = ja(fields.coop); makerKind = '生産者'; }
  else if (makerOfTitle(title)) { maker = makerOfTitle(title); makerKind = '農園'; }
  const producer = fields.producer ? ja(fields.producer) : null;
  const station = fields.station ? ja(fields.station) : null;

  let varieties = [];
  if (fields.variety) {
    const known = scan(DICT.variety, fields.variety);
    const rest = fields.variety.split(/[、,/・&+()]|\s+and\s+/i).map((t) => t.trim().replace(/(?<=[ァ-ヶーA-Za-z0-9])種$/, '')).filter((t) => t && [...t].length <= 20 && !scan(DICT.variety, t).length);
    varieties = [...known, ...rest];
  }
  if (!varieties.length) varieties = scan(DICT.variety, `${title}\n${text}`);

  let groups = fields.process ? processGroups(fields.process) : [];
  if (!groups.length) groups = processGroups(title);
  if (!groups.length) {
    const strong = text.match(/ナチュラルプロセス|ナチュラル精製|natural process|washed|ウォッシュ[トド]|水洗式|アナエロビック|anaerobic|嫌気性発酵|ハニープロセス|honey process|パルプド\s?ナチュラル|カーボニック\s?マセレーション|carbonic maceration|スマトラ式|wet[- ]?hulled/gi);
    if (strong) groups = processGroups(strong.join(' '));
  }

  let notes = fields.notes ? splitNotes(fields.notes) : [];
  if (!notes.length) { // 見出しが無ければ、風味の言葉が2つ以上並んでいる文から拾う
    const units = body.lines.flatMap((l, i) => (body.labelLines.has(i) ? [] : l.split(/(?<=。)/)));
    for (const u of units) {
      if (notes.length >= 6) break;
      const hit = scanFlavors(u);
      if (hit.length >= 2) notes.push(...hit.filter((h) => !notes.includes(h)));
    }
  }

  // 焙煎度：見出しの値か、商品名・種類・タグにある言葉だけ（説明の文章からは読まない）
  const short = `${head}\n${nfkc(item.tags)}`;
  const roast = (fields.roast && roastOf(fields.roast))
    || (ROAST_KANJI.test(short) ? KANJI_ROAST[ROAST_KANJI.exec(short)[1]] : null)
    || (ROAST_EN.test(short) ? roastOf(ROAST_EN.exec(short)[1]) : null);

  const alt = (fields.altitude && altitude(fields.altitude, false))
    || altitude(body.lines.filter((l) => /(標高|altitude|elevation|masl)/i.test(l)).join('\n'), true);

  // 豆だと言える手がかり：産地・品種・精製・標高のどれかが読めた、種類やタグが「豆」、グラム売りでコーヒーの商品名、のいずれか。
  // 説明文に「コーヒー」とあるだけの商品（グラスやお菓子）は豆として載せない
  const notBeans = NOT_BEANS.test(head);
  const typeTags = `${nfkc(item.productType)} ${nfkc(item.tags)}`;
  // 商品名に「ブレンド」と書かないお店もあるので、タグの「ブレンド」も見る（シングルオリジンのタグもあれば、そちらを信じる）
  const tags = nfkc(item.tags);
  const blend = BLEND.test(head) || (BLEND.test(tags) && !SINGLE.test(tags)) || new Set(titleCountries).size >= 2;
  const byGram = (item.variants || []).some((v) => /\d\s*(g|kg)(?![a-z])/i.test(nfkc(v.title))) || (!item.variants && /\d{2,4}\s?(g|グラム)(?![a-z])/i.test(text));
  const coffee = !!country || varieties.length > 0 || groups.length > 0 || !!alt || /豆|beans?/i.test(typeTags)
    || (byGram && (COFFEE_CUE.test(`${head} ${typeTags}`) || blend));

  let price = null; let grams = null;
  if (!item.variants) {
    const p = /[¥￥]\s?(\d{1,3}(?:,\d{3})+|\d{3,6})|(\d{1,3}(?:,\d{3})+|\d{3,6})\s?円/.exec(text);
    if (p) price = parseInt((p[1] || p[2]).replace(/,/g, ''), 10);
    const g = /(\d{2,4})\s?(g|グラム)(?![a-z])/i.exec(text);
    if (g) grams = parseInt(g[1], 10);
  }

  return {
    is_coffee_beans: !notBeans && coffee,
    single_origin: !blend,
    product_name: item.variants ? null : (title.split(/\s[|｜\-–—]\s|｜/)[0].trim() || null),
    country, region,
    maker, maker_kind: maker ? makerKind : null,
    producer: producer && producer !== maker ? producer : null,
    station: station && station !== maker ? station : null,
    varieties,
    process_groups: groups,
    process_note: fields.process ? processNote(fields.process) : null,
    altitude: alt,
    roast,
    notes: notes.slice(0, 6),
    price_yen: price, grams,
    sold_out: !item.variants && SOLD_OUT.test(text),
  };
}

// 読み取りが薄い（Claude に任せたほうがよい）か
export const isWeak = (r) => r.is_coffee_beans && r.single_origin && (!r.country || (!r.varieties.length && !r.process_groups.length && !r.notes.length));

/* ---------- Shopify 以外のお店：一覧ページから商品ページのリンクを選ぶ ---------- */
const ITEM_PATH = /\/(products?|items?|goods|detail|item_detail|product_detail)\/[^/]+|[?&](pid|product_id|item_id|goods_id)=/i;
const NOT_ITEM = /\/(cart|login|account|categor(y|ies)|tags?|blog|news|contact|about|faq|polic(y|ies)|terms|company|search)(\/|$)/i;
export function pickLinksByRules(links, shop, listUrls = []) {
  const re = shop.itemPattern ? new RegExp(shop.itemPattern) : ITEM_PATH;
  return [...links.keys()].filter((u) => {
    const p = new URL(u);
    if (listUrls.includes(u)) return false;
    const path = p.pathname + p.search;
    return re.test(path) && !NOT_ITEM.test(p.pathname);
  });
}

/* ---------- 利用規約（キーワードで判定する） ---------- */
const AUTO = /(スクレイピング|スクレーピング|クローリング|クローラ|クロール|ロボット|スパイダー|(?<![a-z])bots?(?![a-z])|自動(的な|化された)?(手段|方法|プログラム|ツール|ソフトウェア|収集|取得)|機械的(な)?(手段|方法)|データマイニング|scrap(e|ing)|crawl(er|ing)?|spider|robots?|automated (means|access|tools?|systems?)|data mining)/i;
const COMM = /(商業(的|目的|利用)|営利(目的)?|商用)|commercial/i;
const USE = /(利用|使用|使う|use)/i;
const REPRO = /(複製|転載|転用|二次利用|無断使用|reproduc|redistribut|republish)/i;
const NG = /(禁止|禁じ|してはならない|しないでください|行わない(もの)?とします|お断り|できません|prohibit|not (be )?(permitted|allowed)|may not|must not|shall not)/i;
const NG_HEAD = /(禁止事項|禁止行為|次の(各号の)?行為|以下の行為|次に掲げる行為|prohibited|you (may|must|shall) not|you agree not to)/i;
const IS_TERMS = /(利用規約|規約|利用条件|ご利用にあたって|terms of (service|use)|terms and conditions)/i;

export function judgeTermsByRules(rawText) {
  const text = nfkc(rawText);
  const units = text.split(/\n|(?<=[。．!?！？])/).map((s) => s.trim()).filter(Boolean);
  const articleBefore = (i) => {
    for (let k = i; k >= 0; k--) { const m = /第\s*(\d+)\s*条/.exec(units[k]); if (m) return `第${m[1]}条`; }
    return '該当箇所';
  };
  const judge = (test) => {
    let level = 'not_mentioned'; let ref = null;
    for (let i = 0; i < units.length; i++) {
      if (!test(units[i])) continue;
      const windowText = units.slice(Math.max(0, i - 8), i).join(' ');
      if (NG.test(units[i]) || NG_HEAD.test(windowText)) return { level: 'prohibited', ref: articleBefore(i) };
      level = 'unclear'; ref = ref || articleBefore(i);
    }
    return { level, ref };
  };
  const auto = judge((u) => AUTO.test(u));
  const comm = judge((u) => COMM.test(u) && USE.test(u));
  const repro = judge((u) => REPRO.test(u));
  const clauses = [];
  if (auto.ref) clauses.push({ ref: auto.ref, summary: auto.level === 'prohibited' ? '自動的な手段での収集（スクレイピングなど）の禁止' : '自動的な手段での収集についての定め（禁止かどうかは要確認）' });
  if (comm.ref) clauses.push({ ref: comm.ref, summary: comm.level === 'prohibited' ? '情報の商業的な利用の禁止' : '商業的な利用についての定め（要確認）' });
  if (repro.ref) clauses.push({ ref: repro.ref, summary: repro.level === 'prohibited' ? 'コンテンツの複製・転載の禁止' : '複製・転載についての定め（要確認）' });
  return { is_terms: IS_TERMS.test(text), automated_access: auto.level, commercial_use: comm.level, reproduction: repro.level, clauses };
}

/* Tartarus Simulator: rules engine.
 * Game state and rules only, with no DOM access, so the same file runs in the
 * page and under Node for tests. Every random roll draws from a seeded stream,
 * which makes a run replayable from its seed. Public actions validate first and
 * only then change the state, and return { ok, events } or { ok: false, reason }.
 *
 * The block is a ring of 16 cells numbered clockwise. Cell 01 is the warden's
 * office, where every run starts; nothing is ever held there, so 15 cells hold
 * prisoners. Each morning offers a few patrol destinations ahead of the warden,
 * and a chain reaction opens every sealed cell on the clockwise walk to the
 * next destination. */
(function (root) {
  'use strict';

  const VERSION = 3;
  const CELL_COUNT = 16;
  const OFFICE = 0;
  const SUPREME = 4;
  const RAINBOW = 5;
  // The vault holds 10 Rainbows (its panel has 10 slots). Once it's full,
  // inmates rise no higher than Supreme (the user, 2026-10-17: "it caps at
  // 10, then only allows things to go up to red max").
  const VAULT_SLOTS = 10;
  const LOG_LIMIT = 400;

  const TIERS = ['普通', '魔法', '稀有', '傳奇', '至臻', '綺彩'];

  const BEASTS = ['mammoth', 'lion', 'wolf', 'rat'];
  const BEAST_INFO = {
    mammoth: { name: '巨象', en: 'Mammoth' },
    lion: { name: '狂獅', en: 'Lion' },
    wolf: { name: '頭狼', en: 'Wolf' },
    rat: { name: '碩鼠', en: 'Rat' },
  };

  // Who eats whom: each beast has one meal, in a loop, and Mammoths also eat
  // Wolves and Lions also eat Rats, at the eater's rarity. These second
  // meals were first seen live on Legendary eaters (2026-10-16), and kept
  // to Legendary and up; players' games then offered them at every rarity,
  // as first meals and mid-chain (reports 206, 208, 306, 322, 323, and the
  // jaws markers on 120 of 123 such boards), so since 2026-10-17 they're
  // at every rarity (the user: "fix it"). params.doubleEatTier still sets
  // where they start, for the Lab. Without a tier (executions), the one
  // meal.
  const FOOD_CHAIN = { mammoth: ['lion'], lion: ['wolf'], wolf: ['rat'], rat: ['mammoth'] };
  const SECOND_MEAL = { mammoth: ['wolf'], lion: ['rat'] };
  // Cage Fight, a start-of-run card: an inmate can consume the beasts it
  // counters (both meals) at its own rarity or lower, and consuming never
  // re-rolls its beast.
  const cageFight = (state) => !!state && state.startEvent === 'cagefight';
  const eatsOf = (state, beast, tier) => {
    const first = FOOD_CHAIN[beast] || [];
    const from = cageFight(state) ? 0 : state && state.params && Number.isFinite(state.params.doubleEatTier) ? state.params.doubleEatTier : DEFAULT_PARAMS.doubleEatTier;
    return Number.isFinite(tier) && tier >= from && SECOND_MEAL[beast] ? first.concat(SECOND_MEAL[beast]) : first;
  };

  // Relative worth of one inmate per tier; the advisor ranks moves with it.
  const WORTH = [1, 3, 9, 27, 81, 400];

  const DEFAULT_PARAMS = {
    drillDays: 20,
    destinations: 3,
    patrolRange: 6,
    eventTwoDoors: false,
    fewerDoorsChance: 0,
    swapsPerDay: 1,
    reusableCells: true,
    // The game's Cancel stops a consume chain after any bite (user,
    // 2026-10-16), so every bite waits for the player's pick, even of a
    // single meal. Off: the chain must go on, and a single meal is taken at
    // once.
    chainStop: true,
    // Live odds from players' boards (tools/live-data.js, 2026-10-16): who's
    // behind a door (1,011 doors without the Sorting Hook or the Dog Tag).
    // Who a Replace brings in, from 30,000 runs' boards (2026-10-22): these
    // rarities, and never the beast it replaced (0.3% of Replaces).
    tierWeights: [40, 38, 12, 8, 2],
    swapWeights: [42, 34, 11.5, 9.5, 2.5],
    swapNewBeast: true,
    beastWeights: [25, 25, 25, 25],
    // Runs start with inmates already out on random locked cells (10,950
    // first boards, 2026-10-22: 4 in 95% of runs, 3 in most of the rest),
    // any beast, with these rarities.
    startInmates: 4,
    startInmatesFewer: 5,
    startWeights: [44.5, 35, 10.5, 8, 2],
    // The warden's office among the morning's doors, when it's in reach, as
    // a % of another cell's odds: 37 gives about 24% of such mornings with
    // 3 doors (players' boards: 21-27%).
    officeDoorOdds: 37,
    // Second meals (Mammoths eat Wolves, Lions eat Rats) from this rarity
    // up: every rarity, as players' games show (it was 3, Legendary).
    doubleEatTier: 0,
    // Special events turn up on random locked doors, seen at once (players'
    // boards, 2026-10-17): one at the start of 72% of runs. After that a new
    // one follows each event the warden sets off, on a random cell (30,000
    // runs' boards, 2026-10-22: one new mark after about 88% of them, never
    // two); other moves almost never bring one (0.2-0.5%, left at 0).
    eventStartChance: 72,
    eventFollowChance: 88,
    eventMorningChance: 0,
    eventWalkChance: 0,
    eventActionChance: 0,
    executionSameTier: false,
    executionRerolls: false,
    ivoryCount: 4,
    ivoryIncludesSwapped: true,
    preyRounds: 3,
    scratchStacksBase: true,
    nestDays: 2,
    nestTier: 2,
    rewards: true,
    startTools: 1,
    // An instrument named for a beast in an offer, as a % of another's odds.
    beastToolOdds: 12,
  };

  // Field definitions for the Lab form; normalizeParams clamps to these.
  const PARAM_FIELDS = [
    { key: 'drillDays', group: '節奏', label: '練習天數', type: 'int', min: 5, max: 60 },
    { key: 'destinations', group: '節奏', label: '每天早上最多提供的巡視門數', type: 'int', min: 1, max: 15 },
    { key: 'patrolRange', group: '節奏', label: '目的地來自典獄長順時針前方的幾間牢房', type: 'int', min: 1, max: 15 },
    { key: 'fewerDoorsChance', group: '節奏', label: '早上少一扇門的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'swapsPerDay', group: '節奏', label: '每天替換次數', type: 'int', min: 0, max: 16 },
    { key: 'reusableCells', group: '節奏', label: '清空的牢房會再次上鎖，可以重新開啟', type: 'bool' },
    { key: 'chainStop', group: '節奏', label: '吞噬連鎖可在任何一口之後停止（遊戲中的「取消」）；關閉則必須繼續', type: 'bool' },
    { key: 'startInmates', group: '節奏', label: '開局時已在外的囚犯數（正式遊戲：4）', type: 'int', min: 0, max: 14 },
    { key: 'startInmatesFewer', group: '節奏', label: '開局時少一隻囚犯的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'officeDoorOdds', group: '節奏', label: '審訊室在範圍內時出現在早上目的地中的機率，相對於一般牢房的 %（正式遊戲：約 37）', type: 'int', min: 0, max: 100 },
    { key: 'tierWeights', group: '機率', label: '門後囚犯的稀有度權重', type: 'list', names: TIERS.slice(0, 5) },
    { key: 'swapWeights', group: '機率', label: '替換帶來的囚犯稀有度權重', type: 'list', names: TIERS.slice(0, 5) },
    { key: 'swapNewBeast', group: '機率', label: '替換一定換來另一種野獸（鐵杵仍會保留原野獸）', type: 'bool' },
    { key: 'startWeights', group: '機率', label: '開局時在外囚犯的稀有度權重', type: 'list', names: TIERS.slice(0, 5) },
    { key: 'beastWeights', group: '機率', label: '新囚犯的野獸權重', type: 'list', names: ['巨象', '狂獅', '頭狼', '碩鼠'] },
    { key: 'doubleEatTier', group: '機率', label: '從此稀有度起，巨象也吃頭狼、狂獅也吃碩鼠（0 普通、1 魔法、2 稀有、3 傳奇、4 至臻；5：永不）', type: 'int', min: 0, max: 5 },
    { key: 'eventStartChance', group: '獄中事變', label: '開局時隨機一扇上鎖牢門後有獄中事變的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'eventFollowChance', group: '獄中事變', label: '典獄長觸發的獄中事變（不論接受或略過）之後，在隨機牢房接著出現新事變的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'eventMorningChance', group: '獄中事變', label: '每天早上隨機一扇上鎖牢門後出現獄中事變的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'eventWalkChance', group: '獄中事變', label: '巡視行走後出現一個獄中事變的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'eventActionChance', group: '獄中事變', label: '吞噬、替換、尋獵或獄中事變之後出現一個獄中事變的機率（%）', type: 'int', min: 0, max: 100 },
    { key: 'eventTwoDoors', group: '獄中事變', label: '門後有事變的早上只提供 2 扇門', type: 'bool' },
    { key: 'executionSameTier', group: '獄中事變', label: '處刑效率會吃掉同稀有度的獵物（關閉：只吃較低稀有度）', type: 'bool' },
    { key: 'executionRerolls', group: '獄中事變', label: '處刑效率會重骰處刑者的野獸', type: 'bool' },
    { key: 'ivoryCount', group: '標記', label: '在象牙牢房替換時升階的囚犯數', type: 'int', min: 1, max: 15 },
    { key: 'ivoryIncludesSwapped', group: '標記', label: '象牙也可以讓新囚犯升階', type: 'bool' },
    { key: 'preyRounds', group: '標記', label: '獵物標記持續的早上數', type: 'int', min: 1, max: 10 },
    { key: 'scratchStacksBase', group: '標記', label: '劃痕加成（+2）疊加在基本的 +1 上', type: 'bool' },
    { key: 'nestDays', group: '標記', label: '鼠巢孵化前的天數', type: 'int', min: 1, max: 10 },
    { key: 'nestTier', group: '標記', label: '孵出的碩鼠的稀有度', type: 'tier' },
    { key: 'rewards', group: '獎勵', label: '達成本局目標可獲得一件刑具；每隻綺彩開啟一次典獄長的珍藏', type: 'bool' },
    { key: 'startTools', group: '獎勵', label: '起始刑具選擇次數，每次從 3 件隨機刑具中挑一件（正式遊戲為 1）', type: 'int', min: 0, max: 5 },
    { key: 'beastToolOdds', group: '獎勵', label: '野獸系刑具（狂獅、巨象、頭狼、碩鼠）出現在選項中的機率，為其他刑具的 %（正式遊戲：約 12）', type: 'int', min: 0, max: 100 },
  ];

  // Names exactly as the game prints them: the analyzer reads an instrument
  // pick by its printed name.
  const TOOLS = {
    revenge: { name: '復仇者之匣', en: "Avenger's Casket", text: '吞噬後，30% 機率開啟一間未開啟的牢房，裡面是吞噬者升階後同稀有度的獵物。該牢門不觸發其他效果。' },
    muzzle: { name: '狂獸的劇痛口枷', en: "Raging Beast's Agonizing Muzzle", text: '吞噬前監區上的囚犯（含獵物）不超過 4 隻時，該次吞噬額外 +2 階。' },
    saw: { name: '鏽鋸', en: 'Rusty Saw', text: '吞噬後，25% 機率額外 +1 階。' },
    keys: { name: '遺落的鑰匙串', en: 'Lost Ring of Keys', text: '巡視開啟牢門時，80% 機率同時開啟左右兩側的牢房。這些牢門不觸發其他效果。' },
    rope: { name: '絞首繩', en: "Hangman's Noose", text: '替換進來的囚犯不會是普通或魔法。' },
    // Once translated as the Burning Stake, with other rules; the live card reads as below.
    fire: { name: '灼痛的烙鐵', en: 'Searing Branding Iron', text: '巡視開啟牢門時，35% 機率把門後的囚犯複製到 1 間隨機未開啟的牢房，該牢房隨即開啟並放入複製品。該牢門不觸發其他效果。' },
    ironbox: { name: '蠕動鐵盒：碩鼠', en: 'Squirming Iron Box: Colossal Rat', text: '每天早上有一間未開啟的牢房變成鼠巢，兩天後孵出一隻稀有碩鼠。' },
    skewer: { name: '鼠頭串：碩鼠', en: 'Skewered Rat Heads: Colossal Rat', text: '碩鼠可以吞噬同稀有度的碩鼠，且碩鼠的吞噬額外 +1 階。' },
    hook: { name: '挑揀鉤', en: 'Sorting Hook', text: '開啟的牢房不會出現普通囚犯。' },
    pestle: { name: '鐵杵', en: 'Iron Pestle', text: '替換進來的囚犯保留被替換者的野獸，只重骰稀有度。' },
    scales: { name: '典獄官的天平', en: "Warden's Scales", text: '替換後，80% 機率偵查上鎖牢門後稀有度最高的囚犯：該牢門會顯示牠的野獸與稀有度。' },
    tongs: { name: '惡欲鐵鉗：巨象', en: 'Iron Tongs of Lust: Mammoth', text: '每天早上，監區上隨機一隻巨象獲得象牙標記。' },
    guillotine: { name: '狼牙鍘刀：頭狼', en: 'Fanged Guillotine: Alpha Wolf', text: '頭狼也能吞噬稀有度低於自己的可吃野獸。' },
    axe: { name: '獄卒的行刑巨斧', en: "Gaoler's Execution Axe", text: '替換帶來的稀有度高於被替換者時，隨機開啟 2 間未開啟的牢房。這些牢門不觸發其他效果。' },
    shackles: { name: '長鏈腳鐐', en: 'Long-Chained Shackles', text: '巡視行走 4 格以上時，40% 機率讓監區上隨機 1 隻囚犯升一階。' },
    // The card reads "When an Inmate Chain Consumes": the bites after the
    // first, which the eater takes by itself.
    collar: { name: '瘋獸的倒刺項圈', en: "Maddened Beast's Barbed Collar", text: '吞噬連鎖中第一口之後的每一口：80% 機率額外 +1 階。' },
    forged: { name: '偽造鑰匙', en: 'Forged Key', text: '每天早上少 1 個目的地。巡視開啟牢門時，50% 機率再隨機開啟 1 間未開啟的牢房。該牢門不觸發其他效果。' },
    // The card: "There is a 25% chance to trigger after opening: +1 Rarity
    // Tier to the current Inmate", read as the inmate in the cell the warden
    // just opened (a player's report, 2026-10-16).
    dogtag: { name: '重刑銘牌', en: "Felon's Dog Tag", text: '巡視開啟牢門時，25% 機率讓門後的囚犯升一階。' },
    // The card: "There is a 40% chance to trigger after the Inmate is
    // Consumed: the cell occupied by this Inmate is immediately opened (does
    // not trigger other effects)" (a player's report, 2026-10-16).
    cage: { name: '擁擠獸籠', en: 'Crowded Beastcage', text: '囚犯被吞噬後，40% 機率牠的牢房立刻再次開啟，放入新的囚犯。該牢門不觸發其他效果。' },
    // From the user's "Select a Torture Instrument" screenshot (2026-10-16):
    // "When there are no more than 5 unopened cells, after opening: +1 Rarity
    // Tier to 2 random Inmates", and "There is a 50% chance to trigger when
    // moving no more than 3 tiles in a single movement: randomly opens 1 cell".
    blacklist: { name: '執刑官的黑名冊', en: "Executioner's Blacklist", text: '巡視開啟牢門且仍上鎖的牢房不超過 5 間時，隨機 2 隻囚犯升一階。' },
    shortchain: { name: '短鏈腳鐐', en: 'Short-Chained Shackles', text: '巡視行走 3 格以內時，50% 機率隨機開啟 1 間上鎖的牢房。該牢門不觸發其他效果。' },
    // A player's report (#9, 2026-10-16), the card as typed: "Condition: The
    // quantities of this Inmate's Higher-Tier Inmates and Lower-Tier Inmates
    // are equal. Effect: +3 additional Rarity Tiers to the inmate this
    // Replacement" (spelled "Servered"). Read as the inmate a swap (the
    // game's Replace) brings in, counted against the rest of the block.
    maiden: { name: '切開的人形棺', en: 'Severed Iron Maiden', text: '替換一隻囚犯時，若監區上稀有度比牠高與比牠低的囚犯一樣多，新囚犯進場時 +3 階。' },
    // From a player's report (#11, 2026-10-16), the instrument pick: "-1 daily
    // destination option; there is a 35% chance to trigger after Consuming",
    // and "+1 additional Rarity Tier" (the rest of the card was cut off),
    // read like the Rusty Saw: the eater, on each bite.
    whip: { name: '棘刺鐵鞭', en: 'Barbed Whip', text: '每天早上少 1 個目的地。每一口吞噬有 35% 機率額外 +1 階。' },
    // From the user's screenshot of its card (2026-10-16): "At the start of
    // each day: Removes Inmates on both sides of the Inmate with the highest
    // rarity; for each Inmate removed, there is a 40% chance to grant that
    // Inmate +1 Rarity Tier". Read as the cells either side on the ring, the
    // removed inmates leaving their cells as a meal does.
    ravenous: { name: '兇獸的飢餓絞鏈', en: "Ferocious Beast's Ravenous Chains", text: '每天早上，稀有度最高的囚犯會移除左右兩側的囚犯，每移除一隻有 40% 機率 +1 階。' },
    // A player's report (#12, 2026-10-16), the card: "There are at least 2
    // other Inmates on the field when replacing: Randomly removes 2 other
    // Inmates to guarantee that the Inmate's rarity is increased after
    // replacing".
    scapegoat: { name: '替罪人的斷頭台', en: "Scapegoat's Guillotine", text: '替換時若監區上有 2 隻以上其他囚犯，隨機移除其中 2 隻，新囚犯的稀有度必定高於被替換者。' },
    // The user's screenshots of its card (2026-10-16): "-1 daily destination
    // option; when an Inmate with rarity lower than Legendary is Replaced,
    // there is a 40% chance to trigger. Effect: Changes Inmate rarity to
    // Legendary". A separate instrument from the Searing Branding Iron (id
    // `fire`, once taken for its mistranslation).
    stake: { name: '火刑柱', en: 'Burning Stake', text: '每天早上少 1 個目的地。替換傳奇以下的囚犯時，40% 機率換來傳奇囚犯。' },
    // A player's report (#17, 2026-10-16): "At the start of each day, if there
    // are matching Inmates on the field, there is a 60% chance to trigger:
    // Randomly removes 1 matching Inmate, then randomly selects 1 from the
    // remaining matching Inmates to grant them +2 Rarity Tiers". Matching is
    // the same beast and rarity (the user, from the game's own link).
    coin: { name: '手足的命運硬幣', en: "Kin's Coin of Fate", text: '每天早上，若有兩隻以上野獸與稀有度都相同的囚犯，60% 機率移除其中一隻，並讓另一隻同類 +2 階。' },
    // A player's report (#20, 2026-10-16), the card: "Iron Crown of the
    // Prison King: Berserk Lion. Condition: When Berserk Lion Consumes.
    // Effect: Berserk Lion can Consume any Inmate of the same rarity. +2
    // additional Rarity Tiers after consuming". Read like the Skewered Rat
    // Heads, whose card names the Colossal Rat: every Lion, on each bite.
    crown: { name: '牢中王的鐵冠：狂獅', en: 'Iron Crown of the Prison King: Berserk Lion', text: '狂獅可以吞噬任何同稀有度的囚犯，且狂獅的吞噬額外 +2 階。' },
    // A player's report (#57, 2026-10-16), the card: "Elephant-Foot Maul:
    // Mammoth. Effect: Mammoth can Consume higher-rarity countered Inmates;
    // after Consuming, its rarity increases to +2 tiers above the consumed
    // target's rarity". Read like the Iron Crown: every Mammoth, on each
    // bite, same-rarity meals included (+2 for those).
    maul: { name: '象腳重錘：巨象', en: 'Elephant-Foot Maul: Mammoth', text: '巨象也能吞噬稀有度較高的克制目標，且巨象吞噬後會升到比獵物高 2 階。' },
    // A player's report (#65, 2026-10-17), the card: "Filthy Claws: Alpha
    // Wolf. Condition: At the start of each day. Effect: Randomly adds a
    // Scratch Marks mark to 1 unopened cell". A scratched door shows the
    // rarity inside, and a Wolf of that rarity can consume through it.
    claws: { name: '髒污鐵爪：頭狼', en: 'Filthy Claws: Alpha Wolf', text: '每天開始時，隨機 1 間未開啟的牢房出現劃痕：會顯示裡面的稀有度，同稀有度的頭狼可以隔著牢門吞噬該囚犯，+3。' },
    // A player's report (#100, 2026-10-17), the card: "Blood-Stained Trap:
    // Berserk Lion. Condition: Stops at Berserk Lion's cell. Effect: Adds
    // Hunt to decision options, which can add a Prey mark to Consumable
    // targets". Read as: with the warden on a Lion, Hunt is a choice beside
    // Consume and Replace (a day has one of them), and the Lion marks one
    // inmate it can consume as its prey (the Prey marker's rule).
    trap: { name: '染紅的捕獸夾：狂獅', en: 'Blood-Stained Trap: Berserk Lion', text: '典獄長停在狂獅的牢房時，當天選項多出「尋獵」：狂獅對一隻牠能吞噬的囚犯加上獵物標記，之後 3 個早上兩者每天各升一階。一天只能吞噬、替換或尋獵擇一。' },
  };
  const TOOL_IDS = Object.keys(TOOLS);

  // The instruments named for a beast (": Berserk Lion", ": Mammoth", ": Alpha
  // Wolf", ": Colossal Rat") are rare in the game's offers. In 8,891 offers
  // that players' analyzers read (2026-10-17 to 19), they were 3.9% of the
  // cards against 25.8% at equal odds: each about 0.12 as likely as any
  // other (params.beastToolOdds, in %). The user's own offers agreed.
  const BEAST_TOOLS = ['trap', 'crown', 'maul', 'tongs', 'claws', 'guillotine', 'skewer', 'ironbox'];
  const toolWeight = (state, id) => {
    if (!BEAST_TOOLS.includes(id)) return 1;
    const odds = state && state.params && Number.isFinite(state.params.beastToolOdds) ? state.params.beastToolOdds : DEFAULT_PARAMS.beastToolOdds;
    return Math.max(0, odds) / 100;
  };
  // An offer's cards: k different instruments from the pool, each by its odds.
  function drawTools(stream, state, pool, k) {
    const left = pool.slice();
    const out = [];
    while (out.length < k && left.length) out.push(left.splice(pickIndex(stream, left.map((id) => toolWeight(state, id))), 1)[0]);
    return out;
  }

  // Special events behind sealed doors, each equally likely.
  const EVENTS = {
    chain: { name: '連鎖反應', en: 'Chain reaction' },
    execution: { name: '處刑效率', en: 'Execution' },
    trickster: { name: '暗箱操作', en: 'Behind Closed Doors' },
    appetite: { name: '飢腸轆轆', en: 'Ravenous Appetite' },
    convict: { name: '高危罪犯', en: 'High-Risk Convict' },
    crow: { name: '鴉之低語', en: 'Crow Whispers' },
    freedom: { name: '自由的滋味', en: 'Taste of Freedom' },
    usurp1: { name: '僭越 I', en: 'Usurpation I' },
    usurp2: { name: '僭越 II', en: 'Usurpation II' },
    usurp3: { name: '僭越 III', en: 'Usurpation III' },
    usurp4: { name: '僭越 IV', en: 'Usurpation IV' },
    // A player's report (#13) and the user's screenshot (2026-10-16): "Select
    // any 1 cell (excluding the Interrogation Room), move to that cell, and
    // trigger subsequent content". The game then asks "Select an Objective"
    // with every cell but the office (the Interrogation Room) on offer.
    ratway: { name: '暗渠鼠道', en: 'Sewer Ratway' },
    // A player's report (#41, 2026-10-16), a card with only Confirm:
    // "Reveals all unopened cells with rarity below Rare". A revealed door
    // shows its rarity (a "?" portrait), as with Crow Whispers, so the
    // locked doors left dark hold Rare or better.
    hunt: { name: '尋「寶」', en: '"Treasure" Hunt' },
    // A player's report (#313, 2026-10-17): "randomly select up to 3 inmates
    // and increase their rarity by 1 tier".
    portion: { name: '有福同享', en: 'Extra Portion' },
  };
  // The pool new events are drawn from (the game's "Prison Incidents"). It
  // changes during a run: Usurpation I trades itself for Usurpation II.
  const EVENT_POOL = ['chain', 'execution', 'trickster', 'appetite', 'convict', 'crow', 'freedom', 'usurp1', 'ratway', 'hunt', 'portion'];
  // The Usurpation chain (the user's cards, 2026-10-16): how many inmates
  // rise and by how much, and which Usurpation then takes its place in the
  // Prison Incidents ("Add [Usurpation IV] to Prison Incidents and remove
  // [Usurpation III]"). II's card is unseen: 2 inmates a tier, read from
  // the others. IV ("Increase all Inmates' rarity by 2 tiers") is the last.
  const USURP = {
    usurp1: { count: 1, by: 1, next: 'usurp2' },
    usurp2: { count: 2, by: 1, next: 'usurp3' },
    usurp3: { count: 2, by: 2, next: 'usurp4' },
    usurp4: { count: 'all', by: 2, next: null },
  };
  // Taste of Freedom opens this many random locked cells.
  const FREEDOM_CELLS = 3;
  // Extra Portion raises up to this many random inmates a tier.
  const PORTION_INMATES = 3;
  // Crow Whispers shows the rarity behind this many locked cells.
  const CROW_CELLS = 4;
  // "Treasure" Hunt shows the rarity behind every locked cell below this
  // tier (Rare).
  const HUNT_BELOW = 2;
  // The warden's office: Instigate brings this many new special events, each
  // on a random cell: a locked door, or an inmate's open cell (the "!" that
  // a walk in sets off). The user: "instigate doesn't guarantee 2 events";
  // their records showed 1 every time (10 of 10), 5 on open cells. Each of
  // those boards had an event already; with none, it makes 2 (the user's
  // reading, being tested).
  const INSTIGATE_EVENTS = 1;
  const INSTIGATE_EVENTS_EMPTY = 2;
  // Ravenous Appetite: tries at +1 tier, and the chance of each.
  const APPETITE_TRIES = 5;
  const APPETITE_ODDS = 0.5;
  const EVENT_IDS = Object.keys(EVENTS);
  const eventName = (id) => (EVENTS[id] ? EVENTS[id].name : '獄中事變');

  // Each run has one objective, drawn at the start; meeting it earns a tool
  // when rewards are on. The live game has more objectives, and what each
  // one pays isn't known yet, so every objective here pays a tool. `other`
  // stands for one the simulator doesn't know: it's never drawn, and it
  // pays nothing, so no tool is ever assumed for it.
  const OBJECTIVES = {
    king: { name: '困獸稱王', en: 'King of the Caged', text: '至少 1 隻囚犯的稀有度達到至臻' },
    walk: { name: '巡獄之路', en: 'Prison Walk', text: '移動 18 格', need: 18, unit: '已移動格數' },
    // Seen live 2026-10-16, each paying a tool when met (and a Warden's Cache
    // at the riot, not simulated). Not drawn in simulated runs yet: the
    // analyzer uses them when the player sets them.
    consume: { name: '弱肉強食', en: 'Survival of the Fittest', text: '吞噬 4 次', need: 4, unit: '吞噬次數', drawn: false },
    incident: { name: '暗流湧動', en: 'Undercurrents', text: '觸發獄中事變 2 次', need: 2, unit: '獄中事變次數', drawn: false },
    // Reports 30 and 51: "Objective: Behind Cell Doors. Open 10 cells".
    // Every cell that opens counts, however it opens.
    doors: { name: '牢門之後', en: 'Behind Cell Doors', text: '開啟 10 間牢房', need: 10, unit: '已開啟牢房', drawn: false },
    other: { name: '其他目標', en: 'Another objective', text: '模擬器尚未收錄，因此不假設它會給刑具', drawn: false },
  };
  const OBJECTIVE_IDS = Object.keys(OBJECTIVES).filter((id) => OBJECTIVES[id].drawn !== false);

  // Cards the game can show before a run starts, besides its objective
  // (the user's screenshots, 2026-10-16). Simulated runs don't draw them
  // yet; the analyzer uses them when the player sets them.
  const START_EVENTS = {
    // "Cage Fight. Inmates can Consume lower-rarity countered Inmates;
    // Consuming does not randomly change their Codes". Countered: the
    // beasts an inmate eats, at its rarity or lower, with both meals at any
    // rarity (a Rare Mammoth ate Wolves). Codes: beasts, as in Behind Closed
    // Doors' "Scarce Code".
    cagefight: { name: '囚徒困鬥', en: 'Cage Fight', text: '囚犯可以吞噬稀有度不高於自己的克制目標（巨象：狂獅與頭狼；狂獅：頭狼與碩鼠；頭狼：碩鼠；碩鼠：巨象），且吞噬後野獸不會改變' },
    // "Iron Law. Extends the duration of the current run to 30 days".
    ironlaw: { name: '鐵律', en: 'Iron Law', text: '本局持續 30 天', days: 30 },
    // "Tyranny. Automatically triggers Instigate and Bestow 3 additional
    // times each time you stop at the Interrogation Room" (the user's
    // screenshot, 2026-10-16): read as 3 more of each, on top of the
    // visit's own choice.
    tyranny: { name: '暴政', en: 'Tyranny', text: '每次停在審訊室，除了你自己的選擇之外，還會再自動觸發煽動與賞賜各 3 次', extra: 3 },
    // "Opulence. You can make 2 additional choices when obtaining Warden's
    // Treasure" (the user's screenshot, 2026-10-17): 3 picks in a row, and a
    // Rainbow a pick makes opens another Treasure (the user's log: 7
    // Rainbows, 21 picks).
    opulence: { name: '奢靡', en: 'Opulence', text: '每次典獄長的珍藏可以連續選 3 次（多 2 次選擇），而選擇造出的綺彩會再帶來 3 次', picks: 3 },
  };

  const GIFTS = {
    ring: { name: '三首扳指', en: 'Three-Headed Thumb Ring', text: '隨機開啟最多 3 間未開啟的牢房。不觸發其他效果。' },
    horn: { name: '鬥爭銅號', en: 'Brass Horn of Strife', text: '每隻有目標的囚犯依序隨機吞噬一個目標。' },
    wine: { name: '赤色佳釀', en: 'Crimson Vintage', text: '所有傳奇以下的囚犯升一階。' },
    brand: { name: '原罪烙印', en: 'Brand of Original Sin', text: '最多 4 隻沒有獵物的囚犯改變野獸，讓牠們有同稀有度的目標。' },
  };
  const GIFT_IDS = Object.keys(GIFTS);

  const SCENARIOS = {
    empty: { name: '空監獄', text: '第 1 天，15 間牢房全部上鎖。建議第一局從這裡開始。' },
    events: { name: '獄中事變練習', text: '今天路線上的三扇門後，分別藏著處刑效率、連鎖反應，以及暗箱操作或飢腸轆轆。' },
    ivory: { name: '象牙練習', text: '替換象牙牢房裡的囚犯，四隻囚犯各升一階。' },
    prey: { name: '獵物標記練習', text: '一隻狂獅和牠標記的獵物，連續三天每天早上各升一階。' },
    scratch: { name: '劃痕練習', text: '頭狼可以隔著有劃痕的牢門吞噬，+3。' },
    nest: { name: '鼠巢練習', text: '讓鼠巢保持上鎖兩天，就會孵出一隻稀有碩鼠。' },
  };

  const SEED_WORDS = ['ASH', 'BONE', 'IRON', 'SALT', 'EMBER', 'CHAIN', 'GATE', 'WARD', 'HOWL', 'TUSK', 'FANG', 'MANE', 'CINDER', 'SHACKLE'];

  // ---------- Small helpers ----------

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const plural = (n, word) => `${n} ${word}`;
  const tierName = (t) => TIERS[clamp(t, 0, RAINBOW)];
  const beastName = (b) => (BEAST_INFO[b] ? BEAST_INFO[b].name : '未知');
  const cellLabel = (n) => String(n + 1).padStart(2, '0');
  const describe = (inmate) => `${tierName(inmate.tier)}${beastName(inmate.beast)}`;
  const ok = (events) => ({ ok: true, events: events || [] });
  const fail = (reason) => ({ ok: false, reason });
  const has = (state, tool) => state.tools.includes(tool);
  const freshDay = () => ({ swap: 0, devour: 0 });
  // Steps clockwise from a to b, so 0 means the same cell.
  const stepsBetween = (a, b) => (b - a + CELL_COUNT) % CELL_COUNT;

  // ---------- Seeded randomness ----------

  function hashSeed(text) {
    let h = 2166136261;
    for (const ch of String(text)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // mulberry32: small, fast, and its whole state fits in one saved number.
  function rand(stream) {
    stream.rng = (stream.rng + 0x6d2b79f5) >>> 0;
    let t = stream.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function pickIndex(stream, weights) {
    const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
    if (total <= 0) return 0;
    let r = rand(stream) * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  const pickOne = (stream, list) => list[Math.floor(rand(stream) * list.length)];

  function shuffle(stream, list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand(stream) * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // A side stream for public draws (the objective, the starting instruments),
  // so showing them never shifts the dice that decide what is behind the doors.
  const sideStream = (state, label) => ({ rng: hashSeed(`${state.seed}|${label}`) });

  function randomSeed() {
    const word = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
    return `${word}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  }

  // ---------- Parameters ----------

  function normalizeParams(input) {
    const p = JSON.parse(JSON.stringify(DEFAULT_PARAMS));
    if (!input || typeof input !== 'object') return p;
    for (const field of PARAM_FIELDS) {
      const value = input[field.key];
      if (value === undefined || value === null) continue;
      if (field.type === 'int' || field.type === 'tier') {
        const n = Math.round(Number(value));
        if (Number.isFinite(n)) p[field.key] = field.type === 'tier' ? clamp(n, 0, RAINBOW - 1) : clamp(n, field.min, field.max);
      } else if (field.type === 'bool') {
        p[field.key] = !!value;
      } else if (field.type === 'list') {
        if (Array.isArray(value) && value.length === field.names.length) {
          // Halves too (a measured 1.5%).
          const list = value.map((x) => clamp(Math.round(Number(x) * 2) / 2 || 0, 0, 1000));
          if (list.some((x) => x > 0)) p[field.key] = list;
        }
      }
    }
    return p;
  }

  // ---------- State helpers ----------

  // An entry can carry `x`, a small record of what happened (who opened,
  // who ate whom), which the page draws as beast icons in the log and recap.
  const entry = (state, kind, text, x) => (x ? { d: state.day, k: kind, t: text, x } : { d: state.day, k: kind, t: text });
  const snap = (inmate) => ({ beast: inmate.beast, tier: inmate.tier });

  function log(state, kind, text, x) {
    state.log.push(entry(state, kind, text, x));
  }

  // Inserts an entry earlier in the log, so a summary line can come before the
  // side effects that were logged while it resolved.
  function logAt(state, index, kind, text, x) {
    state.log.splice(index, 0, entry(state, kind, text, x));
  }

  function trimLog(state) {
    if (state.log.length <= LOG_LIMIT) return;
    const cut = state.log.length - LOG_LIMIT;
    state.log.splice(0, cut);
    // A chain waiting for a pick logs its summary where it began.
    if (state.chaining) state.chaining.at = Math.max(0, state.chaining.at - cut);
  }

  function makeInmate(state, beast, tier) {
    return { id: state.nextId++, beast, tier: clamp(tier, 0, RAINBOW) };
  }

  // Rarity odds for whoever is behind a door. The Sorting Hook keeps out Normals.
  function doorWeights(state) {
    const w = state.params.tierWeights.slice();
    if (has(state, 'hook') && w.slice(1).some((x) => x > 0)) w[0] = 0;
    return w;
  }

  function rollInmate(state, weights) {
    const tier = pickIndex(state, weights || state.params.tierWeights);
    const beast = BEASTS[pickIndex(state, state.params.beastWeights)];
    return makeInmate(state, beast, tier);
  }

  const boardCells = (state) => state.cells.filter((c) => !c.sealed && c.inmate);
  const boardInmates = (state) => boardCells(state).map((c) => c.inmate);
  const cellOf = (state, id) => state.cells.find((c) => c.inmate && c.inmate.id === id) || null;

  function boardCellOf(state, id) {
    const cell = cellOf(state, id);
    return cell && !cell.sealed ? cell : null;
  }

  const linkOf = (state, id) => state.prey.find((l) => l.lion === id || l.prey === id) || null;

  // The door odds for one cell: at or above the rarity the player knows it
  // has (`atLeast`: a "Treasure" Hunt leaves the doors it didn't reveal
  // Rare or better).
  function cellWeights(state, cell) {
    const w = doorWeights(state);
    const floor = cell.atLeast || 0;
    const kept = w.map((x, t) => (t >= floor ? x : 0));
    return kept.some((x) => x > 0) ? kept : w;
  }

  // The occupant behind a sealed door is rolled the first time anyone looks.
  function hiddenOf(state, cell) {
    if (!cell.hidden) cell.hidden = rollInmate(state, cellWeights(state, cell));
    return cell.hidden;
  }

  // Who comes out of a door: the inmate already behind it, unless the Sorting
  // Hook rules out a Normal the player hasn't seen.
  function doorInmate(state, cell) {
    const h = cell.hidden;
    if (h && (h.tier > 0 || cell.known || !has(state, 'hook'))) return h;
    return rollInmate(state, cellWeights(state, cell));
  }

  function canEat(state, eater, meal) {
    if (!eater || !meal || eater.id === meal.id || eater.tier >= RAINBOW) return false;
    // The beasts this eater counters: its meals in the food chain.
    const counters = eatsOf(state, eater.beast, eater.tier).includes(meal.beast) || (eater.beast === 'rat' && meal.beast === 'rat' && has(state, 'skewer'));
    if (eater.tier !== meal.tier) {
      if (meal.tier < eater.tier && counters && cageFight(state)) return true;
      if (meal.tier > eater.tier && counters && eater.beast === 'mammoth' && has(state, 'maul')) return true;
      return eater.tier > meal.tier && eater.beast === 'wolf' && has(state, 'guillotine') && eatsOf(state, 'wolf').includes(meal.beast);
    }
    return counters || (eater.beast === 'lion' && has(state, 'crown'));
  }

  // One devour a day, started by the inmate in the warden's cell; it then
  // chains on by itself (see devour). A day has a devour or a swap, not
  // both: either one uses up the other (confirmed in the live game). But
  // the live game can still offer a consume after a swap (seen 2026-10-16,
  // on a day with a special event). The analyzer sets
  // used.devourAfterSwap only when the game shows that offer; it lasts the
  // day.
  // used.noDevour / used.noSwap: the game shows no Consume / Replace card
  // today (the analyzer reads them), so that one isn't on offer, while the
  // other still is. used.noHunt: no Hunt card either. used.huntOnly: the
  // Hunt's pick is open, on these cells.
  // A Hunt (the Blood-Stained Trap) uses the day's action too.
  const canDevourNow = (state) => state.used.devour < 1 && !state.used.hunt && !state.used.noDevour && (state.used.swap < 1 || !!state.used.devourAfterSwap);
  const canSwapNow = (state) => state.used.devour < 1 && !state.used.hunt && !state.used.noSwap && state.used.swap < state.params.swapsPerDay;

  // Blood-Stained Trap: with the warden on a Lion that has no prey mark, a
  // Hunt can mark any inmate the Lion can consume that has none either.
  // The analyzer's boards can say more: inmate.marked, an inmate wearing a
  // Prey mark whose Lion isn't known (its crosshair, read from a picture),
  // and used.huntOnly, the cells the game framed on the Hunt's pick.
  function huntTargets(state) {
    const here = state.cells[state.position];
    if (!has(state, 'trap') || !here || here.sealed || !here.inmate || here.inmate.beast !== 'lion') return [];
    const framed = state.used && Array.isArray(state.used.huntOnly) ? state.used.huntOnly : null;
    if (framed) return framed.filter((n) => n !== here.n && state.cells[n] && !state.cells[n].sealed && state.cells[n].inmate);
    if (linkOf(state, here.inmate.id)) return [];
    return boardCells(state).filter((c) => c.n !== here.n && canEat(state, here.inmate, c.inmate) && !linkOf(state, c.inmate.id) && !c.inmate.marked).map((c) => c.n);
  }
  const canHuntNow = (state) => state.phase === 'manage' && !state.chaining && state.used.devour < 1 && state.used.swap < 1 && !state.used.hunt && !state.used.noHunt && huntTargets(state).length > 0;

  // used.mealOnly: the meals the game framed on the meal pick now open
  // (the analyzer reads them, report 385). A bite clears it: the next pick
  // frames its own.
  const framedMeals = (state, options) => (state.used && Array.isArray(state.used.mealOnly) ? options.filter((o) => state.used.mealOnly.includes(o.cell)) : options);

  function startOptions(state) {
    const cell = state.cells[state.position];
    if (!canDevourNow(state) || state.phase !== 'manage' || !cell || cell.sealed || !cell.inmate) return [];
    return framedMeals(state, devourOptions(state, cell.n));
  }

  function limits(state) {
    return { swap: state.params.swapsPerDay };
  }

  // Ends every prey mark that is no longer valid and logs why.
  function checkPrey(state) {
    state.prey = state.prey.filter((link) => {
      const lion = boardCellOf(state, link.lion);
      const prey = boardCellOf(state, link.prey);
      const valid = lion && prey && lion.inmate.beast === 'lion' && prey.inmate.beast === link.preyBeast;
      if (!valid) log(state, 'prey', '一個獵物標記結束了：其中一方離開了監區或改變了野獸。');
      return valid;
    });
  }

  // A random special event kind, from the run's current pool.
  const rollEvent = (state) => {
    const pool = state.eventPool || EVENT_POOL;
    return pool[Math.floor(rand(state) * pool.length)];
  };

  // Empties a cell. With reusable cells it seals again and will hold someone
  // new the next time it opens, unseen again. A special event may turn up on
  // it later, as on any locked door (spawnEvent).
  function emptyCell(state, cell) {
    const inmate = cell.inmate;
    cell.inmate = null;
    cell.hidden = null;
    cell.known = 0;
    cell.atLeast = 0;
    cell.scratch = false;
    cell.nest = null;
    cell.ivory = false;
    cell.sealed = !!state.params.reusableCells;
    cell.seen = false;
    cell.event = null;
    return inmate;
  }

  // A special event turns up behind a random locked door that has none (and
  // isn't a rat nest), with `chance` %, and shows at once. Players' boards
  // (147,602 screenshot boards, 2026-10-17) have events appearing anywhere,
  // at any point of a day, not only behind doors the warden walks past (the
  // user: "events can spawn anywhere on the board at random on any turn").
  function spawnEvent(state, chance) {
    if (!(chance > 0) || rand(state) * 100 >= chance) return null;
    const free = state.cells.filter((c) => c.n !== OFFICE && c.sealed && !c.event && !c.nest);
    if (!free.length) return null;
    const cell = pickOne(state, free);
    cell.event = rollEvent(state);
    cell.seen = true;
    log(state, 'event', `牢房 ${cellLabel(cell.n)} 的門後出現了一個獄中事變。`, { type: 'spawn', cell: cell.n });
    return cell;
  }

  // Each special event the warden sets off, taken or skipped, is followed
  // by a new one with `chance` %, on a random cell that could hold one (a
  // locked door, or an inmate's open cell, as an Instigate places them) but
  // the warden's own. Players' boards (2026-10-22): one new mark, never two,
  // at any distance from the warden.
  function followEvent(state, chance) {
    if (!(chance > 0) || rand(state) * 100 >= chance) return null;
    const free = instigateCells(state).filter((c) => c.n !== state.position);
    if (!free.length) return null;
    const cell = pickOne(state, free);
    cell.event = rollEvent(state);
    cell.seen = true;
    log(state, 'event', `牢房 ${cellLabel(cell.n)} ${cell.sealed ? '門後' : '裡'}出現了一個獄中事變。`, { type: 'spawn', cell: cell.n });
    return cell;
  }

  // The run's objective is met: with rewards on, it earns a tool (pick one
  // of three). `state.milestone` records that it's done.
  function meetObjective(state, why) {
    state.milestone = true;
    const name = OBJECTIVES[state.objective.id].name;
    const options = state.params.rewards ? drawTools(state, state, TOOL_IDS.filter((t) => !has(state, t)), 3) : [];
    if (options.length) state.pending.push({ kind: 'tool', options });
    log(state, 'tool', `達成目標「${name}」：${why}。${options.length ? '請選一件刑具。' : ''}`, { type: 'objective', id: state.objective.id });
  }

  // Counts toward an objective met by doing something a number of times
  // (Survival of the Fittest: each bite; Undercurrents: each Prison
  // Incident), and meets it at its count.
  function countObjective(state, id, what) {
    const o = state.objective;
    if (!o || o.id !== id || state.milestone) return;
    const need = OBJECTIVES[id].need;
    o.progress = Math.min(need, o.progress + 1);
    if (o.progress >= need) meetObjective(state, `${need} ${what}`);
  }

  // Applies rewards for growth: King of the Caged, and the vault for anyone
  // who reaches Rainbow.
  function afterGrowth(state, inmate, events) {
    if (inmate.tier >= RAINBOW && state.vault.length >= VAULT_SLOTS) inmate.tier = SUPREME;
    state.stats.best = Math.max(state.stats.best, inmate.tier);
    if (state.objective.id === 'king' && !state.milestone && inmate.tier >= SUPREME) meetObjective(state, `一隻${describe(inmate)}`);
    if (inmate.tier < RAINBOW) return;
    const cell = cellOf(state, inmate.id);
    if (!cell) return;
    emptyCell(state, cell);
    state.vault.push({ id: inmate.id, beast: inmate.beast, day: state.day });
    state.cache += 1;
    log(state, 'rainbow', `綺彩${beastName(inmate.beast)}！牠離開牢房 ${cellLabel(cell.n)} 進入收容區。可領取的典獄長的珍藏：${state.cache}。`, { type: 'rainbow', cell: cell.n, who: snap(inmate) });
    events.push({ type: 'rainbow', cell: cell.n });
    // Each Treasure is one pick, or more with a start card (Opulence: 3).
    const picks = (START_EVENTS[state.startEvent] && START_EVENTS[state.startEvent].picks) || 1;
    if (state.params.rewards) for (let k = 0; k < picks; k++) state.pending.push({ kind: 'gift', options: GIFT_IDS.slice() });
  }

  function reroll(state, inmate) {
    const before = inmate.beast;
    inmate.beast = BEASTS[pickIndex(state, state.params.beastWeights)];
    return inmate.beast !== before;
  }

  function promote(state, inmate, by, rerollBeast, events) {
    const from = inmate.tier;
    inmate.tier = clamp(inmate.tier + by, 0, RAINBOW);
    const cell = cellOf(state, inmate.id);
    events.push({ type: 'promote', cell: cell ? cell.n : null, from, to: inmate.tier });
    if (rerollBeast && inmate.tier < RAINBOW) reroll(state, inmate);
    afterGrowth(state, inmate, events);
  }

  // Opens a sealed cell. A patrol opening returns the special event behind
  // the door; any other opening uses up the event without triggering it.
  function openCell(state, cell, how, events, forced) {
    if (!cell.sealed) return null;
    const event = cell.event;
    const inmate = forced ? makeInmate(state, forced.beast, forced.tier) : doorInmate(state, cell);
    const lostNest = !!cell.nest && !forced;
    cell.sealed = false;
    cell.inmate = inmate;
    cell.hidden = null;
    cell.known = 0;
    cell.atLeast = 0;
    cell.scratch = false;
    cell.nest = null;
    cell.event = null;
    state.stats.opened += 1;
    events.push({ type: 'open', cell: cell.n });
    const extra = how === 'patrol' ? '' : '（額外開門）';
    log(state, 'patrol', `開啟牢房 ${cellLabel(cell.n)}${extra}：${describe(inmate)}。${lostNest ? '裡面的鼠巢被摧毀了。' : ''}`, { type: 'open', cell: cell.n, side: how !== 'patrol', who: snap(inmate) });
    if (event && how !== 'patrol') log(state, 'event', `牢房 ${cellLabel(cell.n)} 門後的獄中事變未觸發就消耗掉了。`);
    countObjective(state, 'doors', '間牢房已開啟');
    afterGrowth(state, inmate, events);
    // Felon's Dog Tag: the inmate behind a patrolled door may rise a tier.
    if (how === 'patrol' && has(state, 'dogtag') && cell.inmate === inmate && inmate.tier < RAINBOW && rand(state) < 0.25) {
      log(state, 'tool', `重刑銘牌：牢房 ${cellLabel(cell.n)} 的${describe(inmate)}升一階。`, { type: 'dogtag', cell: cell.n });
      promote(state, inmate, 1, false, events);
    }
    // Executioner's Blacklist: once 5 or fewer cells are still locked, each
    // door the patrol opens raises 2 random inmates a tier.
    if (how === 'patrol' && has(state, 'blacklist') && state.cells.filter((c) => c.sealed).length <= 5) {
      const picks = shuffle(state, boardInmates(state).filter((i) => i.tier < RAINBOW)).slice(0, 2);
      if (picks.length) {
        log(state, 'tool', `執刑官的黑名冊：${picks.map((who) => `牢房 ${cellLabel(cellOf(state, who.id).n)} 的${describe(who)}`).join('與')}升一階。`, { type: 'blacklist', cells: picks.map((who) => cellOf(state, who.id).n) });
        for (const who of picks) if (boardCellOf(state, who.id)) promote(state, who, 1, false, events);
      }
    }
    // Searing Branding Iron: the inmate behind a patrolled door is copied
    // into another unopened cell, which opens with no other effect.
    if (how === 'patrol' && has(state, 'fire') && rand(state) < 0.35 && cell.inmate === inmate) {
      const sealed = state.cells.filter((c) => c.sealed);
      if (sealed.length) {
        const target = pickOne(state, sealed);
        log(state, 'tool', `灼痛的烙鐵：${describe(inmate)}被複製到牢房 ${cellLabel(target.n)}。`);
        openCell(state, target, 'side', events, { beast: inmate.beast, tier: inmate.tier });
      }
    }
    if (how === 'patrol' && has(state, 'keys') && rand(state) < 0.8) {
      log(state, 'tool', '遺落的鑰匙串：左右兩側的牢房也一起打開了。');
      // Next to the office there is only one door to open.
      for (const step of [-1, 1]) openCell(state, state.cells[(cell.n + step + CELL_COUNT) % CELL_COUNT], 'side', events);
    }
    if (how === 'patrol' && has(state, 'forged') && rand(state) < 0.5) {
      const sealed = state.cells.filter((c) => c.sealed);
      if (sealed.length) {
        const extra = pickOne(state, sealed);
        log(state, 'tool', `偽造鑰匙：牢房 ${cellLabel(extra.n)} 也開啟了。`);
        openCell(state, extra, 'side', events);
      }
    }
    return how === 'patrol' ? event : null;
  }

  function guard(state, need) {
    if (state.phase === 'ended') return fail('這一局已經結束。開始新的一局繼續玩吧。');
    if (state.pending.length) return fail('請先完成待選的選擇。');
    if (state.chaining) return fail(canStopChain(state) ? '請先完成吞噬連鎖：選下一個獵物，或停止連鎖。' : '吞噬連鎖必須繼續：請先選下一個獵物。');
    if (state.phase === 'office') return fail('請先選擇煽動或賞賜。');
    if (state.phase === 'event') return fail('請先決定是否接受獄中事變。');
    if (need === 'manage' && state.phase === 'patrol') return fail('請先巡視：走到今天的其中一個目的地。');
    if (need === 'patrol' && state.phase !== 'patrol') return fail('今天已經巡視過了。');
    return null;
  }

  // ---------- Setup ----------

  // The office is never sealed and never holds anyone. `seen`: whether a
  // cell's event shows. Events are seen as they appear (spawnEvent); saves
  // and boards from before that rule may still hold unseen ones.
  function blankCell(n) {
    return { n, sealed: n !== OFFICE, inmate: null, hidden: null, known: 0, atLeast: 0, scratch: false, nest: null, event: null, ivory: false, seen: false };
  }

  function newGame(options) {
    const opts = options || {};
    // Every run is a drill (the contract challenge, which isn't in the live
    // game, was removed on the user's word, 2026-10-17).
    const mode = 'drill';
    const scenario = SCENARIOS[opts.scenario] ? opts.scenario : 'empty';
    const params = normalizeParams(opts.params);
    const seed = String(opts.seed || '').trim().toUpperCase().slice(0, 40) || randomSeed();
    const state = {
      v: VERSION,
      mode,
      scenario,
      seed,
      // The key keeps its empty last field (the challenge's loadout), so
      // every seed plays as it did.
      rng: hashSeed(`${seed}|${mode}|${scenario}|`),
      params,
      day: 1,
      maxDays: opts.startEvent === 'ironlaw' ? START_EVENTS.ironlaw.days : params.drillDays,
      // A card shown before the run (START_EVENTS), or none.
      startEvent: START_EVENTS[opts.startEvent] ? opts.startEvent : null,
      phase: 'patrol',
      position: OFFICE,
      destinations: [],
      chain: false,
      event: null,
      cells: Array.from({ length: CELL_COUNT }, (_, n) => blankCell(n)),
      vault: [],
      cache: 0,
      tools: [],
      pending: [],
      // A random objective: reaching Supreme earns a tool only when it's
      // King of the Caged.
      objective: { id: pickOne(sideStream({ seed }, 'objective'), OBJECTIVE_IDS), progress: 0 },
      milestone: false,
      used: freshDay(),
      // A devour chain waiting for the player to pick its next meal.
      chaining: null,
      eventPool: EVENT_POOL.slice(),
      prey: [],
      nextId: 1,
      log: [],
      stats: { patrols: 0, opened: 0, devours: 0, chains: 0, swaps: 0, executions: 0, best: 0 },
      result: null,
    };
    // Most runs start with one special event showing (72% of players' first
    // boards: one, 1.4% two, the rest none).
    spawnEvent(state, params.eventStartChance);
    log(state, 'day', `第 1 天，共 ${state.maxDays} 天。`);
    const goal = OBJECTIVES[state.objective.id];
    log(state, 'tool', `目標：${goal.name}。${goal.text}。`);
    setupDrill(state);
    return state;
  }

  function place(state, n, beast, tier) {
    if (n === OFFICE) throw new Error('The office never holds an inmate.');
    const cell = state.cells[n];
    Object.assign(cell, blankCell(n), { sealed: false, inmate: makeInmate(state, beast, tier) });
    state.stats.best = Math.max(state.stats.best, tier);
    return cell.inmate;
  }

  function hide(state, n, beast, tier, extra) {
    if (n === OFFICE) throw new Error('The office never holds an inmate.');
    const cell = state.cells[n];
    Object.assign(cell, blankCell(n), { hidden: makeInmate(state, beast, tier) }, extra || {});
    return cell;
  }

  function setupDrill(state) {
    const s = state.scenario;
    let note = '15 間牢房全部上鎖，典獄長從牢房 01 的審訊室出發。從今天的目的地中選一個，去見你的第一隻囚犯。';
    let destinations = null;
    // Marker drills open after the day-1 patrol, with the warden at cell 02.
    // The events drill is about the patrol itself, so it starts in the office.
    const marker = s !== 'empty' && s !== 'events';
    if (s === 'events') {
      place(state, 4, 'wolf', 1);
      place(state, 5, 'mammoth', 0);
      place(state, 6, 'wolf', 0);
      place(state, 13, 'lion', 2);
      place(state, 15, 'mammoth', 1);
      // Cell 02 holds one of the two events that only add tiers, by the seed.
      const bonus = pickOne(sideStream(state, 'events-drill'), ['trickster', 'appetite']);
      hide(state, 1, 'wolf', 0, { event: bonus, seen: true });
      hide(state, 2, 'lion', 2, { event: 'execution', known: 1, seen: true });
      hide(state, 3, 'mammoth', 1, { event: 'chain', seen: true });
      destinations = [1, 2, 3];
      note = `獄中事變練習：牢房 02 藏著${eventName(bonus)}，牢房 03 的稀有囚犯身後藏著處刑效率，牢房 04 藏著連鎖反應。巡視其中一間，然後選擇接受或略過事變。`;
    } else if (s === 'ivory') {
      place(state, 1, 'wolf', 1);
      state.cells[1].ivory = true;
      place(state, 2, 'lion', 2);
      place(state, 3, 'mammoth', 0);
      place(state, 7, 'wolf', 2);
      place(state, 12, 'mammoth', 3);
      place(state, 15, 'rat', 1);
      note = `象牙練習：典獄長所在的牢房 02 帶有象牙標記。替換牠的囚犯，監區上就有 ${plural(state.params.ivoryCount, '隻囚犯')}各升一階。`;
    } else if (s === 'prey') {
      const lion = place(state, 1, 'lion', 2);
      const wolf = place(state, 2, 'wolf', 2);
      place(state, 5, 'mammoth', 2);
      place(state, 9, 'mammoth', 1);
      place(state, 13, 'rat', 1);
      state.prey.push({ lion: lion.id, prey: wolf.id, preyBeast: 'wolf', rounds: state.params.preyRounds, next: 2 });
      note = `獵物標記練習：牢房 02 的狂獅已標記牢房 03 的頭狼。每天早上兩者各升一階，持續 ${plural(state.params.preyRounds, '個早上')}。狂獅就在典獄長的牢房，今天就能吞噬牠的獵物，但這會重骰牠的野獸並結束標記。`;
    } else if (s === 'scratch') {
      place(state, 1, 'wolf', 1);
      hide(state, 2, 'mammoth', 1, { scratch: true, known: 1 });
      place(state, 8, 'wolf', 2);
      hide(state, 9, 'lion', 2, { scratch: true, known: 1 });
      place(state, 14, 'rat', 0);
      note = '劃痕練習：有劃痕的牢門會顯示裡面的稀有度。頭狼可以隔著門吞噬同稀有度的囚犯（不論野獸），+3。';
    } else if (s === 'nest') {
      place(state, 1, 'lion', 2);
      hide(state, 2, 'rat', 0, { nest: { due: 1 + state.params.nestDays } });
      place(state, 5, 'mammoth', 2);
      place(state, 11, 'wolf', 2);
      place(state, 15, 'rat', 0);
      note = `鼠巢練習：牢房 03 的鼠巢會在第 ${1 + state.params.nestDays} 天早上孵出一隻${tierName(state.params.nestTier)}碩鼠。在那之前巡視它會把它摧毀。`;
    }
    if (s === 'empty') {
      // A run starts with inmates already out, on random locked cells
      // without an event. They don't count as cells opened.
      const p = state.params;
      const stream = sideStream(state, 'start-inmates');
      const count = Math.max(0, p.startInmates - (rand(stream) * 100 < p.startInmatesFewer ? 1 : 0));
      const cells = shuffle(stream, state.cells.filter((c) => c.n !== OFFICE && c.sealed && !c.event)).slice(0, count);
      for (const c of cells) place(state, c.n, BEASTS[pickIndex(stream, p.beastWeights)], pickIndex(stream, p.startWeights));
      if (cells.length) note = `典獄長從牢房 01 的審訊室出發，監區上已有 ${plural(cells.length, '隻囚犯')}在外。從今天的目的地中選一個：打開一扇上鎖的門，或去找一隻囚犯。`;
    }
    for (const cell of state.cells) if (!cell.sealed) cell.event = null;
    offerStartTools(state);
    if (marker) state.position = 1;
    beginDay(state, []);
    if (destinations) state.destinations = destinations;
    if (marker) state.phase = 'manage';
    log(state, 'drill', note);
  }

  // As in the live game, a run starts with a pick of 3 random instruments.
  // More starting picks (a Lab value) each offer 3 others.
  function offerStartTools(state) {
    const picks = Math.min(state.params.startTools, Math.floor(TOOL_IDS.length / 3));
    if (picks <= 0) return;
    const stream = sideStream(state, 'start-tools');
    let pool = TOOL_IDS.filter((t) => !has(state, t));
    for (let i = 0; i < picks; i++) {
      const options = drawTools(stream, state, pool, 3);
      pool = pool.filter((t) => !options.includes(t));
      state.pending.push({ kind: 'tool', options, start: true });
    }
    log(state, 'tool', picks === 1 ? '請選一件起始刑具。' : `請逐一選擇 ${picks} 件起始刑具。`);
  }

  // ---------- Day flow ----------

  // Today's door count, drawn each morning.
  // The Forged Key takes one door off every morning.
  function destinationLimit(state) {
    return Math.max(1, (state.destBase || state.params.destinations) - (has(state, 'forged') ? 1 : 0) - (has(state, 'whip') ? 1 : 0) - (has(state, 'stake') ? 1 : 0));
  }

  // Destinations come from the cells just ahead of the warden, clockwise:
  // locked ones to open, open ones whose inmates you already know, or the
  // warden's office, where the warden can Instigate or Bestow.
  function rollDestinations(state) {
    // Some mornings offer one door fewer; the odds are a practice value.
    const fewer = rand(state) * 100 < state.params.fewerDoorsChance;
    state.destBase = Math.max(1, state.params.destinations - (fewer ? 1 : 0));
    const range = Math.min(state.params.patrolRange, CELL_COUNT - 1);
    const ahead = [];
    for (let i = 1; i <= range; i++) ahead.push(state.cells[(state.position + i) % CELL_COUNT]);
    // The office comes up less often than a cell (officeDoorOdds): drawn
    // one door at a time, by weight, without repeats.
    const weight = (c) => (c.n === OFFICE ? state.params.officeDoorOdds / 100 : 1);
    let picks = [];
    for (let k = destinationLimit(state); k > 0 && ahead.length; k--) {
      if (picks.length && !ahead.some((c) => weight(c) > 0)) break;
      picks.push(ahead.splice(pickIndex(state, ahead.map(weight)), 1)[0]);
    }
    // A door with an event behind it means a two-door morning.
    const hasEvent = (c) => c.sealed && c.event && c.seen;
    if (state.params.eventTwoDoors && picks.some(hasEvent)) picks = [...picks.filter(hasEvent), ...picks.filter((c) => !hasEvent(c))].slice(0, 2);
    state.destinations = picks.map((c) => c.n).sort((a, b) => stepsBetween(state.position, a) - stepsBetween(state.position, b));
  }

  // Trims today's options to today's door count.
  function fitDestinations(state) {
    if (state.phase !== 'patrol') return;
    state.destinations = state.destinations.slice(0, destinationLimit(state));
  }

  function beginDay(state, events) {
    state.phase = 'patrol';
    state.used = freshDay();
    checkPrey(state);
    for (const link of state.prey.slice()) {
      if (link.next > state.day) continue;
      const lion = boardCellOf(state, link.lion).inmate;
      const prey = boardCellOf(state, link.prey).inmate;
      link.rounds -= 1;
      link.next = state.day + 1;
      log(state, 'prey', `獵物標記：狂獅與牠的獵物各升一階（${describe(lion)} 升到${tierName(Math.min(RAINBOW, lion.tier + 1))}，${describe(prey)} 升到${tierName(Math.min(RAINBOW, prey.tier + 1))}）。${link.rounds > 0 ? `還剩 ${plural(link.rounds, '個早上')}。` : '標記已用盡。'}`);
      if (link.rounds <= 0) state.prey = state.prey.filter((l) => l !== link);
      promote(state, lion, 1, false, events);
      promote(state, prey, 1, false, events);
    }
    checkPrey(state);
    for (const cell of state.cells) {
      if (!cell.nest || cell.nest.due > state.day) continue;
      log(state, 'nest', `牢房 ${cellLabel(cell.n)} 的鼠巢孵化了。`);
      openCell(state, cell, 'side', events, { beast: 'rat', tier: state.params.nestTier });
      events.push({ type: 'hatch', cell: cell.n });
    }
    if (has(state, 'tongs')) {
      const mammoths = boardCells(state).filter((c) => c.inmate.beast === 'mammoth' && !c.ivory);
      if (mammoths.length) {
        const cell = pickOne(state, mammoths);
        cell.ivory = true;
        log(state, 'tool', `惡欲鐵鉗：牢房 ${cellLabel(cell.n)} 的巨象獲得象牙標記。`);
      }
    }
    // Filthy Claws: Scratch Marks on 1 random unopened cell, which then
    // shows the rarity inside.
    if (has(state, 'claws')) {
      const free = state.cells.filter((c) => c.sealed && !c.scratch && !c.nest);
      if (free.length) {
        const cell = pickOne(state, free);
        const who = hiddenOf(state, cell);
        cell.scratch = true;
        cell.known = Math.max(cell.known, 1);
        log(state, 'tool', `髒污鐵爪：牢房 ${cellLabel(cell.n)} 出現劃痕，裡面是一隻${tierName(who.tier)}囚犯。`, { type: 'claws', cell: cell.n });
      }
    }
    if (has(state, 'ironbox')) {
      const free = state.cells.filter((c) => c.sealed && !c.nest);
      if (free.length) {
        const cell = pickOne(state, free);
        cell.nest = { due: state.day + state.params.nestDays };
        log(state, 'nest', `蠕動鐵盒：牢房 ${cellLabel(cell.n)} 變成鼠巢，將在第 ${cell.nest.due} 天孵化。`);
        events.push({ type: 'nest', cell: cell.n });
      }
    }
    if (has(state, 'ravenous')) ravenousChains(state, events);
    if (has(state, 'coin')) coinOfFate(state, events);
    // A morning's new special event, before the doors are drawn (day 1 has
    // the run's start instead).
    if (state.day > 1) spawnEvent(state, state.params.eventMorningChance);
    rollDestinations(state);
  }

  // Kin's Coin of Fate, each morning: with inmates that share a beast and
  // rarity on the block, 60% of the time one of them goes and another like
  // it rises 2 tiers.
  function coinOfFate(state, events) {
    const kind = (c) => `${c.inmate.beast}|${c.inmate.tier}`;
    const board = boardCells(state);
    const count = {};
    for (const c of board) count[kind(c)] = (count[kind(c)] || 0) + 1;
    const matching = board.filter((c) => count[kind(c)] >= 2);
    if (!matching.length || rand(state) >= 0.6) return;
    const gone = pickOne(state, matching);
    const lucky = pickOne(state, matching.filter((c) => c !== gone && kind(c) === kind(gone)));
    const goneWho = describe(gone.inmate);
    const luckyWho = describe(lucky.inmate);
    emptyCell(state, gone);
    events.push({ type: 'removed', cell: gone.n });
    checkPrey(state);
    log(state, 'tool', `手足的命運硬幣：牢房 ${cellLabel(gone.n)} 的${goneWho}被移除，牢房 ${cellLabel(lucky.n)} 的${luckyWho}升 2 階。`, { type: 'coin', removed: gone.n, cell: lucky.n });
    promote(state, lucky.inmate, 2, false, events);
  }

  // Ferocious Beast's Ravenous Chains, each morning: the highest-rarity
  // inmate (one at random among equals) removes the inmates in the cells on
  // either side of it on the ring, and may rise a tier for each.
  function ravenousChains(state, events) {
    const board = boardCells(state);
    if (!board.length) return;
    const top = Math.max(...board.map((c) => c.inmate.tier));
    const cell = pickOne(state, board.filter((c) => c.inmate.tier === top));
    const eater = cell.inmate;
    const sides = [(cell.n + CELL_COUNT - 1) % CELL_COUNT, (cell.n + 1) % CELL_COUNT].map((k) => state.cells[k]).filter((c) => !c.sealed && c.inmate);
    if (!sides.length) return;
    const gone = sides.map((c) => `${cellLabel(c.n)} 的${describe(c.inmate)}`);
    let rises = 0;
    for (const side of sides) {
      emptyCell(state, side);
      events.push({ type: 'removed', cell: side.n });
      if (rand(state) < 0.4) rises += 1;
    }
    checkPrey(state);
    log(state, 'tool', `兇獸的飢餓絞鏈：牢房 ${cellLabel(cell.n)} 的${describe(eater)}移除了${gone.join('與')}${rises ? `，並升 ${plural(rises, '階')}` : ''}。`, { type: 'ravenous', cell: cell.n, removed: sides.map((c) => c.n), rises });
    if (rises) promote(state, eater, rises, false, events);
  }

  // ---------- Queries ----------

  function clockwisePath(state, to) {
    const path = [];
    let n = state.position;
    while (n !== to) {
      n = (n + 1) % CELL_COUNT;
      path.push(n);
    }
    return path.length ? path : [to];
  }

  function patrolOptions(state) {
    return state.phase === 'patrol' ? state.destinations.slice() : [];
  }

  function devourOptions(state, n) {
    const cell = state.cells[n];
    if (!cell || cell.sealed || !cell.inmate) return [];
    const eater = cell.inmate;
    const out = [];
    for (const c of state.cells) {
      if (c === cell) continue;
      if (!c.sealed && canEat(state, eater, c.inmate)) out.push({ cell: c.n, scratch: false });
      else if (c.sealed && c.scratch && eater.beast === 'wolf' && c.hidden && c.hidden.tier === eater.tier && eater.tier < RAINBOW) out.push({ cell: c.n, scratch: true });
    }
    return out;
  }

  // The sure part of a devour's gain; Rusty Saw and Avenger's Casket roll later.
  function gainFor(state, from, option) {
    const eater = state.cells[from].inmate;
    let gain = option.scratch ? 2 + (state.params.scratchStacksBase ? 1 : 0) : 1;
    const notes = [];
    if (option.scratch) notes.push(`劃痕 +${gain - 1}`);
    const target = state.cells[option.cell];
    const meal = target ? (target.sealed ? target.hidden : target.inmate) : null;
    if (!option.scratch && meal && eater && eater.beast === 'mammoth' && has(state, 'maul')) {
      gain = Math.max(1, meal.tier + 2 - eater.tier);
      notes.push(`象腳重錘升到${tierName(Math.min(RAINBOW, meal.tier + 2))}`);
    }
    // The Muzzle counts the block before the meal goes, the meal included.
    if (has(state, 'muzzle') && boardCells(state).length <= 4) {
      gain += 2;
      notes.push('痛苦口籠 +2');
    }
    if (has(state, 'skewer') && eater && eater.beast === 'rat') {
      gain += 1;
      notes.push('鼠頭串 +1');
    }
    if (has(state, 'crown') && eater && eater.beast === 'lion') {
      gain += 2;
      notes.push('牢中王的鐵冠 +2');
    }
    return { gain, notes, saw: has(state, 'saw'), revenge: has(state, 'revenge') };
  }

  function executionVictims(state, n) {
    const cell = state.cells[n];
    const exec = cell && !cell.sealed ? cell.inmate : null;
    if (!exec) return [];
    const eats = eatsOf(state, exec.beast);
    return boardCells(state).filter((c) => c !== cell && eats.includes(c.inmate.beast) && (state.params.executionSameTier ? c.inmate.tier === exec.tier : c.inmate.tier < exec.tier));
  }

  // Behind Closed Doors' "Scarce Code": the beasts with the fewest inmates on
  // the block (none counts). The event picks one of them at random.
  function scarceBeasts(state) {
    const counts = BEASTS.map((b) => boardInmates(state).filter((i) => i.beast === b).length);
    const low = Math.min(...counts);
    return BEASTS.filter((_, i) => counts[i] === low);
  }

  // Ravenous Appetite picks one of the inmates with the lowest rarity on the
  // block, at random.
  function lowestInmates(state) {
    const board = boardInmates(state);
    const low = Math.min(...board.map((i) => i.tier));
    return board.filter((i) => i.tier === low);
  }

  function rosterOf(state) {
    const rows = [];
    for (const c of state.cells) if (!c.sealed && c.inmate) rows.push({ beast: c.inmate.beast, tier: c.inmate.tier, where: `牢房 ${cellLabel(c.n)}` });
    for (const v of state.vault) rows.push({ beast: v.beast, tier: RAINBOW, where: `收容區，第 ${v.day} 天` });
    rows.sort((a, b) => b.tier - a.tier || BEASTS.indexOf(a.beast) - BEASTS.indexOf(b.beast));
    return { rows, byTier: TIERS.map((_, t) => rows.filter((r) => r.tier === t).length) };
  }

  const toolText = (id) => (TOOLS[id] ? TOOLS[id].text : GIFTS[id] ? GIFTS[id].text : '');
  const toolName = (id) => (TOOLS[id] ? TOOLS[id].name : GIFTS[id] ? GIFTS[id].name : id);
  // The English name the game client prints (for matching screenshot text).
  const toolNameEn = (id) => (TOOLS[id] ? (TOOLS[id].en || TOOLS[id].name) : GIFTS[id] ? (GIFTS[id].en || GIFTS[id].name) : id);

  // ---------- Actions ----------

  function patrol(state, n) {
    const blocked = guard(state, 'patrol');
    if (blocked) return blocked;
    if (!state.destinations.includes(n)) return fail(state.ratway ? '暗渠鼠道可以前往審訊室以外的任何牢房。' : '請巡視今天的其中一個目的地。');
    const events = [{ type: 'move', from: state.position, to: n }];
    const cell = state.cells[n];
    // The Sewer Ratway's move isn't a walk: no tiles.
    const ratway = !!state.ratway;
    state.ratway = false;
    const steps = ratway ? 0 : stepsBetween(state.position, n);
    if (!ratway) state.stats.patrols += 1;
    let event = null;
    if (state.chain && !ratway) {
      const path = clockwisePath(state, n);
      log(state, 'event', `連鎖反應：從牢房 ${cellLabel(state.position)} 順時針走到牢房 ${cellLabel(n)}，沿途所有未開啟的牢門都會打開。`, { type: 'sweep', from: state.position, cell: n });
      for (const k of path) openCell(state, state.cells[k], 'side', events);
      state.chain = false;
    } else if (cell.sealed) {
      event = openCell(state, cell, 'patrol', events);
    } else if (n === OFFICE) {
      log(state, 'patrol', '走到審訊室：煽動或賞賜。', { type: 'walk', cell: n, who: null });
    } else if (cell.inmate) {
      log(state, 'patrol', `走到牢房 ${cellLabel(n)}。牠的${describe(cell.inmate)}可以發起今天的吞噬。`, { type: 'walk', cell: n, who: snap(cell.inmate) });
    } else {
      log(state, 'patrol', `走到空牢房 ${cellLabel(n)}。`, { type: 'walk', cell: n, who: null });
    }
    // An event can wait in an open cell beside its inmate (the game's cell
    // popup: "Can trigger Prison Incident", report 52). Walking in sets it
    // off, as opening a door with one would.
    if (!event && !cell.sealed && cell.inmate && cell.event) {
      event = cell.event;
      cell.event = null;
    }
    state.position = n;
    checkPrey(state);
    if (!ratway) walked(state, steps, events);
    // The move's chance of a new special event elsewhere on the block.
    spawnEvent(state, state.params.eventWalkChance);
    if (event && state.cells[n].inmate) {
      state.phase = 'event';
      state.event = { kind: event, cell: n };
      countObjective(state, 'incident', '次獄中事變');
      log(state, 'event', `牢房 ${cellLabel(n)} 有一個獄中事變：${eventName(event)}。接受或略過。`);
    } else {
      state.phase = n === OFFICE ? 'office' : 'manage';
      // Tyranny: each stop at the office also triggers Instigate and Bestow
      // 3 more times each, by themselves, before the visit's own choice.
      if (n === OFFICE && state.startEvent === 'tyranny') {
        for (let i = 0; i < START_EVENTS.tyranny.extra; i++) {
          instigate(state, events, '暴政，煽動');
          bestow(state, events, '暴政，賞賜');
        }
      }
    }
    return ok(events);
  }

  // The warden's office: Instigate brings new special events behind locked
  // doors, and Bestow raises 1 random inmate on the block a tier. One of
  // the two, then the day goes on as usual.
  function officeAct(state, choice) {
    if (state.phase !== 'office') return fail('只有前往審訊室時才能煽動或賞賜。');
    if (state.pending.length) return fail('請先完成待選的選擇。');
    // used.officeOnly: the game shows only that card (the analyzer reads
    // them; report 383 had Bestow alone).
    const only = state.used && state.used.officeOnly;
    if (only && choice !== only) return fail(`你的遊戲今天只提供${only === 'bestow' ? '賞賜' : '煽動'}。`);
    const events = [];
    if (choice === 'instigate') instigate(state, events, '煽動');
    else if (choice === 'bestow') bestow(state, events, '賞賜');
    else return fail('請選擇煽動或賞賜。');
    state.phase = 'manage';
    return ok(events);
  }

  // Instigate: INSTIGATE_EVENTS new special events, each on a random free
  // cell: a locked door with none, or an inmate's open cell with none.
  const instigateCells = (state) => state.cells.filter((c) => c.n !== OFFICE && !c.event && (c.sealed ? !c.nest : !!c.inmate));
  // How many events an Instigate makes now: 2 on a board with none, else 1.
  const instigateCount = (state) => (state.cells.some((c) => c.event) ? INSTIGATE_EVENTS : INSTIGATE_EVENTS_EMPTY);
  function instigate(state, events, how) {
    const cells = shuffle(state, instigateCells(state)).slice(0, instigateCount(state));
    for (const c of cells) {
      c.event = rollEvent(state);
      c.seen = true;
    }
    log(state, 'event', cells.length
      ? `${how}：${cells.map((c) => `牢房 ${cellLabel(c.n)} ${c.sealed ? '門後' : '裡'}`).join('與')}出現了一個獄中事變。`
      : `${how}：沒有空的牢房可以放新事變。`, { type: 'instigate', cells: cells.map((c) => c.n) });
  }

  // Bestow: 1 random inmate on the block rises a tier.
  function bestow(state, events, how) {
    const pool = boardInmates(state).filter((i) => i.tier < RAINBOW);
    const at = state.log.length;
    if (pool.length) {
      const who = pickOne(state, pool);
      const before = snap(who);
      const cell = cellOf(state, who.id).n;
      promote(state, who, 1, false, events);
      logAt(state, at, 'event', `${how}：牢房 ${cellLabel(cell)} 的${describe(before)}升到${tierName(before.tier + 1)}。`, { type: 'bestow', cell, who: before });
    } else {
      log(state, 'event', `${how}：監區上沒有可以升階的囚犯。`, { type: 'bestow', cell: null, who: null });
    }
  }

  // After the warden's walk: the Long-Chained Shackles reward a long one, the
  // Short-Chained Shackles a short one, and every cell walked counts for
  // Prison Walk.
  function walked(state, steps, events) {
    if (has(state, 'shortchain') && steps <= 3 && rand(state) < 0.5) {
      const sealed = state.cells.filter((c) => c.sealed);
      if (sealed.length) {
        const target = pickOne(state, sealed);
        log(state, 'tool', `短鏈腳鐐：走了 ${steps} 格，開啟牢房 ${cellLabel(target.n)}。`, { type: 'shortchain', cell: target.n });
        openCell(state, target, 'side', events);
      }
    }
    if (has(state, 'shackles') && steps >= 4 && rand(state) < 0.4) {
      const pool = boardInmates(state).filter((i) => i.tier < RAINBOW);
      if (pool.length) {
        const who = pickOne(state, pool);
        log(state, 'tool', `長鏈腳鐐：走了 ${steps} 格，牢房 ${cellLabel(cellOf(state, who.id).n)} 的${describe(who)}升一階。`, { type: 'shackles', cell: cellOf(state, who.id).n, who: snap(who) });
        promote(state, who, 1, false, events);
      }
    }
    const o = state.objective;
    if (o.id !== 'walk' || state.milestone) return;
    o.progress = Math.min(OBJECTIVES.walk.need, o.progress + steps);
    if (o.progress >= OBJECTIVES.walk.need) meetObjective(state, `已移動 ${OBJECTIVES.walk.need} 格`);
  }

  function resolveEvent(state, accept) {
    if (state.phase !== 'event' || !state.event) return fail('沒有需要決定的獄中事變。');
    if (state.pending.length) return fail('請先完成待選的選擇。');
    const { kind, cell: n } = state.event;
    const events = [];
    const name = eventName(kind);
    if (!accept) {
      state.event = null;
      state.phase = 'manage';
      log(state, 'event', `略過了${name}。`, { type: 'skipped', name });
      return ok(events);
    }
    if (kind === 'ratway') {
      // Sewer Ratway: the warden moves to any cell but the office, and what's
      // there happens as on a patrol (a locked door opens; any event behind it
      // shows). Not a walk: no tiles, and the cells on the way stay unseen.
      state.event = null;
      state.phase = 'patrol';
      state.ratway = true;
      state.destinations = state.cells.filter((c) => c.n !== OFFICE).map((c) => c.n);
      log(state, 'event', '暗渠鼠道：選擇審訊室以外的任何牢房移動過去。', { type: 'ratway' });
      return ok(events);
    }
    if (kind === 'chain') {
      state.chain = true;
      log(state, 'event', '連鎖反應已就緒：下一次巡視會打開順時針走到目的地沿途所有未開啟的牢房。', { type: 'armed' });
    } else if (kind === 'trickster') {
      const who = state.cells[n].inmate;
      if (!who) return fail('那間牢房已經沒有囚犯可以讓事變改變了。');
      const before = snap(who);
      const scarce = scarceBeasts(state);
      who.beast = pickOne(state, scarce);
      who.tier = SUPREME;
      checkPrey(state);
      const why = scarce.length === 1 ? `監區上最稀少的野獸` : `從 ${scarce.length} 種最稀少的野獸中抽出`;
      log(state, 'event', `暗箱操作：牢房 ${cellLabel(n)} 的${describe(before)}變成了${describe(who)}（${why}）。`, { type: 'trickster', cell: n, who: before, after: snap(who) });
      events.push({ type: 'promote', cell: n, from: before.tier, to: who.tier });
      // The card says it triggers no other effects: no instrument reacts. The
      // run's objective still counts the Supreme.
      afterGrowth(state, who, events);
    } else if (kind === 'crow') {
      // The next locked cells clockwise from the warden show their rarity;
      // open cells, nests and the office are passed over.
      const seen = [];
      for (let i = 1; i < CELL_COUNT && seen.length < CROW_CELLS; i++) {
        const c = state.cells[(n + i) % CELL_COUNT];
        if (!c.sealed || c.nest) continue;
        hiddenOf(state, c);
        c.known = Math.max(c.known, 1);
        seen.push(c);
      }
      log(state, 'event', seen.length
        ? `鴉之低語：${seen.map((c) => `牢房 ${cellLabel(c.n)} 裡是${tierName(c.hidden.tier)}`).join('，')}。`
        : '鴉之低語：沒有剩下可揭露的上鎖牢房。', { type: 'crow', cells: seen.map((c) => c.n) });
    } else if (kind === 'hunt') {
      // Every locked cell holding a Normal or Magic shows its rarity, so the
      // ones left dark hold Rare or better. Nests hold no inmate yet.
      const low = [];
      const high = [];
      for (const c of state.cells) {
        if (!c.sealed || c.nest) continue;
        if (hiddenOf(state, c).tier < HUNT_BELOW) {
          c.known = Math.max(c.known, 1);
          low.push(c);
        } else {
          c.atLeast = Math.max(c.atLeast || 0, HUNT_BELOW);
          high.push(c);
        }
      }
      const shown = low.map((c) => `牢房 ${cellLabel(c.n)} 裡是${tierName(c.hidden.tier)}`).join('，');
      const dark = high.length === 1 ? `牢房 ${cellLabel(high[0].n)} 裡是稀有以上` : `${low.length ? '其餘' : '全部'} ${high.length} 間上鎖牢房裡都是稀有以上`;
      const text = low.length && high.length ? `${shown}；${dark}` : low.length ? shown : high.length ? dark : '沒有剩下可揭露的上鎖牢房';
      log(state, 'event', `${eventName(kind)}：${text}。`, { type: 'hunt', cells: low.map((c) => c.n), high: high.map((c) => c.n) });
    } else if (kind === 'portion') {
      // Up to 3 random inmates rise a tier; with fewer on the block, all of
      // them. It stays among the Prison Incidents.
      const pool = boardInmates(state).filter((i) => i.tier < RAINBOW);
      const picks = shuffle(state, pool).slice(0, PORTION_INMATES);
      const at = state.log.length;
      const raised = picks.map((who) => ({ who: snap(who), cell: cellOf(state, who.id).n }));
      for (const who of picks) if (boardCellOf(state, who.id)) promote(state, who, 1, false, events);
      if (raised.length) {
        const names = raised.map((r) => `牢房 ${cellLabel(r.cell)} 的${describe(r.who)}`);
        const who = names.join('、');
        logAt(state, at, 'event', `${eventName(kind)}：${who}升一階。`, { type: kind, raised });
      } else {
        log(state, 'event', `${eventName(kind)}：監區上沒有可以升階的囚犯。`, { type: kind, raised: [] });
      }
    } else if (USURP[kind]) {
      // Random inmates rise (all of them for Usurpation IV), then this
      // Usurpation leaves the Prison Incidents and the next joins them.
      const u = USURP[kind];
      const pool = boardInmates(state).filter((i) => i.tier < RAINBOW);
      const picks = u.count === 'all' ? pool : shuffle(state, pool).slice(0, u.count);
      const at = state.log.length;
      const raised = picks.map((who) => ({ who: snap(who), cell: cellOf(state, who.id).n }));
      for (const who of picks) if (boardCellOf(state, who.id)) promote(state, who, u.by, false, events);
      const tiers = u.by === 1 ? '一階' : `${u.by} 階`;
      if (raised.length) {
        const who = u.count === 'all' ? `監區上全部 ${plural(raised.length, '隻囚犯')}` : raised.map((r) => `牢房 ${cellLabel(r.cell)} 的${describe(r.who)}`).join('與');
        logAt(state, at, 'event', `${eventName(kind)}：${who}升${tiers}。`, { type: kind, raised });
      } else {
        log(state, 'event', `${eventName(kind)}：監區上沒有可以升階的囚犯。`, { type: kind, raised: [] });
      }
      state.eventPool = (state.eventPool || EVENT_POOL).filter((id) => id !== kind);
      if (u.next && !state.eventPool.includes(u.next)) state.eventPool.push(u.next);
      if (u.next) {
        // Each Usurpation's card also puts the next one on a random free
        // cell at once, as an Instigate would: a locked door, or an inmate's
        // open cell (the user, 2026-10-18: any space, and not only I's).
        const free = instigateCells(state);
        if (free.length) {
          const cell = pickOne(state, free);
          cell.event = u.next;
          cell.seen = true;
          log(state, 'event', `${eventName(u.next)}出現在牢房 ${cellLabel(cell.n)} ${cell.sealed ? '門後' : '裡'}。`);
        }
      }
    } else if (kind === 'freedom') {
      // Random locked cells open, setting nothing else off.
      const doors = shuffle(state, state.cells.filter((c) => c.sealed)).slice(0, FREEDOM_CELLS);
      log(state, 'event', doors.length ? `自由的滋味：${doors.length === 1 ? `牢房 ${cellLabel(doors[0].n)} 開啟` : `牢房 ${doors.map((c) => cellLabel(c.n)).join('、')} 開啟`}。` : '自由的滋味：沒有剩下可開啟的上鎖牢房。', { type: 'freedom', cells: doors.map((c) => c.n) });
      for (const c of doors) openCell(state, c, 'side', events);
    } else if (kind === 'convict') {
      // A random locked cell opens on a Legendary or better inmate, rolled
      // with the door odds above Rare. Like any extra door, it sets nothing
      // else off.
      const sealed = state.cells.filter((c) => c.sealed);
      if (sealed.length) {
        const target = pickOne(state, sealed);
        const weights = state.params.tierWeights.map((w, t) => (t >= 3 ? w : 0));
        const tier = weights.some((w) => w > 0) ? pickIndex(state, weights) : 3;
        log(state, 'event', `高危罪犯：牢房 ${cellLabel(target.n)} 開啟，裡面是一隻${tierName(tier)}囚犯。`, { type: 'convict', cell: target.n });
        openCell(state, target, 'side', events, { beast: BEASTS[pickIndex(state, state.params.beastWeights)], tier });
      } else {
        log(state, 'event', '高危罪犯：沒有剩下可開啟的上鎖牢房。', { type: 'convict', cell: null });
      }
    } else if (kind === 'appetite') {
      const who = pickOne(state, lowestInmates(state));
      const at = state.log.length;
      const before = snap(who);
      const where = cellOf(state, who.id).n;
      let gain = 0;
      for (let i = 0; i < APPETITE_TRIES; i++) if (rand(state) < APPETITE_ODDS) gain += 1;
      // Rarity only: the beast stays.
      if (gain) promote(state, who, gain, false, events);
      const after = { beast: before.beast, tier: Math.min(RAINBOW, before.tier + gain) };
      logAt(state, at, 'event', gain
        ? `飢腸轆轆：牢房 ${cellLabel(where)} 的${describe(before)}在 ${APPETITE_TRIES} 次嘗試中成功 ${gain} 次，升到${tierName(after.tier)}。`
        : `飢腸轆轆：牢房 ${cellLabel(where)} 的${describe(before)} ${APPETITE_TRIES} 次嘗試全部失敗。`, { type: 'appetite', cell: where, who: before, after, gain });
    } else {
      const cell = state.cells[n];
      const exec = cell.inmate;
      if (!exec) return fail('那間牢房已經沒有囚犯可以執行處刑效率了。');
      const victims = executionVictims(state, n);
      const at = state.log.length;
      const names = victims.map((c) => `${describe(c.inmate)}（${cellLabel(c.n)}）`);
      const record = { type: 'execution', cell: n, who: snap(exec), victims: victims.map((c) => snap(c.inmate)) };
      for (const c of victims) {
        emptyCell(state, c);
        events.push({ type: 'devour', from: n, to: c.n });
      }
      state.stats.executions += 1;
      checkPrey(state);
      const before = describe(exec);
      if (victims.length) promote(state, exec, victims.length, state.params.executionRerolls, events);
      record.after = snap(exec);
      logAt(state, at, 'event', victims.length
        ? `處刑效率：牢房 ${cellLabel(n)} 的${before}移除了${names.join('、')}，並升 ${victims.length} 階。`
        : `處刑效率：牢房 ${cellLabel(n)} 的${before}找不到可以處決的對象。`, record);
    }
    state.event = null;
    state.phase = 'manage';
    return ok(events);
  }

  // Resolves one bite without the phase checks, so gifts and chains can reuse
  // it. `chained` marks the bites a chain takes by itself, after the first.
  // Returns a record of the bite for the log.
  function doDevour(state, from, option, events, chained) {
    const eaterCell = state.cells[from];
    const mealCell = state.cells[option.cell];
    const eater = eaterCell.inmate;
    const meal = mealCell.sealed ? mealCell.hidden : mealCell.inmate;
    const bite = { from, cell: option.cell, scratch: !!option.scratch, eater: snap(eater), meal: snap(meal) };
    countObjective(state, 'consume', '次吞噬');
    const wasRat = eater.beast === 'rat';
    const wasLion = eater.beast === 'lion';
    // The Muzzle counts the block before the meal goes, the meal included
    // (the user, 2026-10-18).
    const crowd = boardCells(state).length;
    emptyCell(state, mealCell);
    let gain = option.scratch ? 2 + (state.params.scratchStacksBase ? 1 : 0) : 1;
    const notes = [];
    if (option.scratch) notes.push(`劃痕 +${gain - 1}`);
    // The Elephant-Foot Maul: a Mammoth rises to 2 tiers above its meal.
    if (!option.scratch && eater.beast === 'mammoth' && has(state, 'maul')) {
      gain = Math.max(1, meal.tier + 2 - eater.tier);
      notes.push(`象腳重錘升到${tierName(Math.min(RAINBOW, meal.tier + 2))}`);
    }
    if (has(state, 'muzzle') && crowd <= 4) {
      gain += 2;
      notes.push('痛苦口籠 +2');
    }
    if (has(state, 'skewer') && wasRat) {
      gain += 1;
      notes.push('鼠頭串 +1');
    }
    if (has(state, 'crown') && wasLion) {
      gain += 2;
      notes.push('牢中王的鐵冠 +2');
    }
    if (has(state, 'saw') && rand(state) < 0.25) {
      gain += 1;
      notes.push('鏽鋸 +1');
    }
    if (has(state, 'whip') && rand(state) < 0.35) {
      gain += 1;
      notes.push('棘刺鐵鞭 +1');
    }
    if (chained && has(state, 'collar') && rand(state) < 0.8) {
      gain += 1;
      notes.push('倒刺項圈 +1');
    }
    const revenge = has(state, 'revenge') && rand(state) < 0.3;
    events.push({ type: 'devour', from, to: option.cell });
    promote(state, eater, gain, !cageFight(state), events);
    state.stats.devours += 1;
    Object.assign(bite, { gain, notes, after: snap(eater) });
    checkPrey(state);
    if (revenge && boardCellOf(state, eater.id)) {
      const sealed = state.cells.filter((c) => c.sealed);
      if (sealed.length) {
        const target = pickOne(state, sealed);
        const food = pickOne(state, eatsOf(state, eater.beast, eater.tier));
        log(state, 'tool', `復仇者之匣：牢房 ${cellLabel(target.n)} 開啟，裡面是${describe(eater)}的獵物。`);
        openCell(state, target, 'side', events, { beast: food, tier: eater.tier });
      }
    }
    // Crowded Beastcage: the eaten inmate's cell may open again at once,
    // holding someone new.
    if (has(state, 'cage') && mealCell.sealed && rand(state) < 0.4) {
      log(state, 'tool', `擁擠獸籠：牢房 ${cellLabel(mealCell.n)} 再次開啟。`, { type: 'cage', cell: mealCell.n });
      openCell(state, mealCell, 'side', events);
    }
    return bite;
  }

  // One log entry for a whole devour, inserted before the side effects that
  // were logged while it resolved. Its record lists every bite, and whether
  // the player stopped the chain.
  function logDevour(state, at, bites, stopped) {
    if (!bites.length) return;
    const first = bites[0];
    const last = bites[bites.length - 1];
    const end = last.after.tier >= RAINBOW ? '牠達到綺彩，進入收容區。' : '';
    const stop = stopped ? '之後連鎖被停止。' : '';
    let text;
    if (bites.length === 1) {
      const outcome = last.after.tier < RAINBOW ? `，現在是${beastName(last.after.beast)}` : '';
      text = `牢房 ${cellLabel(first.from)} 的${describe(first.eater)}吞噬了牢房 ${cellLabel(first.cell)} ${first.scratch ? '有劃痕門後' : ''}的${describe(first.meal)}。牠升到${tierName(last.after.tier)}${outcome}${first.notes.length ? `（${first.notes.join('，')}）` : ''}。${stop}`;
    } else {
      const steps = bites.map((b) => `${describe(b.eater)}吃掉${b.scratch ? '有劃痕門後的' : ''}${describe(b.meal)}（${cellLabel(b.cell)}）${b.notes.length ? `［${b.notes.join('，')}］` : ''}`);
      text = `吞噬連鎖，共 ${bites.length} 口，從牢房 ${cellLabel(first.from)} 開始：${steps.join('；接著')}。${end || `最後成為${describe(last.after)}。`}${stop}`;
    }
    logAt(state, at, 'devour', text, Object.assign({ type: 'devour', from: first.from, bites }, stopped ? { stopped: true } : {}));
  }

  // Whether a chain can be stopped after a bite (the game's Cancel).
  const canStopChain = (state) => (state.params && typeof state.params.chainStop === 'boolean' ? state.params.chainStop : DEFAULT_PARAMS.chainStop);

  function devour(state, from, to) {
    const blocked = guard(state, 'manage');
    if (blocked) return blocked;
    if (state.used.swap > 0 && !state.used.devourAfterSwap) return fail('你今天已經替換過囚犯，一天只能替換或吞噬擇一。請結束這一天。');
    if (!canDevourNow(state)) return fail('今天的吞噬已用掉。結束這一天才能再吞噬。');
    if (from !== state.position) return fail(`只有典獄長所在牢房（${cellLabel(state.position)}）的囚犯可以發起吞噬。`);
    const option = framedMeals(state, devourOptions(state, from)).find((o) => o.cell === to);
    if (!option) return fail('那隻囚犯無法吞噬那個目標。');
    const events = [];
    state.used.devour += 1;
    state.used.mealOnly = null;
    state.chaining = { eater: state.cells[from].inmate.id, at: state.log.length, bites: [] };
    state.chaining.bites.push(doDevour(state, from, option, events));
    goOnChain(state, events);
    return ok(events);
  }

  // The eater's meals while its chain waits for a pick.
  function chainOptions(state) {
    const cell = state.chaining ? boardCellOf(state, state.chaining.eater) : null;
    return cell ? framedMeals(state, devourOptions(state, cell.n)) : [];
  }

  // After each bite the chain goes on while the eater has a meal. Each bite
  // waits for the player's pick of the next meal (chainBite), or for the
  // chain to be stopped (stopChain), as the game's Cancel does. With
  // params.chainStop off, the chain must go on: a single meal is taken at
  // once, and only a choice waits. Every bite raises a tier, so it ends by
  // Rainbow at the latest. The whole chain is logged as one entry, where it
  // began.
  function goOnChain(state, events) {
    const ch = state.chaining;
    const stoppable = canStopChain(state);
    for (let cell = boardCellOf(state, ch.eater); cell; cell = boardCellOf(state, ch.eater)) {
      const options = devourOptions(state, cell.n);
      if (!options.length) break;
      if (options.length > 1 || stoppable) return;
      ch.bites.push(doDevour(state, cell.n, options[0], events, true));
      state.stats.chains += 1;
    }
    state.chaining = null;
    logDevour(state, ch.at, ch.bites);
  }

  // The player's pick of the chain's next meal.
  function chainBite(state, to) {
    if (!state.chaining) return fail('沒有等待選擇獵物的吞噬連鎖。');
    if (state.pending.length) return fail('請先完成待選的選擇。');
    const cell = boardCellOf(state, state.chaining.eater);
    const option = cell ? framedMeals(state, devourOptions(state, cell.n)).find((o) => o.cell === to) : null;
    if (!option) return fail('連鎖無法吃那個獵物。');
    const events = [];
    state.used.mealOnly = null;
    state.chaining.bites.push(doDevour(state, cell.n, option, events, true));
    state.stats.chains += 1;
    goOnChain(state, events);
    return ok(events);
  }

  // The game's Cancel: the chain stops after its last bite. The eater keeps
  // what it gained, its meals stay on the block, and today's consume stays
  // used.
  function stopChain(state) {
    if (!state.chaining) return fail('沒有等待選擇獵物的吞噬連鎖。');
    if (!canStopChain(state)) return fail('在這個實驗室設定下，只要還有獵物，吞噬連鎖就必須繼續。');
    if (state.pending.length) return fail('請先完成待選的選擇。');
    const ch = state.chaining;
    state.chaining = null;
    logDevour(state, ch.at, ch.bites, true);
    return ok([{ type: 'stopchain' }]);
  }

  // Swaps the inmate in the warden's cell; no other cell can be swapped.
  function swap(state, n = state.position) {
    const blocked = guard(state, 'manage');
    if (blocked) return blocked;
    if (n !== state.position) return fail(`只有典獄長所在牢房（${cellLabel(state.position)}）的囚犯可以被替換。`);
    const cell = state.cells[n];
    if (!cell || cell.sealed || !cell.inmate) return fail('典獄長所在的牢房沒有可替換的囚犯。');
    if (state.used.devour > 0) return fail('你今天已經吞噬過，一天只能吞噬或替換擇一。請結束這一天。');
    if (state.used.swap >= state.params.swapsPerDay) return fail('今天沒有剩餘的替換次數。');
    if (state.used.noSwap) return fail('你的遊戲今天沒有提供替換。');
    const weights = (state.params.swapWeights || state.params.tierWeights).slice();
    if (has(state, 'rope')) weights[0] = weights[1] = 0;
    if (!weights.some((w) => w > 0)) return fail('沒有可以骰出的稀有度。請到實驗室調整稀有度權重。');
    const old = cell.inmate;
    const events = [{ type: 'swap', cell: n }];
    const at = state.log.length;
    // Severed Iron Maiden, as its card reads (report 9): the inmate replaced
    // stands level, as many inmates above its rarity as below it, on the
    // block as it is now (before the Scapegoat's Guillotine removes any).
    // The user's recorded Replaces fit it, 20 of 20 (f5, 2026-10-20).
    const others = boardInmates(state).filter((i) => i.id !== old.id);
    const level = has(state, 'maiden') && others.filter((i) => i.tier > old.tier).length === others.filter((i) => i.tier < old.tier).length;
    const aboveOld = others.filter((i) => i.tier > old.tier).length;
    cell.inmate = null;
    checkPrey(state);
    // Scapegoat's Guillotine: with 2 or more others on the block, 2 of them
    // go, and the newcomer comes in above the rarity it replaces (a tier
    // above when the rarity weights reach no higher).
    let above = false;
    if (has(state, 'scapegoat')) {
      const others = boardCells(state);
      if (others.length >= 2) {
        const victims = shuffle(state, others).slice(0, 2);
        const names = victims.map((c) => `${cellLabel(c.n)} 的${describe(c.inmate)}`);
        for (const v of victims) {
          emptyCell(state, v);
          events.push({ type: 'removed', cell: v.n });
        }
        checkPrey(state);
        log(state, 'tool', `替罪人的斷頭台：${names.join('與')}被移除，因此新囚犯的稀有度會高於${TIERS[old.tier]}。`, { type: 'scapegoat', cell: n, removed: victims.map((c) => c.n) });
        above = true;
      }
    }
    const higher = weights.map((w, t) => (t > old.tier ? w : 0));
    const fresh = rollInmate(state, above && higher.some((w) => w > 0) ? higher : weights);
    if (above && fresh.tier <= old.tier) fresh.tier = Math.min(RAINBOW, old.tier + 1);
    // Burning Stake: replacing an inmate below Legendary may bring in a
    // Legendary.
    const staked = has(state, 'stake') && old.tier < 3 && rand(state) < 0.4 && fresh.tier !== 3;
    if (staked) fresh.tier = 3;
    if (state.params.swapNewBeast && fresh.beast === old.beast) {
      const others = BEASTS.filter((b) => b !== old.beast);
      fresh.beast = others[pickIndex(state, others.map((b) => state.params.beastWeights[BEASTS.indexOf(b)]))];
    }
    if (has(state, 'pestle')) fresh.beast = old.beast;
    cell.inmate = fresh;
    state.used.swap += 1;
    state.stats.swaps += 1;
    logAt(state, at, 'swap', `替換了牢房 ${cellLabel(n)} 的${describe(old)}，換來一隻${describe(fresh)}。`, { type: 'swap', cell: n, old: snap(old), fresh: snap(fresh) });
    if (staked) log(state, 'tool', `火刑柱：牢房 ${cellLabel(n)} 的${describe(fresh)}以傳奇進場。`, { type: 'stake', cell: n });
    // Severed Iron Maiden: the inmate replaced stood level, so the newcomer gains 3 tiers.
    if (level) {
      log(state, 'tool', `切開的人形棺：被替換的${describe(old)}${aboveOld ? `上方有 ${plural(aboveOld, '隻囚犯')}，下方也一樣多` : '上下都沒有其他囚犯'}，因此牢房 ${cellLabel(n)} 的${describe(fresh)}升 3 階。`, { type: 'maiden', cell: n });
      promote(state, fresh, 3, false, events);
    }
    afterGrowth(state, fresh, events);
    if (has(state, 'axe') && fresh.tier > old.tier) {
      const doors = shuffle(state, state.cells.filter((c) => c.sealed)).slice(0, 2);
      if (doors.length) {
        log(state, 'tool', `獄卒的行刑巨斧：這次替換提高了稀有度，因此${doors.length === 1 ? `牢房 ${cellLabel(doors[0].n)} 開啟` : `牢房 ${doors.map((c) => cellLabel(c.n)).join('與')} 開啟`}。`);
        for (const c of doors) openCell(state, c, 'side', events);
      }
    }
    if (has(state, 'scales') && rand(state) < 0.8) scout(state);
    if (cell.ivory && boardCellOf(state, fresh.id)) {
      const pool = boardInmates(state).filter((i) => state.params.ivoryIncludesSwapped || i.id !== fresh.id);
      const picks = shuffle(state, pool).slice(0, state.params.ivoryCount);
      if (picks.length) {
        log(state, 'ivory', `象牙：${plural(picks.length, '隻囚犯')}各升一階（牢房 ${picks.map((i) => cellLabel(cellOf(state, i.id).n)).join('、')}）。`, { type: 'ivory', count: picks.length });
        for (const i of picks) if (boardCellOf(state, i.id)) promote(state, i, 1, false, events);
      }
    }
    return ok(events);
  }

  // Warden's Scales: the highest-rarity inmate behind the locked doors is
  // shown, beast and rarity, while its door stays locked.
  function scout(state) {
    const doors = state.cells.filter((c) => c.sealed && !c.nest);
    if (!doors.length) return;
    for (const c of doors) hiddenOf(state, c);
    const top = Math.max(...doors.map((c) => c.hidden.tier));
    const cell = pickOne(state, doors.filter((c) => c.hidden.tier === top));
    cell.known = 2;
    log(state, 'tool', `典獄官的天平：牢房 ${cellLabel(cell.n)} 裡是一隻${describe(cell.hidden)}，是上鎖牢門後最好的囚犯。`);
  }

  function endDay(state) {
    const blocked = guard(state, 'manage');
    if (blocked) return blocked;
    const events = [];
    advanceDay(state, events);
    return ok(events);
  }

  function advanceDay(state, events) {
    if (state.day >= state.maxDays) {
      finish(state, false);
      events.push({ type: 'end' });
      return;
    }
    state.day += 1;
    log(state, 'day', `第 ${state.day} 天，共 ${state.maxDays} 天。`);
    beginDay(state, events);
    events.push({ type: 'day' });
  }

  function finish(state, early) {
    state.phase = 'ended';
    state.destinations = [];
    state.event = null;
    state.chain = false;
    const roster = rosterOf(state);
    state.result = {
      day: state.day,
      early: !!early,
      roster,
      cache: state.cache,
      best: Math.max(state.stats.best, ...roster.rows.map((r) => r.tier), 0),
      stats: Object.assign({}, state.stats),
    };
    log(state, 'end', early ? '這一局提前結束。交接名冊已備妥。' : '這一局結束了。交接名冊已備妥。');
  }

  function endRun(state) {
    if (state.phase === 'ended') return fail('這一局已經結束了。');
    state.pending = [];
    if (state.chaining) {
      logDevour(state, state.chaining.at, state.chaining.bites);
      state.chaining = null;
    }
    finish(state, true);
    return ok([{ type: 'end' }]);
  }

  // ---------- Choices: instruments and gifts ----------

  function choose(state, id) {
    const choice = state.pending[0];
    if (!choice) return fail('現在沒有需要選擇的東西。');
    if (!choice.options.includes(id)) return fail('那個選項不在提供範圍內。');
    state.pending.shift();
    const events = [{ type: 'tool' }];
    if (choice.kind === 'gift') applyGift(state, id, events);
    else {
      state.tools.push(id);
      log(state, 'tool', `取得了${TOOLS[id].name}。`, { type: 'tool', id });
      if (state.phase === 'patrol') fitDestinations(state);
    }
    // A gift can remove the inmate a waiting event needs (the Brass Horn's
    // bites); the event is then lost.
    if (state.phase === 'event' && state.event && !state.cells[state.event.cell].inmate) {
      log(state, 'event', `牢房 ${cellLabel(state.event.cell)} 的${eventName(state.event.kind)}失效了：那裡已經沒有囚犯。`);
      state.event = null;
      state.phase = 'manage';
    }
    return ok(events);
  }

  // A pet can re-roll an instrument offer ("Re-roll, Remaining attempts N"
  // in the game): 3 other instruments take the place of the ones shown. The
  // simulator's own runs have no pet; the analyzer sets the attempts left.
  function canReroll(state) {
    const choice = state.pending[0];
    return !!choice && choice.kind === 'tool' && choice.rerolls > 0;
  }

  function rerollOffer(state) {
    if (!canReroll(state)) return fail('這次選擇已經沒有重骰次數了。');
    const choice = state.pending[0];
    let pool = TOOL_IDS.filter((t) => !has(state, t) && !choice.options.includes(t));
    if (pool.length < 3) pool = TOOL_IDS.filter((t) => !has(state, t));
    choice.options = drawTools(state, state, pool, 3);
    choice.rerolls -= 1;
    log(state, 'tool', `重骰了選項：${choice.options.map((t) => TOOLS[t].name).join('、')}。`, { type: 'reroll' });
    return ok([]);
  }

  function applyGift(state, id, events) {
    log(state, 'tool', `典獄長的珍藏：${GIFTS[id].name}。`, { type: 'gift', id });
    if (id === 'ring') {
      for (const c of shuffle(state, state.cells.filter((x) => x.sealed)).slice(0, 3)) openCell(state, c, 'side', events);
    } else if (id === 'horn') {
      for (const inmateId of boardInmates(state).filter((i) => devourOptions(state, cellOf(state, i.id).n).length).map((i) => i.id)) {
        const cell = boardCellOf(state, inmateId);
        if (!cell) continue;
        const options = devourOptions(state, cell.n).filter((o) => !o.scratch);
        if (!options.length) continue;
        const at = state.log.length;
        logDevour(state, at, [doDevour(state, cell.n, pickOne(state, options), events)]);
      }
    } else if (id === 'wine') {
      for (const i of boardInmates(state).filter((x) => x.tier < 3)) if (boardCellOf(state, i.id)) promote(state, i, 1, false, events);
    } else if (id === 'brand') {
      const hungry = shuffle(state, boardInmates(state).filter((i) => !devourOptions(state, cellOf(state, i.id).n).length)).slice(0, 4);
      for (const i of hungry) {
        const cell = boardCellOf(state, i.id);
        if (!cell || devourOptions(state, cell.n).length) continue;
        const possible = BEASTS.filter((b) => boardInmates(state).some((o) => canEat(state, { id: i.id, beast: b, tier: i.tier }, o)));
        if (possible.length) {
          i.beast = pickOne(state, possible);
          log(state, 'tool', `原罪烙印：牢房 ${cellLabel(cell.n)} 現在是一隻${describe(i)}。`);
        }
      }
      checkPrey(state);
    }
  }

  // ---------- Lab ----------

  function labCheck(state) {
    if (state.phase === 'ended') return fail('這一局已經結束了。');
    if (state.phase === 'event' || state.phase === 'office' || state.pending.length || state.chaining) return fail('請先完成目前的決定。');
    return null;
  }

  function editCell(state, n, spec) {
    const blocked = labCheck(state);
    if (blocked) return blocked;
    const cell = state.cells[n];
    if (!cell) return fail('請選一間要編輯的牢房。');
    if (n === OFFICE) return fail('牢房 01 是審訊室，不能放任何東西。');
    Object.assign(cell, blankCell(n));
    const beast = BEASTS.includes(spec.beast) ? spec.beast : 'mammoth';
    const tier = clamp(Math.round(Number(spec.tier)) || 0, 0, RAINBOW - 1);
    const event = EVENTS[spec.event] ? spec.event : null;
    let what;
    if (spec.kind === 'open') {
      cell.sealed = false;
      cell.inmate = makeInmate(state, beast, tier);
      cell.ivory = !!spec.ivory;
      state.stats.best = Math.max(state.stats.best, tier);
      what = `有一隻${describe(cell.inmate)}的開啟牢房${cell.ivory ? '（帶象牙）' : ''}`;
    } else if (spec.kind === 'empty') {
      cell.sealed = false;
      what = '一間空的開啟牢房';
    } else if (spec.kind === 'nest') {
      cell.nest = { due: state.day + state.params.nestDays };
      what = `一個將在第 ${cell.nest.due} 天孵化的鼠巢`;
    } else if (spec.kind === 'hidden') {
      cell.hidden = makeInmate(state, beast, tier);
      cell.scratch = !!spec.scratch;
      cell.known = cell.scratch ? 1 : 0;
      cell.event = event;
      what = `一扇藏著${describe(cell.hidden)}的上鎖牢門${cell.scratch ? '（有劃痕）' : ''}`;
    } else {
      cell.event = event;
      what = '一扇裡面未知的上鎖牢門';
    }
    if (event && cell.sealed && !cell.nest) what += `，附帶獄中事變「${eventName(event)}」`;
    // An event placed by hand shows at once.
    cell.seen = !!cell.event;
    checkPrey(state);
    log(state, 'lab', `場景編輯器：牢房 ${cellLabel(n)} 現在是${what}。`);
    return ok([]);
  }

  // The Blood-Stained Trap's Hunt: the Lion in the warden's cell puts a Prey
  // mark on an inmate it can consume. It's the day's action.
  function hunt(state, to) {
    const blocked = guard(state, 'manage');
    if (blocked) return blocked;
    if (!has(state, 'trap')) return fail('只有染紅的捕獸夾才能尋獵。');
    if (state.used.devour > 0 || state.used.swap > 0 || state.used.hunt) return fail('一天只能吞噬、替換或尋獵擇一。請結束這一天。');
    if (state.used.noHunt) return fail('你的遊戲今天沒有提供尋獵。');
    if (!huntTargets(state).includes(to)) return fail('尋獵只能標記典獄長牢房裡的狂獅能吞噬的囚犯，而且兩者都還沒有獵物標記。');
    const lion = state.cells[state.position].inmate;
    const prey = state.cells[to].inmate;
    state.used.hunt = 1;
    state.prey.push({ lion: lion.id, prey: prey.id, preyBeast: prey.beast, rounds: state.params.preyRounds, next: state.day + 1 });
    log(state, 'tool', `染紅的捕獸夾，尋獵：牢房 ${cellLabel(state.position)} 的${describe(lion)}對牢房 ${cellLabel(to)} 的${describe(prey)}加上獵物標記。之後每天早上兩者各升一階，持續 ${plural(state.params.preyRounds, '個早上')}。`, { type: 'trap', cell: to });
    return ok([]);
  }

  function markPrey(state, lionCell, targetCell) {
    const blocked = labCheck(state);
    if (blocked) return blocked;
    const a = state.cells[lionCell];
    const b = state.cells[targetCell];
    if (!a || a.sealed || !a.inmate || a.inmate.beast !== 'lion') return fail('請選一間有狂獅的開啟牢房。');
    if (!b || b.sealed || !b.inmate || !canEat(state, a.inmate, b.inmate)) return fail('獵物必須是狂獅能吃的同稀有度囚犯。');
    if (linkOf(state, a.inmate.id) || linkOf(state, b.inmate.id)) return fail('其中一方已經有獵物標記了。');
    state.prey.push({ lion: a.inmate.id, prey: b.inmate.id, preyBeast: b.inmate.beast, rounds: state.params.preyRounds, next: state.day + 1 });
    log(state, 'lab', `場景編輯器：牢房 ${cellLabel(lionCell)} 的狂獅把牢房 ${cellLabel(targetCell)} 的${describe(b.inmate)}標記為獵物。`);
    return ok([]);
  }

  function moveWarden(state, n) {
    const blocked = labCheck(state);
    if (blocked) return blocked;
    if (n < 0 || n >= CELL_COUNT) return fail('請選一間牢房。');
    state.position = n;
    // Destinations always come from the cells ahead of the warden.
    if (state.phase === 'patrol') rollDestinations(state);
    log(state, 'lab', `場景編輯器：典獄長現在${n === OFFICE ? '在審訊室' : `在牢房 ${cellLabel(n)}`}。`);
    return ok([]);
  }

  function addTool(state, id) {
    const blocked = labCheck(state);
    if (blocked) return blocked;
    if (!TOOLS[id]) return fail('未知的刑具。');
    if (has(state, id)) return fail('你已經持有那件刑具。');
    state.tools.push(id);
    log(state, 'lab', `場景編輯器：加入了${TOOLS[id].name}。`);
    return ok([]);
  }

  function removeTool(state, id) {
    const blocked = labCheck(state);
    if (blocked) return blocked;
    if (!has(state, id)) return fail('你沒有持有那件刑具。');
    state.tools = state.tools.filter((t) => t !== id);
    log(state, 'lab', `場景編輯器：移除了${TOOLS[id].name}。`);
    return ok([]);
  }

  // ---------- Advisor ----------

  function choiceScore(state, id) {
    const board = boardInmates(state);
    const small = board.length <= 4;
    switch (id) {
      case 'muzzle': return small ? 30 : 8;
      case 'skewer': return board.filter((i) => i.beast === 'rat').length * 8;
      case 'crown': return 12 + board.filter((i) => i.beast === 'lion').length * 6;
      case 'maul': return 12 + board.filter((i) => i.beast === 'mammoth').length * 6;
      case 'ironbox': return state.maxDays - state.day >= state.params.nestDays ? 18 : 0;
      case 'keys':
      case 'ring': return (board.length < 4 ? 20 : 5) - (has(state, 'muzzle') && small ? 12 : 0);
      case 'revenge': return 14;
      case 'saw': return 12;
      case 'rope': return 10;
      case 'fire': return board.length < 6 ? 14 : 8;
      case 'hook': return 12;
      case 'pestle': return 4;
      case 'scales': return 6;
      case 'tongs': return board.some((i) => i.beast === 'mammoth') ? 8 : 3;
      case 'guillotine': return board.filter((i) => i.beast === 'wolf').length * 6;
      case 'claws': return 6 + board.filter((i) => i.beast === 'wolf').length * 5;
      case 'trap': return 4 + board.filter((i) => i.beast === 'lion').length * 6;
      case 'axe': return 10;
      case 'shackles': return 8;
      case 'collar': return 10;
      case 'forged': return 6;
      case 'dogtag': return 12;
      case 'cage': return 12;
      case 'blacklist': return state.cells.filter((c) => c.sealed).length <= 7 ? 16 : 8;
      case 'shortchain': return 10;
      case 'maiden': return 10;
      case 'whip': return 8;
      case 'ravenous': return 8;
      case 'scapegoat': return board.length >= 3 ? 10 : 4;
      case 'stake': return 10;
      case 'coin': return 10;
      case 'wine': return board.filter((i) => i.tier < 3).length * 4;
      case 'horn': return board.filter((i) => devourOptions(state, cellOf(state, i.id).n).length).length * 6;
      case 'brand': return board.filter((i) => !devourOptions(state, cellOf(state, i.id).n).length).length * 5;
      default: return 0;
    }
  }

  // Scores one devour for the advisor, with a full and a short description.
  function devourTip(state, from, option, kind) {
    const eater = state.cells[from].inmate;
    const t = eater.tier;
    const { gain } = gainFor(state, from, option);
    const to = Math.min(RAINBOW, t + gain);
    const step = WORTH[Math.min(RAINBOW, t + 1)] - WORTH[t];
    let score = WORTH[to] - 2 * WORTH[t] + (to === RAINBOW ? 200 : 0);
    const notes = [];
    const own = linkOf(state, eater.id);
    if (own) {
      score -= own.rounds * step * 1.5;
      notes.push('若野獸改變會結束牠的獵物標記');
    }
    const meal = state.cells[option.cell];
    const theirs = !meal.sealed ? linkOf(state, meal.inmate.id) : null;
    if (theirs && theirs !== own) {
      score -= theirs.rounds * step;
      notes.push('會結束一個獵物標記');
    }
    const target = meal.sealed ? '有劃痕門後的囚犯' : beastName(meal.inmate.beast);
    const short = `${cellLabel(option.cell)} 的${target}，升到${TIERS[to]}`;
    return {
      kind,
      from,
      to: option.cell,
      score,
      short,
      text: `${cellLabel(from)} 的${beastName(eater.beast)}吃掉 ${cellLabel(option.cell)} 的${target}：${TIERS[to]}${gain > 1 ? `（+${gain}）` : ''}${to === RAINBOW ? '，成為綺彩' : ''}${notes.length ? `；${notes.join('，')}` : ''}。`,
    };
  }

  // Ranks the moves available right now using visible information only.
  function advise(state) {
    if (state.phase === 'ended') return [];
    const tips = [];
    const board = boardInmates(state);
    const counts = TIERS.map((_, t) => board.filter((i) => i.tier === t).length);
    const choice = state.pending[0];
    if (choice) {
      return choice.options
        .map((id) => ({ kind: 'choose', id, score: choiceScore(state, id), text: `${toolName(id)}：${toolText(id)}` }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    }
    if (state.chaining) {
      const from = boardCellOf(state, state.chaining.eater).n;
      const tips = chainOptions(state).map((o) => devourTip(state, from, o, 'chain')).sort((a, b) => b.score - a.score).slice(0, 3);
      if (canStopChain(state)) tips.push({ kind: 'stopchain', from, score: 0, text: '停止連鎖（取消）：吞噬者保留已獲得的升階，牠的獵物留在監區上。' });
      return tips;
    }
    if (state.phase === 'office') {
      const pool = board.filter((i) => i.tier < RAINBOW);
      const raise = pool.reduce((sum, i) => sum + WORTH[Math.min(RAINBOW, i.tier + 1)] - WORTH[i.tier], 0) / Math.max(1, pool.length);
      return [
        { kind: 'office', choice: 'bestow', score: raise, text: '賞賜：監區上隨機 1 隻囚犯升一階。' },
        { kind: 'office', choice: 'instigate', score: 12, text: `煽動：在隨機一間牢房（上鎖牢門或囚犯的牢房）出現 ${plural(instigateCount(state), '個獄中事變')}。` },
      ].sort((a, b) => b.score - a.score);
    }
    if (state.phase === 'event' && state.event) {
      if (state.event.kind === 'execution') {
        const victims = executionVictims(state, state.event.cell);
        return [{ kind: 'event', accept: victims.length > 0, text: victims.length ? `接受：處刑者移除 ${plural(victims.length, '隻囚犯')}並升 ${victims.length} 階。` : '略過：這隻囚犯沒有可以處決的對象。' }];
      }
      if (state.event.kind === 'trickster') {
        const who = state.cells[state.event.cell].inmate;
        const gains = who && who.tier < SUPREME;
        return [{ kind: 'event', accept: !!gains, text: gains ? `接受：${describe(who)}變成至臻。` : '略過：牠已經是至臻，只有野獸會改變。' }];
      }
      if (state.event.kind === 'appetite') return [{ kind: 'event', accept: true, text: `接受：一隻最低稀有度的囚犯獲得 ${APPETITE_TRIES} 次 +1 階的機會。` }];
      if (state.event.kind === 'convict') return [{ kind: 'event', accept: true, text: '接受：一間上鎖的牢房開啟，裡面是傳奇以上的囚犯。' }];
      if (state.event.kind === 'crow') return [{ kind: 'event', accept: true, text: `接受：顯示接下來 ${CROW_CELLS} 間上鎖牢房裡的稀有度。` }];
      if (state.event.kind === 'freedom') return [{ kind: 'event', accept: true, text: `接受：隨機開啟 ${FREEDOM_CELLS} 間上鎖的牢房。` }];
      if (state.event.kind === 'portion') return [{ kind: 'event', accept: true, text: `接受：最多 ${PORTION_INMATES} 隻隨機囚犯升一階。` }];
      if (USURP[state.event.kind]) {
        const u = USURP[state.event.kind];
        return [{ kind: 'event', accept: true, text: `接受：${u.count === 'all' ? '所有囚犯' : u.count === 1 ? '隨機一隻囚犯' : `隨機 ${u.count} 隻囚犯`}升${u.by === 1 ? '一階' : ` ${u.by} 階`}。` }];
      }
      if (state.event.kind === 'ratway') return [{ kind: 'event', accept: true, text: '接受：移動到審訊室以外的任何牢房，若上鎖就打開它。' }];
      const keepSmall = has(state, 'muzzle') && board.length <= 4;
      return [{ kind: 'event', accept: !keepSmall, text: keepSmall ? '略過：連鎖會讓監區擠滿囚犯，使痛苦口籠失效。' : '接受：下一次巡視會打開前往目的地沿途所有未開啟的牢房。' }];
    }
    if (state.phase === 'patrol') {
      for (const n of patrolOptions(state)) {
        const c = state.cells[n];
        let score;
        let why;
        if (!c.sealed && c.inmate) {
          // Walking to a known inmate makes it the one that devours today.
          const best = devourOptions(state, n).map((o) => devourTip(state, n, o, 'devour')).sort((a, b) => b.score - a.score)[0];
          score = best ? 10 + best.score : has(state, 'muzzle') && board.length <= 4 ? 8 : 2;
          why = best ? `牠的${describe(c.inmate)}接著可以吞噬（${best.short}）` : `牠的${describe(c.inmate)}在那裡沒有目標`;
        } else if (!c.sealed) {
          score = 1;
          why = n === OFFICE ? '煽動或賞賜' : '一間空牢房';
        } else if (c.nest) {
          score = -40;
          why = `會摧毀預定第 ${c.nest.due} 天孵化的鼠巢`;
        } else if (c.known && c.hidden) {
          const t = c.hidden.tier;
          score = 12 + WORTH[t] + counts[t] * 6;
          why = `裡面是${c.known === 2 ? describe(c.hidden) : `${TIERS[t]}囚犯`}${counts[t] ? `，可與監區上 ${counts[t]} 隻${TIERS[t]}配對` : ''}`;
        } else {
          score = 9;
          why = '裡面未知';
        }
        if (c.sealed && c.event && c.seen) {
          score += 6;
          why += '；那裡有一個獄中事變';
        }
        if (state.chain) {
          const opens = clockwisePath(state, n).filter((k) => state.cells[k].sealed).length;
          score += opens * 3;
          why += `；連鎖沿途會打開 ${plural(opens, '扇門')}`;
        }
        tips.push({ kind: 'patrol', cell: n, score, text: `前往${n === OFFICE ? '審訊室' : `牢房 ${cellLabel(n)}`}：${why}。` });
      }
      tips.sort((a, b) => b.score - a.score);
      return tips.slice(0, 3);
    }
    // Only the inmate in the warden's cell can start the day's devour.
    for (const option of startOptions(state)) tips.push(devourTip(state, state.position, option, 'devour'));
    // Only the warden's cell can be swapped.
    const here = state.cells[state.position];
    if (canSwapNow(state) && here.ivory && !here.sealed && here.inmate) {
      tips.push({ kind: 'swap', cell: here.n, score: 20 + Math.min(board.length, state.params.ivoryCount) * 6, text: `替換象牙牢房 ${cellLabel(here.n)} 的囚犯：最多 ${plural(state.params.ivoryCount, '隻囚犯')}各升一階。` });
    }
    tips.sort((a, b) => b.score - a.score);
    const out = tips.filter((t) => t.score > 0).slice(0, 4);
    if (!out.length) {
      const waits = [];
      if (state.prey.length) waits.push('獵物標記成長');
      if (state.cells.some((c) => c.nest)) waits.push('鼠巢孵化');
      out.push({ kind: 'end', text: `監區上目前沒有值得做的事。結束這一天${waits.length ? `，讓${waits.join('、')}` : ''}。` });
    }
    return out;
  }

  // ---------- Saves ----------

  function serialize(state) {
    return JSON.stringify(state);
  }

  function deserialize(input) {
    let data;
    try {
      data = JSON.parse(typeof input === 'string' ? input : JSON.stringify(input));
    } catch (e) {
      throw new Error('這不是有效的存檔資料，無法讀取 JSON。');
    }
    if (data && data.app === 'tartarus-sim') data = data.state;
    const valid = data && data.v === VERSION && Array.isArray(data.cells) && data.cells.length === CELL_COUNT && Array.isArray(data.log) && typeof data.day === 'number';
    if (!valid) throw new Error('這個存檔不是來自這個版本的模擬器。');
    // The contract challenge is gone (it isn't in the live game).
    if (data.mode === 'challenge') throw new Error('這個存檔是契約挑戰，模擬器已不再提供這個模式。請開始新的一局。');
    data.mode = 'drill';
    delete data.challenge;
    delete data.loadout;
    data.params = normalizeParams(data.params);
    data.prey = Array.isArray(data.prey) ? data.prey : [];
    data.vault = Array.isArray(data.vault) ? data.vault : [];
    data.tools = Array.isArray(data.tools) ? data.tools.filter((t) => TOOLS[t]) : [];
    data.pending = Array.isArray(data.pending) ? data.pending : [];
    data.destinations = Array.isArray(data.destinations) ? data.destinations : [];
    data.used = Object.assign(freshDay(), data.used || {});
    data.stats = Object.assign({ patrols: 0, opened: 0, devours: 0, chains: 0, swaps: 0, executions: 0, best: 0 }, data.stats || {});
    data.rng = Number(data.rng) >>> 0;
    data.cache = Number(data.cache) || 0;
    data.position = clamp(Number(data.position) || 0, 0, CELL_COUNT - 1);
    // Saves from before objectives played for King of the Caged.
    // Cage Fight was briefly an objective.
    if (data.objective && data.objective.id === 'cagefight') {
      data.startEvent = 'cagefight';
      data.objective = { id: 'other', progress: 0 };
    }
    data.startEvent = START_EVENTS[data.startEvent] ? data.startEvent : null;
    const goal = data.objective && OBJECTIVES[data.objective.id] ? data.objective : { id: 'king', progress: 0 };
    data.objective = { id: goal.id, progress: clamp(Number(goal.progress) || 0, 0, 99) };
    data.milestone = !!data.milestone;
    const ch = data.chaining;
    data.chaining = ch && Array.isArray(ch.bites) && ch.bites.length && boardCellOf(data, ch.eater) ? { eater: ch.eater, at: clamp(Number(ch.at) || 0, 0, data.log.length), bites: ch.bites } : null;
    // Saves from before events hid until passed showed every event.
    // Events show as they appear, so an event a save kept hidden (from
    // before that rule) shows now.
    for (const c of data.cells) if (c.seen === undefined || c.event) c.seen = true;
    data.eventPool = Array.isArray(data.eventPool) && data.eventPool.length ? data.eventPool.filter((id) => EVENTS[id]) : EVENT_POOL.slice();
    data.ratway = !!data.ratway && data.phase === 'patrol';
    delete data.chainConsume;
    return data;
  }

  // Wraps a public action so the log stays bounded whatever happened inside.
  const bounded = (fn) => (state, ...args) => {
    const result = fn(state, ...args);
    trimLog(state);
    return result;
  };
  // A move (Consume, Replace, Hunt, a special event's choice) has its own
  // chance of a new special event on a random locked door, once it's made:
  // a Consume once its chain is over, however it ends (played on to the end,
  // or stopped with Cancel), so a chain counts once.
  const acted = (fn) => (state, ...args) => {
    const result = fn(state, ...args);
    if (result && result.ok && !state.chaining) spawnEvent(state, state.params.eventActionChance);
    return result;
  };
  // A special event the warden set off, taken or skipped, may be followed
  // by a new one (followEvent); a Usurpation taken places its next card
  // instead.
  const followed = (fn) => (state, accept, ...args) => {
    const kind = state.phase === 'event' && state.event ? state.event.kind : null;
    const result = fn(state, accept, ...args);
    if (kind && result && result.ok && !(accept && USURP[kind] && USURP[kind].next)) followEvent(state, state.params.eventFollowChance);
    return result;
  };

  const api = {
    VERSION, CELL_COUNT, OFFICE, SUPREME, RAINBOW, VAULT_SLOTS, TIERS, BEASTS, BEAST_INFO, FOOD_CHAIN, SECOND_MEAL, TOOLS, TOOL_IDS, BEAST_TOOLS, toolWeight, GIFTS, GIFT_IDS,
    EVENTS, EVENT_IDS, EVENT_POOL, USURP, PORTION_INMATES, APPETITE_TRIES, APPETITE_ODDS, INSTIGATE_EVENTS, INSTIGATE_EVENTS_EMPTY, instigateCells, instigateCount, CROW_CELLS, HUNT_BELOW, FREEDOM_CELLS, OBJECTIVES, OBJECTIVE_IDS, START_EVENTS,
    SCENARIOS, DEFAULT_PARAMS, PARAM_FIELDS,
    newGame, randomSeed, normalizeParams, serialize, deserialize,
    patrol: bounded(patrol),
    resolveEvent: bounded(acted(followed(resolveEvent))),
    devour: bounded(acted(devour)),
    chainBite: bounded(acted(chainBite)),
    stopChain: bounded(acted(stopChain)),
    officeAct: bounded(officeAct),
    swap: bounded(acted(swap)),
    hunt: bounded(acted(hunt)),
    endDay: bounded(endDay),
    endRun: bounded(endRun),
    choose: bounded(choose),
    rerollOffer: bounded(rerollOffer),
    editCell: bounded(editCell),
    markPrey: bounded(markPrey),
    moveWarden: bounded(moveWarden),
    addTool: bounded(addTool),
    removeTool: bounded(removeTool),
    patrolOptions, clockwisePath, devourOptions, startOptions, chainOptions, canStopChain, cageFight, gainFor, executionVictims, canEat, eatsOf, canDevourNow, canSwapNow, canHuntNow, huntTargets, canReroll,
    linkOf, cellOf, boardInmates, rosterOf, advise, limits,
    toolText, toolName, toolNameEn, eventName, describe, tierName, beastName, cellLabel, plural, stepsBetween, scarceBeasts, lowestInmates,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.Tartarus = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Short notes on playing the run's instruments, the pairs of them the lab
   found worth more or less together, and the start-of-run card ("contract").
   The user, 2026-10-22: "a small snippet on the strategy of how to play the
   specific instrument that the person gets ... the same when they have a
   specific 2 instrument combination ... playing around any special
   contracts pre-game". Pair numbers are from tools/results/tool-combos.json:
   Rainbows a run held together, and what they make beyond their separate
   gains. */
(function (root) {
  const TOOL_NOTES = {
    revenge: '能吞噬就吞噬：30%的吞噬會打開一間未開啟的牢房，裡面是吞噬者新稀有度的獵物，讓連鎖能繼續下去。',
    muzzle: '讓監區保持稀疏：監區上的囚犯（含被吃的獵物）在4隻以下時吞噬，額外+2階。先靠吞噬把監區吃空，再大量開門。',
    saw: '每天能吞噬就吞噬：25%的吞噬會多升一階。',
    keys: '巡視到兩側都是未開啟牢房的門：有80%機率兩側也會免費打開。',
    rope: '放心替換：替換絕不會出普通或魔法，所以替換掉普通或魔法囚犯一定是升級。',
    fire: '多開門：有35%機率門後的囚犯會複製到另一間未開啟的牢房，一扇門可能帶來兩隻囚犯。',
    ironbox: '每天早上鼠巢會佔走一間未開啟的牢房，2天後孵出稀有碩鼠。碩鼠吃巨象，所以留著稀有巨象給牠們吃。單獨持有時，實測表現比沒有刑具還差：趁鼠巢還沒佔滿前早點開門。',
    skewer: '碩鼠可以吃同稀有度的碩鼠，每一口額外+1階：有另一隻同稀有度的碩鼠時，讓典獄長走到碩鼠的牢房。',
    hook: '放心開門：門後絕不會是普通囚犯。',
    pestle: '替換會保留野獸種類，只重骰稀有度：替換那些你想保留野獸種類的低階囚犯。',
    scales: '替換後有80%機率顯示未開啟牢房中最好的囚犯：早點替換，再朝顯示出的牢房巡視。',
    tongs: '每天早上會有一隻巨象獲得象牙標記，替換象牙牢房裡的囚犯會讓4隻囚犯升一階：留著巨象，等監區上滿是值得升階的囚犯時再替換被標記的那隻。',
    guillotine: '頭狼也能吃稀有度比自己低的碩鼠：高階的頭狼可以靠周圍的低階碩鼠往上爬。',
    axe: '替換後稀有度變高時會打開2間未開啟的牢房：早點替換普通囚犯換免費開門。單獨持有時，實測表現比沒有刑具還差。',
    shackles: '走遠一點：巡視4格以上時，有40%機率讓隨機一隻囚犯升一階，選項差不多時選遠的門。',
    collar: '連鎖划算：第一口之後的每一口都有80%機率+1階。等下一個稀有度都有獵物等著時再吞噬，讓連鎖接得下去。',
    forged: '每天早上少一個目的地，但打開的門有50%機率再打開另一間未開啟的牢房：優先選擇開門，而不是去找已知的囚犯。單獨持有時，實測表現比沒有刑具還差。',
    dogtag: '多開門：有25%機率門後的囚犯出來時高一階。',
    cage: '多吞噬：有40%機率被吃掉的囚犯牢房立刻補上新囚犯，吞噬不會讓監區變空。',
    blacklist: '當未開啟的牢房剩5間以下時，巡視每打開一扇門就會讓隨機2隻囚犯升階：早點開門達到這個條件，之後繼續開。',
    shortchain: 'Walk short: a patrol of 3 cells or fewer has 50% to open a random locked cell, so take the near door when the choice is close. Alone it measured about even with no instrument.',
    maiden: '替換一隻「居中」的囚犯（稀有度比牠高和比牠低的囚犯數量相同；監區只剩一隻時必定居中）：新囚犯會高3階。建議會告訴你哪次替換能拿到+3。',
    whip: '每天早上少一個目的地，但吞噬的每一口都有35%機率+1階：每天吞噬，多做連鎖。',
    ravenous: '每天早上，你最高階的囚犯會移除兩側的囚犯，每移除一隻有40%機率+1階：在最好的囚犯旁邊放便宜的囚犯或空牢房。',
    scapegoat: '監區上還有2隻以上其他囚犯時替換，會隨機移除其中2隻，新囚犯的稀有度高於被替換者。只在其他囚犯都不值錢時替換：剛好只有2隻時，兩隻都會被移除。',
    stake: '每天早上少一個目的地，但替換傳奇以下的囚犯有40%機率換出傳奇：多替換普通和魔法囚犯。',
    coin: '每天早上，野獸種類和稀有度都相同的兩隻囚犯有60%機率合併：一隻消失，另一隻+2階。在監區上保留成對的囚犯。',
    crown: '狂獅可以吃任何同稀有度的囚犯，每一口額外+2階：讓典獄長走到周圍有同稀有度囚犯的狂獅那裡。',
    maul: '巨象也能吃稀有度更高的狂獅和頭狼，吃完會比獵物高2階：巨象越級吞噬是大幅跳階的機會。',
    claws: '每天會有一間未開啟的牢房出現劃痕並顯示稀有度，同稀有度的頭狼可以隔著門吃掉裡面的囚犯，+3階：讓頭狼維持在劃痕門顯示的稀有度。',
    trap: '典獄長站在狂獅的牢房時，尋獵會標記牠的一個獵物，之後3個早上兩者每天各升一階。早點對能往上爬的組合尋獵；最後3天效益遞減，最後一天毫無效果。每天只能在吞噬、替換、尋獵中擇一。',
  };

  // Pairs worth noting: the strongest together and the worst clashes. Measured
  // again with runs starting with 4 inmates out and the other live-data
  // rules (2026-10-22).
  const PAIR_NOTES = {
    'maiden|rope': 'Every Replace brings Rare or better, and an inmate alone on the block stands level: replace your only inmate and it comes back 3 tiers up. Keep the block thin: a run starts with 4 inmates out, so let consumes clear it first. One of the best pairs measured (5.37 Rainbows a run, +1.81 beyond the two apart).',
    'ironbox|skewer': 'The nests hatch Rare Rats, and Rats eat Rats of their rarity: hatched Rats feed each other (4.54, +2.75 beyond the two apart).',
    'coin|ironbox': 'Hatched Rare Rats come in matching pairs for the Coin to merge: leave them be (4.51, +2.07 beyond the two apart).',
    'maiden|scapegoat': 'Replace only an inmate that stands level, counted before the Scapegoat removes 2: the new one gets +3. A Replace that isn\'t level just throws inmates away (4.95, +1.65 beyond the two apart).',
    'crown|keys': 'The Keys\' extra doors fill the block with same-rarity meals for your Lions (4.58, +0.89 beyond the two apart).',
    'blacklist|keys': 'The Keys take you down to 5 locked cells fast, where every opened door raises 2 inmates (3.38, +0.84 beyond the two apart).',
    'coin|keys': 'More open doors bring more matching pairs for the Coin (3.56, +0.63 beyond the two apart).',
    'keys|trap': 'More open doors bring more meals for a Hunt (4.73, +0.38 beyond the two apart).',
    'keys|maul': 'More open doors bring more Lions and Wolves for Mammoths to eat up (4.39, +0.68 beyond the two apart).',
    'maiden|stake': 'Replace low inmates that stand level: 40% come in Legendary, and +3 on top (2.80, +0.36 beyond the two apart).',
    'claws|muzzle': 'Eating through scratched doors keeps the block thin, where consumes get the Muzzle\'s +2 (3.76, +0.46 beyond the two apart).',
    'scapegoat|trap': 'Clash: the Scapegoat\'s removals take Prey marks and Lions\' meals. Hunt, and avoid a Replace with 2 or more others on the block (-1.78 against the two apart).',
    'rope|scapegoat': 'Clash: Noose Replaces are already Rare or better, and the Scapegoat throws 2 inmates away for them. Replace with fewer than 2 others on the block (-1.17 against the two apart).',
    'maul|trap': 'Clash: Mammoths eat Lions, and Hunts want Lions alive. Pick one plan for the run (-1.46 against the two apart).',
    'ironbox|maul': 'Clash: hatched Rats eat Mammoths. Keep Mammoths away from Rat rarities, or let the Rats have the low ones (-0.87 against the two apart).',
    'revenge|trap': 'Clash: consumes and Hunts compete for the day\'s action, and a consume can break a Prey mark (-1.43 against the two apart).',
    'crown|scapegoat': 'Clash: the Scapegoat\'s removals take your Lions\' meals. Replace with fewer than 2 others on the block (-1.03 against the two apart).',
    'claws|ironbox': 'Clash: nests use up the locked cells the Claws scratch (-0.66 against the two apart).',
    'crown|maul': 'Clash: Mammoths eat Lions. Decide which beast your run climbs with (-0.83 against the two apart).',
    'crown|trap': 'The best pair measured (5.39 Rainbows a run), though less than the two apart (-0.98): both play through Lions, and a Lion consuming its marked prey ends the Hunt. Hunt first, and let Lions consume once the marks run out.',
    'ravenous|trap': 'Clash: each morning the Ravenous Chains\' highest inmate removes the inmates beside it, which can take a marked prey or its Lion. Keep Hunt pairs away from your best inmate (-1.11 against the two apart).',
    'trap|whip': 'Clash: the Whip pays for consuming every day, and a Hunt uses the day\'s action instead. Pick one plan for the run (-1.11 against the two apart).',
  };

  // The start-of-run cards ("contracts").
  const CONTRACT_NOTES = {
    cagefight: '囚徒困鬥：囚犯可以吃稀有度不高於自己、且被自己克制的野獸，吞噬後野獸種類也不會改變。高階吞噬者能把所有較低階的獵物吃光，還保留原本的野獸，所以多吞噬，並在最強的吞噬者周圍留些低階獵物。',
    ironlaw: '鐵律：這局持續30天。長線規劃更划算：尋獵、鼠巢、命運幣合併、累積一條長連鎖。',
    tyranny: '暴政：每次走到審訊室，煽動和賞賜還會各額外觸發3次。讓典獄長的路線常常經過審訊室。',
    opulence: '奢靡：每次典獄長的珍藏可以選3次，而靠選取做出的綺彩會再帶來3次。綺彩價值更高：珍藏的選取順序很重要（若銅號能做出綺彩就先選它）。',
  };

  // How a start card changes an instrument's play.
  const CONTRACT_TOOL_NOTES = {
    'cagefight|guillotine': '有囚徒困鬥時，每個吞噬者本來就能吃較低階的獵物，所以斷頭台毫無作用。',
    'cagefight|maul': '有囚徒困鬥時，巨象能吃任何稀有度的狂獅和頭狼：較低的靠囚徒困鬥，較高的靠重錘。',
    'cagefight|crown': '有囚徒困鬥時，狂獅能吃稀有度不高於自己的頭狼和碩鼠，再靠鐵冠吃任何同稀有度的囚犯。',
    'cagefight|skewer': '有囚徒困鬥時，碩鼠能吃稀有度不高於自己的巨象和碩鼠，而且吃完仍然是碩鼠。',
    'ironlaw|trap': '有鐵律的30天，獵物標記到第27天為止都能拿滿3個早上的收益。',
    'ironbox|ironlaw': '有鐵律的30天，會孵出更多鼠巢：有更多稀有碩鼠可用。',
    'coin|ironlaw': '有鐵律的30天，成對的囚犯有更多早上可以合併。',
  };

  const key = (a, b) => [a, b].sort().join('|');

  // Notes for a run: its start card first, then each instrument held, then
  // the pairs among them, then how the start card changes them.
  function notesFor(tools, startEvent, names) {
    const out = [];
    const held = (tools || []).filter((id) => TOOL_NOTES[id]);
    const name = (id) => (names && names[id]) || id;
    if (CONTRACT_NOTES[startEvent]) {
      const text = CONTRACT_NOTES[startEvent].replace(/^[^:：]+(?:: |：)/, '');
      out.push({ kind: 'contract', title: name(startEvent), text: text.charAt(0).toUpperCase() + text.slice(1) });
    }
    for (const id of held) out.push({ kind: 'tool', title: name(id), text: TOOL_NOTES[id] });
    for (let i = 0; i < held.length; i++) {
      for (let j = i + 1; j < held.length; j++) {
        const note = PAIR_NOTES[key(held[i], held[j])];
        if (note) out.push({ kind: 'pair', title: `${name(held[i])} ＋ ${name(held[j])}`, text: note });
      }
    }
    if (startEvent && startEvent !== 'none') {
      for (const id of held) {
        const note = CONTRACT_TOOL_NOTES[key(startEvent, id)];
        if (note) out.push({ kind: 'contract-tool', title: `${name(id)} ＋ ${name(startEvent)}`, text: note });
      }
    }
    return out;
  }

  const api = { TOOL_NOTES, PAIR_NOTES, CONTRACT_NOTES, CONTRACT_TOOL_NOTES, notesFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TartarusTips = api;
})(typeof window !== 'undefined' ? window : globalThis);

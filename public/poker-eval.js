const RANK_STR = ['','', '2','3','4','5','6','7','8','9','10','J','Q','K','A'];

export function cardIndexToRankSuit(i) {
  const idx = i - 1;
  const rank = 2 + (idx % 13);
  const suit = ['D','C','H','S'][Math.floor(idx / 13)];
  return { r: rank, s: suit };
}

function evaluate5(cards) {
  const cs = cards.map(cardIndexToRankSuit);
  let ranks = cs.map(c => c.r).sort((a,b)=>b-a);
  const suits = cs.map(c => c.s);
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r]||0)+1);
  const countArr = Object.entries(counts).map(([r,c])=>({r:parseInt(r), c})).sort((a,b)=> b.c - a.c || b.r - a.r);
  const isFlush = suits.every(s=>s===suits[0]);
  let isStraight = false; let straightHigh = null;
  const uniqueRanks = [...new Set(ranks)];
  if (uniqueRanks.length === 5) {
    const max = uniqueRanks[0]; const min = uniqueRanks[4];
    if (max - min === 4) { isStraight = true; straightHigh = max; }
    else if (JSON.stringify(uniqueRanks) === JSON.stringify([14,5,4,3,2])) { isStraight = true; straightHigh = 5; ranks = [5,4,3,2,14]; }
  }
  let cat, key;
  if (isStraight && isFlush) { cat = 8; key = [straightHigh]; }
  else if (countArr[0].c === 4) { cat = 7; key = [countArr[0].r, countArr[1].r]; }
  else if (countArr[0].c === 3 && countArr[1].c === 2) { cat = 6; key = [countArr[0].r, countArr[1].r]; }
  else if (isFlush) { cat = 5; key = ranks; }
  else if (isStraight) { cat = 4; key = [straightHigh]; }
  else if (countArr[0].c === 3) { const kickers = countArr.slice(1).map(x=>x.r); cat = 3; key = [countArr[0].r, ...kickers]; }
  else if (countArr[0].c === 2 && countArr[1].c === 2) { const pairs=[countArr[0].r,countArr[1].r].sort((a,b)=>b-a); const kicker=countArr[2].r; cat=2; key=[pairs[0],pairs[1],kicker]; }
  else if (countArr[0].c === 2) { const kickers = countArr.slice(1).map(x=>x.r).sort((a,b)=>b-a); cat = 1; key=[countArr[0].r, ...kickers]; }
  else { cat = 0; key = ranks; }
  let label;
  switch(cat){
    case 8: label = `Straight Flush (${ranks.map(r=>RANK_STR[r]).join('-')})`; break;
    case 7: label = `Four of a Kind (${RANK_STR[countArr[0].r]})`; break;
    case 6: label = `Full House (${RANK_STR[countArr[0].r]} over ${RANK_STR[countArr[1].r]})`; break;
    case 5: label = `Flush (${ranks.map(r=>RANK_STR[r]).join('-')})`; break;
    case 4: label = `Straight (${ranks.map(r=>RANK_STR[r]).join('-')})`; break;
    case 3: label = `Three of a Kind (${RANK_STR[countArr[0].r]})`; break;
    case 2: label = `Two Pair (${RANK_STR[countArr[0].r]} & ${RANK_STR[countArr[1].r]})`; break;
    case 1: label = `Pair (${RANK_STR[countArr[0].r]})`; break;
    default: label = `High Card (${RANK_STR[ranks[0]]})`; break;
  }
  return { cat, key, label };
}

function compare(a,b){
  if (a.cat !== b.cat) return a.cat - b.cat;
  const len = Math.max(a.key.length,b.key.length);
  for (let i=0;i<len;i++){
    const diff = (a.key[i]||0) - (b.key[i]||0);
    if(diff!==0) return diff;
  }
  return 0;
}

export function evalTexas7(hole2, board5){
  const cards = hole2.concat(board5);
  let best = null;
  for(let i=0;i<7;i++){
    for(let j=i+1;j<7;j++){
      const subset=[];
      for(let k=0;k<7;k++) if(k!==i && k!==j) subset.push(cards[k]);
      const e = evaluate5(subset);
      if(!best || compare(e,best)>0) best = e;
    }
  }
  return best;
}


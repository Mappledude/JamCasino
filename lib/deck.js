export function fullDeck(){
  const ranks = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
  const suits = ['s','h','d','c'];
  const deck = [];
  for(const r of ranks){
    for(const s of suits){
      deck.push(r+s);
    }
  }
  return deck;
}
export function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

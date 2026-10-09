// Draws a card face from its data, for packs that ship no card images (e.g. Yu-Gi-Oh!, whose
// art is not bundled). Frame colour comes from game.cardStyle.frames[card.frame].
const W = 630;
const H = 880;

export function drawCardFace(card, game) {
  const style = game.cardStyle ?? {};
  const frame = style.frames?.[card.frame] ?? style.frame ?? '#888888';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');

  g.fillStyle = '#1b1b1b';
  g.fillRect(0, 0, W, H);
  g.fillStyle = frame;
  g.beginPath();
  g.roundRect(14, 14, W - 28, H - 28, 22);
  g.fill();

  // Name bar.
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(40, 40, W - 80, 70);
  g.fillStyle = '#111';
  fitText(g, card.name, 56, 86, W - 112, 44, 'bold', 'Georgia, serif');

  // Level stars (or cost gems) under the name.
  const gems = Number(card.stats?.[style.gemsStat] ?? 0);
  g.fillStyle = style.gemColor ?? '#e0452b';
  for (let i = 0; i < Math.min(gems, 12); i++) {
    const cx = W - 66 - i * 40;
    g.beginPath();
    g.arc(cx, 140, 15, 0, Math.PI * 2);
    g.fill();
  }

  // Art box: no art is bundled, so show the card's type as a big emblem.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(70, 170, W - 140, W - 140);
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.textAlign = 'center';
  g.font = 'bold 64px system-ui, sans-serif';
  g.fillText(emblem(card), W / 2, 170 + (W - 140) / 2 + 20);
  g.textAlign = 'left';

  // Text box: type line, then stats.
  const boxY = 170 + (W - 140) + 24;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(40, boxY, W - 80, H - boxY - 40);
  g.fillStyle = '#111';
  const fields = { ...card.stats, type: card.type, frameLabel: label(card.frame) };
  const typeLine = card.type.includes('monster') || card.type === 'creature'
    ? template(style.typeLine ?? '{type}', fields)
    : `[${label(card.type)}${card.stats?.race && card.stats.race !== 'Normal' ? ` · ${card.stats.race}` : ''}]`;
  fitText(g, typeLine, 58, boxY + 46, W - 116, 32, 'bold', 'Georgia, serif');
  if (style.statLine && card.stats?.atk != null) {
    g.textAlign = 'right';
    fitText(g, template(style.statLine, fields), W - 58, H - 70, W - 116, 34, 'bold', 'Georgia, serif');
    g.textAlign = 'left';
  }
  if (card.stats?.passcode) {
    g.font = '22px monospace';
    g.fillText(card.stats.passcode, 58, H - 70);
  }
  return canvas;
}

function emblem(card) {
  if (card.stats?.attribute) return card.stats.attribute;
  return label(card.type).toUpperCase();
}

function label(s = '') {
  return s.split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ');
}

function template(t, fields) {
  return t.replace(/\{(\w+)\}/g, (_, k) => fields[k] ?? '');
}

function fitText(g, text, x, y, maxWidth, size, weight, family) {
  let s = size;
  do {
    g.font = `${weight} ${s}px ${family}`;
    s -= 2;
  } while (g.measureText(text).width > maxWidth && s > 12);
  g.fillText(text, x, y);
}

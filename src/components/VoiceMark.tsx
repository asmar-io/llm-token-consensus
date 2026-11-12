import { voiceColorVar, voiceShape } from "@/lib/client/palette";

/** A voice's colour + shape glyph. The shape is the non-colour cue. */
export function VoiceMark({ index, size = 12, className = "", hollow = false }: { index: number; size?: number; className?: string; hollow?: boolean }) {
  const c = voiceColorVar(index);
  const shape = voiceShape(index);
  const fill = hollow ? "none" : c;
  const stroke = c;
  const sw = hollow ? 1.6 : 0;
  let el: React.ReactNode;
  switch (shape) {
    case "square":
      el = <rect x="2" y="2" width="8" height="8" rx="1" fill={fill} stroke={stroke} strokeWidth={sw} />;
      break;
    case "triangle":
      el = <path d="M6 1.2 L11 10.4 L1 10.4 Z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
      break;
    case "diamond":
      el = <path d="M6 0.8 L11.2 6 L6 11.2 L0.8 6 Z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
      break;
    case "triangle-down":
      el = <path d="M1 1.6 L11 1.6 L6 10.8 Z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
      break;
    case "cross":
      el = <path d="M4.3 1h3.4v3.3H11v3.4H7.7V11H4.3V7.7H1V4.3h3.3z" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />;
      break;
    default:
      el = <circle cx="6" cy="6" r="4.6" fill={fill} stroke={stroke} strokeWidth={sw} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" className={`shrink-0 ${className}`}>
      {el}
    </svg>
  );
}

/** Canvas version of the same shapes, for the score. */
export function drawShape(ctx: CanvasRenderingContext2D, index: number, cx: number, cy: number, r: number) {
  const shape = voiceShape(index);
  ctx.beginPath();
  switch (shape) {
    case "square":
      ctx.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7);
      break;
    case "triangle":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy + r * 0.8);
      ctx.lineTo(cx - r, cy + r * 0.8);
      ctx.closePath();
      break;
    case "diamond":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "triangle-down":
      ctx.moveTo(cx - r, cy - r * 0.8);
      ctx.lineTo(cx + r, cy - r * 0.8);
      ctx.lineTo(cx, cy + r);
      ctx.closePath();
      break;
    case "cross": {
      const a = r * 0.36;
      ctx.rect(cx - a, cy - r, a * 2, r * 2);
      ctx.rect(cx - r, cy - a, r * 2, a * 2);
      break;
    }
    default:
      ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
  }
  ctx.fill();
}

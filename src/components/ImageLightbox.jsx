// Fullscreen image viewer with zoom + pan. Click any product image to
// open it here; partner and admin views share this so the verify
// experience is consistent on both sides.
//
// Controls:
//   - mouse wheel        → zoom in / out toward the cursor
//   - + / − buttons      → zoom in / out (step 0.25)
//   - 0 button or "Fit"  → reset to fit
//   - click + drag       → pan (only meaningful when zoomed in)
//   - ESC                → close
import { useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const STEP      = 0.25;

export default function ImageLightbox({ src, alt, onClose }) {
  const [scale, setScale]       = useState(1);
  const [offset, setOffset]     = useState({ x: 0, y: 0 });
  const dragRef = useRef(null);    // { startX, startY, startOffsetX, startOffsetY }

  // Reset state whenever the source image changes (e.g. picking a
  // different thumbnail in the gallery).
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [src]);

  // ESC closes the lightbox — common-sense keyboard escape hatch.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === '+' || e.key === '=') setScale(s => Math.min(MAX_SCALE, s + STEP));
      else if (e.key === '-' || e.key === '_') setScale(s => Math.max(MIN_SCALE, s - STEP));
      else if (e.key === '0')                  { setScale(1); setOffset({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Wheel: zoom in/out. We don't try to anchor zoom at the cursor — for
  // a small product viewer the centred zoom is simpler and good enough.
  const handleWheel = (e) => {
    e.preventDefault();
    const direction = e.deltaY > 0 ? -1 : 1;
    setScale(s => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s + direction * STEP));
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 }); // snap back when reset
      return next;
    });
  };

  const handleMouseDown = (e) => {
    if (scale <= 1) return; // nothing to pan
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: offset.x,
      startOffsetY: offset.y,
    };
  };
  const handleMouseMove = (e) => {
    if (!dragRef.current) return;
    setOffset({
      x: dragRef.current.startOffsetX + (e.clientX - dragRef.current.startX),
      y: dragRef.current.startOffsetY + (e.clientY - dragRef.current.startY),
    });
  };
  const handleMouseUp = () => { dragRef.current = null; };

  const zoomIn  = () => setScale(s => Math.min(MAX_SCALE, s + STEP));
  const zoomOut = () => setScale(s => Math.max(MIN_SCALE, s - STEP));
  const reset   = () => { setScale(1); setOffset({ x: 0, y: 0 }); };

  return (
    <div
      onClick={onClose}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(15,23,42,0.92)',
        display:'flex', alignItems:'center', justifyContent:'center',
        userSelect:'none',
      }}
    >
      {/* Top-right toolbar */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position:'absolute', top:'1rem', right:'1rem',
          display:'flex', gap:'0.4rem', alignItems:'center',
          background:'rgba(255,255,255,0.12)', padding:'0.35rem 0.5rem', borderRadius:'8px',
          color:'#fff', fontSize:'0.85rem',
        }}
      >
        <button type="button" onClick={zoomOut} style={btnStyle} title="Zoom out (-)">−</button>
        <span style={{minWidth:'3.5rem', textAlign:'center'}}>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={zoomIn}  style={btnStyle} title="Zoom in (+)">+</button>
        <button type="button" onClick={reset}   style={{...btnStyle, fontSize:'0.75rem', padding:'0.25rem 0.55rem'}} title="Reset (0)">Fit</button>
        <button type="button" onClick={onClose} style={{...btnStyle, fontSize:'1rem'}} title="Close (Esc)">✕</button>
      </div>

      <img
        src={src}
        alt={alt || ''}
        onClick={e => e.stopPropagation()}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onDragStart={e => e.preventDefault()}
        style={{
          maxWidth:'92vw', maxHeight:'90vh',
          objectFit:'contain',
          transform:`translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin:'center center',
          transition: dragRef.current ? 'none' : 'transform 0.12s ease-out',
          cursor: scale > 1 ? (dragRef.current ? 'grabbing' : 'grab') : 'zoom-in',
        }}
      />
    </div>
  );
}

const btnStyle = {
  background:'transparent', border:'1px solid rgba(255,255,255,0.3)',
  color:'#fff', borderRadius:'6px',
  padding:'0.2rem 0.55rem', cursor:'pointer',
  fontSize:'1rem', lineHeight:1,
};

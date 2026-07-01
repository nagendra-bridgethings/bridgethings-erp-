// src/lib/cart.jsx — Channel partner's in-progress purchase order ("cart").
//
// Lives in a React context + localStorage so a partner can:
//   - Add a product from Catalog → switch to Dashboard → come back to /partner/po
//     and still see the items they were building
//   - Reload the browser without losing their draft PO
//
// Scoped per-user via the auth user id so two partners sharing a browser
// can't see each other's drafts.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './auth';

const CartContext = createContext(null);

const cartKey = (userId) => `bridgethings.cart.${userId || 'anon'}`;

const readCart = (userId) => {
  try {
    const raw = localStorage.getItem(cartKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const writeCart = (userId, items) => {
  try { localStorage.setItem(cartKey(userId), JSON.stringify(items)); } catch { /* ignore */ }
};

const clearCartStorage = (userId) => {
  try { localStorage.removeItem(cartKey(userId)); } catch { /* ignore */ }
};

export function CartProvider({ children }) {
  const { user } = useAuth();
  const userId = user?.supabaseId || null;

  // Hydrate from storage when the user changes (different partner = different cart).
  const [items, setItems] = useState(() => readCart(userId));

  // Track the previous user id so we can detect logout transitions and wipe
  // the previous user's cart from localStorage — leaving someone else's draft
  // PO in shared browser storage is a privacy concern.
  const prevUserIdRef = useRef(userId);
  useEffect(() => {
    const prev = prevUserIdRef.current;
    if (prev && prev !== userId) {
      // User changed or logged out. Clear the previous user's stored cart.
      clearCartStorage(prev);
    }
    prevUserIdRef.current = userId;
    setItems(readCart(userId));
  }, [userId]);

  // Persist on every change.
  useEffect(() => {
    if (userId) writeCart(userId, items);
  }, [items, userId]);

  const add = useCallback((product, qty = 1) => {
    const addQty = Math.max(1, Math.floor(Number(qty) || 1));
    setItems(prev => {
      // If product already in cart, don't duplicate — bump qty.
      const idx = prev.findIndex(i => i.product_id === product.id);
      if (idx >= 0) {
        return prev.map((i, x) => x === idx ? { ...i, qty: (i.qty || 1) + addQty } : i);
      }
      return [...prev, {
        product_id: product.id,
        product: {
          id:              product.id,
          name:            product.name,
          base_price:      product.base_price,
          features:        product.features || [],
          image_url:       product.image_url,
          cable_supported: !!product.cable_supported,
        },
        qty: addQty,
        notes: '',
        extra_cable_m: 0,
      }];
    });
  }, []);

  const updateField = useCallback((idx, field, value) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  }, []);

  const removeAt = useCallback((idx) => {
    setItems(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    if (userId) clearCartStorage(userId);
  }, [userId]);

  const has = useCallback((productId) => items.some(i => i.product_id === productId), [items]);

  const total = useMemo(
    () => items.reduce((s, i) => s + (Number(i.product?.base_price) || 0) * (Number(i.qty) || 0), 0),
    [items]
  );

  const value = useMemo(() => ({
    items, total, add, updateField, removeAt, clear, has,
  }), [items, total, add, updateField, removeAt, clear, has]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export const useCart = () => {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
};

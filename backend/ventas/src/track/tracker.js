/* Altorancho · recorrido de visitantes (se sirve como /t.js).
 * Anota cada visita con su origen, las páginas y productos vistos, lo que se
 * agrega al carrito, el checkout y la compra. Solo un id anónimo por navegador:
 * nada de mails, nombres ni datos de pago. */
(function () {
  'use strict';
  if (window.__artk) return;
  window.__artk = 1;
  try {
    var me = document.currentScript && document.currentScript.src;
    var BASE = me ? me.replace(/\/t\.js.*$/, '') : '';
    if (!BASE) return;
    var URL_C = BASE + '/t/c';
    var VK = 'art_v', SK = 'art_s', IDLE = 30 * 60 * 1000;
    var CAMPAIGN_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'epik', 'ttclid'];

    function uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 3) | 8).toString(16);
      });
    }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function cookie(k) { var m = document.cookie.match(new RegExp('(?:^|; )' + k + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }

    var vid = lsGet(VK) || cookie(VK);
    if (!vid || !/^[a-z0-9-]{8,40}$/.test(vid)) vid = uuid();
    lsSet(VK, vid);
    var exp = new Date(); exp.setFullYear(exp.getFullYear() + 1);
    document.cookie = VK + '=' + vid + '; expires=' + exp.toUTCString() + '; path=/; SameSite=Lax';

    var params = {};
    try { new URL(location.href).searchParams.forEach(function (v, k) { params[k.toLowerCase()] = v; }); } catch (e) {}
    var sig = CAMPAIGN_KEYS.map(function (k) { return params[k] || ''; }).join('|');
    var hasCampaign = sig.replace(/\|/g, '') !== '';

    var now = Date.now();
    var sess = null;
    try { sess = JSON.parse(lsGet(SK) || 'null'); } catch (e) {}
    var newSession = !sess || !sess.id || now - sess.last > IDLE || (hasCampaign && sess.sig !== sig);
    if (newSession) sess = { id: uuid(), sig: sig };
    sess.last = now;
    lsSet(SK, JSON.stringify(sess));

    var LS = window.LS || {};
    var cid = LS.customer && LS.customer.id ? String(LS.customer.id) : null;
    var w = window.innerWidth || 1024;
    var dev = w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop';

    var queue = [];
    var timer = null;
    function flush() {
      timer = null;
      if (!queue.length) return;
      var body = JSON.stringify({ v: vid, s: sess.id, e: queue.splice(0, 20) });
      try {
        if (!(navigator.sendBeacon && navigator.sendBeacon(URL_C, body))) {
          fetch(URL_C, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }).catch(function () {});
        }
      } catch (e) {}
      if (queue.length) flush();
    }
    function send(ev, now_) {
      queue.push(ev);
      if (now_) flush();
      else if (!timer) timer = setTimeout(flush, 800);
    }
    window.addEventListener('pagehide', flush);

    function cartState() {
      var c = (window.LS && window.LS.cart) || {};
      var items = c.items || [];
      var n = 0;
      for (var i = 0; i < items.length; i++) n += Number(items[i].quantity) || 0;
      return { items: n, total: c.subtotal != null ? Number(c.subtotal) / 100 : null, list: items };
    }

    var path = location.pathname.toLowerCase();

    // Compra: página de "gracias" del checkout (o el script de la página de finalización)
    var isSuccess = /\/checkout\//.test(path) && /(success|thank|gracias|confirm)/.test(path);
    if (isSuccess || window.__artkPurchase) {
      var m = path.match(/\/(\d{6,15})(?:\/|$)/);
      var orderId = (window.LS && LS.order && LS.order.id) || (m && m[1]) || null;
      var done = 'art_p_' + (orderId || path);
      if (!lsGet(done)) {
        lsSet(done, '1');
        if (newSession) send({ t: 'session', url: location.href, ref: document.referrer || null, dev: dev, cid: cid });
        send({ t: 'purchase', order: orderId ? String(orderId) : null }, true);
      }
      return;
    }

    if (newSession) send({ t: 'session', url: location.href, ref: document.referrer || null, dev: dev, cid: cid });

    if (/\/checkout\//.test(path)) {
      var ck = 'art_c_' + sess.id;
      if (!lsGet(ck)) {
        lsSet(ck, '1');
        var cs = cartState();
        send({ t: 'checkout', step: path.split('/').filter(Boolean).slice(-1)[0] || null, items: cs.items, total: cs.total });
      }
    }

    var isProduct = /^\/productos\/[^/]+\/?$/.test(path) && path !== '/productos/';
    send({ t: 'page', product: isProduct, path: location.pathname, cid: cid });

    // Agregado al carrito: evento propio de Tienda Nube
    var before = {};
    (cartState().list || []).forEach(function (it) { before[it.id] = Number(it.quantity) || 0; });
    function pick(o, keys) {
      if (!o || typeof o !== 'object') return null;
      for (var i = 0; i < keys.length; i++) if (o[keys[i]] != null && o[keys[i]] !== '') return o[keys[i]];
      return null;
    }
    // detail = { cart, cart_item, quantity_added } (precios en centavos)
    document.addEventListener('productAddedToCart', function (e) {
      var d = (e && e.detail) || {};
      var ci = d.cart_item || d.cartItem;
      if (ci) {
        var cart = d.cart || {};
        var n = 0;
        (cart.items || []).forEach(function (it) { n += Number(it.quantity) || 0; before[it.id] = Number(it.quantity) || 0; });
        send({
          t: 'add_to_cart', sku: ci.sku || null, name: ci.name || null,
          qty: Number(d.quantity_added) || 1,
          price: ci.unit_price != null ? Number(ci.unit_price) / 100 : null,
          items: n || null, total: cart.subtotal != null ? Number(cart.subtotal) / 100 : null,
        }, true);
        return;
      }
      var item = d.item || d.product || d.variant || d;
      setTimeout(function () {
        var cs = cartState();
        var added = null;
        (cs.list || []).forEach(function (it) {
          var q = Number(it.quantity) || 0;
          if (!added && q > (before[it.id] || 0)) added = { it: it, qty: q - (before[it.id] || 0) };
          before[it.id] = q;
        });
        var src = added ? added.it : item;
        send({
          t: 'add_to_cart',
          sku: pick(src, ['sku', 'variant_sku']) || pick(item, ['sku']),
          name: pick(src, ['name', 'analytics_name']) || pick(item, ['name']),
          qty: added ? added.qty : Number(pick(item, ['quantity', 'qty'])) || 1,
          price: pick(src, ['unit_price', 'price']) != null ? Number(pick(src, ['unit_price', 'price'])) / 100 : null,
          items: cs.items, total: cs.total,
        }, true);
      }, 1200);
    });
  } catch (e) {}
})();

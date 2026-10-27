/* HRM STOCK · PWA — service worker + "ติดตั้งแอป" pill (Android/desktop prompt · iPhone hint) */
(function () {
  'use strict';
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { } };
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { }));
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone || document.body.dataset.view === 'widget' || get('pwaHide') === '1') return;

  const css = `.pwa-pill{position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top));transform:translate(-50%,-24px);opacity:0;z-index:9000;
    display:flex;align-items:center;gap:12px;width:min(440px,calc(100% - 32px));box-sizing:border-box;padding:10px 8px 10px 10px;border-radius:22px;
    background:rgba(255,255,255,.86);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);
    box-shadow:0 10px 30px rgba(20,30,60,.16),inset 0 0 0 1px rgba(255,255,255,.7);font:600 14px/1.3 "Thonburi","Noto Sans Thai",system-ui,sans-serif;color:#111722;
    transition:transform .35s cubic-bezier(.2,.8,.2,1),opacity .35s}
  .pwa-pill.on{transform:translate(-50%,0);opacity:1}
  .pwa-pill img{width:36px;height:36px;border-radius:10px;flex:none}
  .pwa-pill span{display:flex;flex-direction:column;min-width:0;flex:1}.pwa-pill small{font-size:11.5px;font-weight:500;color:#535D6D}
  .pwa-pill button{height:40px;border:0;border-radius:999px;font:inherit;cursor:pointer}
  .pwa-pill .go{flex:none;padding:0 16px;color:#fff;background:linear-gradient(180deg,#4A7DEB,#2862E6);box-shadow:0 6px 14px rgba(40,98,230,.3)}
  .pwa-pill .x{flex:none;width:40px;background:transparent;color:#6B7587;font-size:20px}
  .pwa-pill .x:hover{background:rgba(0,0,0,.05)}
  @media (prefers-color-scheme:dark){.pwa-pill{background:rgba(30,36,48,.86);color:#EEF2F8}.pwa-pill small{color:#A9B3C3}}`;
  function pill(title, sub, onGo) {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement('div'); el.className = 'pwa-pill'; el.setAttribute('role', 'dialog');
    el.innerHTML = `<img src="/icons/icon-192.png" alt=""><span><b>${title}</b><small>${sub}</small></span>${onGo ? '<button class="go">ติดตั้ง</button>' : ''}<button class="x" aria-label="ปิด">×</button>`;
    document.body.appendChild(el); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('on')));
    const close = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 400); };
    el.querySelector('.x').onclick = () => { set('pwaHide', '1'); close(); };
    if (onGo) el.querySelector('.go').onclick = async () => { close(); await onGo(); };
  }
  let ev = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); ev = e;
    setTimeout(() => pill('ติดตั้ง HRM STOCK เป็นแอป', 'เปิดเร็ว เต็มจอ มีไอคอนบนหน้าจอ', async () => {
      ev.prompt(); const r = await ev.userChoice.catch(() => null); if (r && r.outcome === 'accepted') set('pwaHide', '1'); ev = null;
    }), 4000);
  });
  window.addEventListener('appinstalled', () => set('pwaHide', '1'));
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && get('pwaIos') !== '1') setTimeout(() => { set('pwaIos', '1'); pill('เพิ่ม HRM STOCK ลงหน้าจอโฮม', 'แตะปุ่มแชร์ ⎙ แล้วเลือก “เพิ่มไปยังหน้าจอโฮม”'); }, 4000);
})();

import { setTimeout as pause } from 'node:timers/promises';
let target;
for (let i = 0; i < 30; i++) {
 try { target = await (await fetch('http://127.0.0.1:9227/json/new?about:blank', { method: 'PUT' })).json(); break; } catch { await pause(100); }
}
if (!target) throw new Error('Fixture browser unavailable');
const ws = new WebSocket(target.webSocketDebuggerUrl); const pending = new Map(); let id = 0;
ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.result); } };
await new Promise(resolve => ws.onopen = resolve);
const send = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); });
const read = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
try {
 await send('Page.enable'); await send('Runtime.enable');
 await send('Page.navigate', { url: 'http://127.0.0.1:5173/tests/browser-media-fixture.html' });
 let box;
 for (let i = 0; i < 50; i++) { box = await read('document.querySelector("#run") ? (() => { const r=document.querySelector("#run").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })() : null'); if (box) break; await pause(100); }
 if (!box) throw new Error('Fixture button not loaded');
 await pause(500);
 await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
 await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
 let result = '';
 for (let i = 0; i < 120; i++) { result = await read('document.querySelector("#result")?.textContent'); if (/^(PASS|FAIL)/.test(result)) break; await pause(100); }
 console.log(result); if (!result.startsWith('PASS')) process.exitCode = 1;
} finally { await send('Page.close'); ws.close(); }

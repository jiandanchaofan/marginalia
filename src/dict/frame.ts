/**
 * The page an entry is shown in: a closed frame (sandbox, no same-origin) with its own content rules. Nothing in it can reach
 * the app, the disk or the network; links and sounds are handed to the app by messages. Scripts of the entry run only if
 * the dictionary uses scripts (the Rust side only keeps the dictionary's own).
 */
export function frameDoc(body: string, scripts: boolean, nonce: string): string {
  const csp = [
    "default-src 'none'",
    "img-src data:",
    "media-src data:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    scripts ? "script-src 'unsafe-inline'" : `script-src 'nonce-${nonce}'`,
  ].join("; ");
  const bridge = `
(function(){
  var send=function(m){parent.postMessage(m,"*")};
  document.addEventListener("click",function(e){
    var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;
    if(!a)return;
    var h=a.getAttribute("href")||"";
    if(h.charAt(0)==="#")return;
    e.preventDefault();
    if(/^entry:\\/\\//i.test(h))send({t:"entry",w:decodeURIComponent(h.replace(/^entry:\\/\\//i,"")).replace(/\\/$/,"")});
    else if(/^sound:\\/\\//i.test(h))send({t:"sound",n:decodeURIComponent(h.replace(/^sound:\\/\\//i,""))});
  },true);
  var last=0;
  var report=function(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);if(h!==last){last=h;send({t:"h",h:h})}};
  new ResizeObserver(report).observe(document.documentElement);
  window.addEventListener("load",report);report();
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;background:#fff;color:#1c1b1a}body{padding:10px 14px 14px;font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;overflow-wrap:anywhere;zoom:.9}img{max-width:100%}a{cursor:pointer}</style>
</head><body>${body}<script nonce="${nonce}">${bridge}</script></body></html>`;
}

// Runs a user-built web page in an isolated, opaque-origin frame (the embedding
// iframe has sandbox="allow-scripts" and NO allow-same-origin). The parent posts
// the page HTML; we replace this document with it so its own CSS/JS run normally.
addEventListener('message', function (e) {
  if (e.source !== parent) return;
  var d = e.data;
  if (d && d.type === 'gz-site' && typeof d.html === 'string') {
    document.open(); document.write(d.html); document.close();
  }
});
parent.postMessage({ type: 'gz-site-ready' }, '*');

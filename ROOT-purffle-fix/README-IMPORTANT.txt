════════════════════════════════════════════════════════════
  WHY YOU KEEP SEEING THE OLD PAGE  —  AND THE FIX
════════════════════════════════════════════════════════════

THE CAUSE
---------
Your ROOT site (purffle.com) has a service worker at:
    public_html/sw.js
The old one is "cache-first": it shows the CACHED page first and only
checks the network afterwards. So your browser keeps showing the OLD
Claude Multi page even after refreshing — the server is already correct.

(Confirmed: the live server IS serving the new page. It's the browser's
service-worker cache that's stale.)


THE FIX  (1 file)
-----------------
Replace the root service worker with the new "network-first" one in
this folder:

    Upload   sw.js   from this folder  ->  public_html/sw.js
             (overwrite the existing one)

The new sw.js:
  - Always fetches the LATEST page for normal page loads (no more stale
    pages, ever — for the whole purffle.com site).
  - Still works offline (falls back to cache when there's no network).
  - Cache name bumped purffle-v1 -> purffle-v2, so every visitor's old
    cache is automatically wiped once.


AFTER UPLOADING — clear it once on your own browser
---------------------------------------------------
1. Open  https://purffle.com/claude-multi/
2. Press F12  ->  Application tab  ->  Service Workers  ->  Unregister
3. Application tab  ->  Storage  ->  "Clear site data"
4. Refresh.  You'll now see the new animated site.

(Or just open it in a fresh Incognito window to see it immediately —
Incognito ignores the service worker cache.)


NOTE
----
This sw.js file goes at the ROOT (public_html/sw.js), NOT inside the
claude-multi folder. Everything in the "hostinger-upload" folder still
goes inside public_html/claude-multi/ as before.

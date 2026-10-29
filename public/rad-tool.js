(function () {
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isIg(v) {
    return /^https?:\/\/(www\.)?(instagram\.com|instagr\.am)\//i.test(String(v || '').trim());
  }
  function clock(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fileBase(data) {
    var raw = data.track || (data.title && data.title !== 'Original audio' ? data.title : 'reel-audio');
    return String(raw).replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'reel-audio';
  }

  document.querySelectorAll('.rad-tool').forEach(function (tool) {
    var form = tool.querySelector('.rad-form');
    var input = tool.querySelector('.rad-url');
    var pasteBtn = tool.querySelector('.rad-paste');
    var clearBtn = tool.querySelector('.rad-clear');
    var go = tool.querySelector('.rad-go');
    var status = tool.querySelector('.rad-status');
    var statusText = tool.querySelector('.rad-status-text');
    var errorBox = tool.querySelector('.rad-error');
    var errorText = tool.querySelector('.rad-error-text');
    var result = tool.querySelector('.rad-result');
    var coverWrap = tool.querySelector('.rad-cover-wrap');
    var cover = tool.querySelector('.rad-cover');
    var badge = tool.querySelector('.rad-badge');
    var titleEl = tool.querySelector('.rad-title');
    var metaEl = tool.querySelector('.rad-meta');
    var captionEl = tool.querySelector('.rad-caption');
    var audio = tool.querySelector('.rad-audio');
    var mp3Btn = tool.querySelector('.rad-mp3');
    var m4aBtn = tool.querySelector('.rad-m4a');
    var again = tool.querySelector('.rad-again');
    var timer = null;
    if (!input || !go || !audio) return;

    function show(el, on) { if (el) el.hidden = !on; }
    function setDownload(btn, url, filename) {
      if (!btn) return;
      btn.dataset.url = url || '';
      btn.dataset.name = filename;
      btn.hidden = !url;
    }
    async function saveFile(btn) {
      var url = btn.dataset.url;
      var filename = btn.dataset.name || 'reel-audio';
      if (!url || btn.dataset.busy === '1') return;
      btn.dataset.busy = '1';
      var label = btn.querySelector('.rad-dl-label');
      var old = label ? label.textContent : '';
      if (label) label.textContent = 'Downloading...';
      var fetchUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'download=1&filename=' + encodeURIComponent(filename);
      try {
        var res = await fetch(fetchUrl);
        if (!res.ok) throw new Error('download failed');
        var blob = await res.blob();
        var objectUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1500);
      } catch (err) {
        var frame = document.createElement('iframe');
        frame.hidden = true;
        frame.src = fetchUrl;
        document.body.appendChild(frame);
        setTimeout(function () { frame.remove(); }, 60000);
      }
      if (label) label.textContent = old;
      btn.dataset.busy = '0';
    }
    function syncClear() { show(clearBtn, !!input.value.trim()); }
    function showError(message) {
      show(status, false);
      show(result, false);
      errorText.textContent = message;
      show(errorBox, true);
    }
    function setBusy(busy) {
      go.disabled = busy;
      pasteBtn.disabled = busy;
      go.classList.toggle('is-busy', busy);
    }
    function stopProgress() {
      if (timer) clearInterval(timer);
      timer = null;
    }
    function startProgress() {
      stopProgress();
      show(errorBox, false);
      show(result, false);
      var stages = ['Checking link…', 'Audio found…', 'Converting MP3…', 'Preparing download…'];
      var i = 0;
      statusText.textContent = stages[0];
      show(status, true);
      timer = setInterval(function () {
        if (i < stages.length - 1) i += 1;
        statusText.textContent = stages[i];
      }, 1400);
    }

    function render(data) {
      var user = String(data.username || '').replace(/^@/, '').trim();
      var handle = user ? '@' + user : '';
      var author = String(data.author || '').trim();
      var authorOk = author && (/\s/.test(author) || author.toLowerCase() === user.toLowerCase());
      var heading = data.track || (handle ? 'Audio from ' + handle : 'Original audio');
      badge.textContent = (data.originalAudio === false || data.track) ? 'Song' : 'Original audio';
      titleEl.textContent = heading;
      var meta = [];
      if (authorOk && author.toLowerCase() !== user.toLowerCase()) meta.push(author);
      if (handle) meta.push(handle);
      if (data.artist && data.artist !== data.author) meta.push(data.artist);
      if (data.duration) meta.push(clock(data.duration));
      if (data.bitrate) meta.push(data.bitrate + ' kbps');
      metaEl.textContent = meta.join(' · ');
      if (data.caption) {
        captionEl.hidden = false;
        captionEl.textContent = data.caption;
      } else {
        captionEl.hidden = true;
        captionEl.textContent = '';
      }
      if (data.thumbnail) {
        coverWrap.classList.remove('is-empty');
        cover.classList.remove('is-missing');
        cover.alt = heading;
        cover.src = data.thumbnail;
      } else {
        coverWrap.classList.add('is-empty');
        cover.classList.add('is-missing');
        cover.removeAttribute('src');
      }
      audio.src = data.mp3Url || data.m4aUrl || data.audioUrl || '';
      audio.load();
      setDownload(mp3Btn, data.mp3Url, fileBase(data) + '.mp3');
      setDownload(m4aBtn, data.m4aUrl, fileBase(data) + '.m4a');
      show(status, false);
      show(errorBox, false);
      show(result, true);
    }

    async function run() {
      var link = input.value.trim();
      syncClear();
      if (!link) { showError('Please paste an Instagram Reel link first.'); input.focus(); return; }
      if (!isIg(link)) { showError('This doesn\'t look like an Instagram link. Copy the Reel link and try again.'); input.focus(); return; }
      if (!window.radv2Ajax || !radv2Ajax.ajaxUrl) { showError('The downloader is not connected yet.'); return; }
      setBusy(true);
      startProgress();
      try {
        var direct = /\/api\/audio/.test(radv2Ajax.ajaxUrl);
        var res;
        if (direct) {
          res = await fetch(radv2Ajax.ajaxUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: link })
          });
        } else {
          var body = new URLSearchParams();
          body.set('action', 'radv2_get_audio');
          body.set('nonce', radv2Ajax.nonce || '');
          body.set('link', link);
          res = await fetch(radv2Ajax.ajaxUrl, { method: 'POST', body: body });
        }
        var data = await res.json();
        stopProgress();
        if (!data.success) showError(data.error || data.message || 'Something went wrong. Please try again.');
        else render(data);
      } catch (e) {
        stopProgress();
        showError('Something went wrong. Please try again.');
      }
      setBusy(false);
    }

    form.addEventListener('submit', function (e) { e.preventDefault(); run(); });
    input.addEventListener('input', syncClear);
    clearBtn.addEventListener('click', function () {
      input.value = '';
      syncClear();
      audio.pause();
      show(result, false);
      show(errorBox, false);
      show(status, false);
      input.focus();
    });
    input.addEventListener('paste', function (e) {
      var text = (e.clipboardData && e.clipboardData.getData('text') || '').trim();
      if (isIg(text)) setTimeout(function () { syncClear(); run(); }, 0);
    });
    pasteBtn.addEventListener('click', async function () {
      try {
        var text = (await navigator.clipboard.readText() || '').trim();
        if (!text) { showError('The clipboard is empty.'); return; }
        input.value = text;
        syncClear();
        if (isIg(text)) run();
        else { showError('The clipboard does not contain an Instagram link.'); input.focus(); }
      } catch (err) {
        showError('Clipboard access was blocked. Tap the box and paste with your keyboard.');
        input.focus();
      }
    });
    mp3Btn.addEventListener('click', function () { saveFile(mp3Btn); });
    m4aBtn.addEventListener('click', function () { saveFile(m4aBtn); });
    cover.addEventListener('error', function () {
      cover.classList.add('is-missing');
      coverWrap.classList.add('is-empty');
    });
    again.addEventListener('click', function () {
      audio.pause();
      input.value = '';
      syncClear();
      show(result, false);
      input.focus();
    });
    syncClear();
  });
})();

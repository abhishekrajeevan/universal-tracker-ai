// MV3-safe Options page logic matching options.html
const OPTS_KEY = "options";
const AI_OPTS_KEY = "ai_options"; // { api_key, prefill_title, prefill_category, prefill_priority, prefill_tags, prefill_summary }

async function getLocal(key) { return (await chrome.storage.local.get([key]))[key]; }
async function setLocal(key, val) { return chrome.storage.local.set({ [key]: val }); }

let currentConfig = {};
let currentAIConfig = {};

function updateCheckboxUI() {
  document.querySelectorAll('.checkbox-item').forEach(item => {
    const cb = item.querySelector('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) item.classList.add('checked');
    else item.classList.remove('checked');
  });
}

async function loadConfig() {
  try {
    const opts = (await getLocal(OPTS_KEY)) || {};
    currentConfig = opts;
    const ai = (await chrome.storage.local.get([AI_OPTS_KEY]))[AI_OPTS_KEY] || {};
    currentAIConfig = ai;

    // Google Sheets settings
    const urlEl = document.getElementById('appsScriptUrl');
    const autosyncEl = document.getElementById('autosync');
    if (urlEl) urlEl.value = opts.apps_script_url || '';
    if (autosyncEl) autosyncEl.value = opts.autosync_mins || 10;

    // AI settings
    document.getElementById('apiKey').value = ai.api_key || '';
    if (document.getElementById('tmdbKey')) document.getElementById('tmdbKey').value = ai.tmdb_api_key || '';
    if (document.getElementById('jwCountry')) document.getElementById('jwCountry').value = ai.jw_country || 'US';
    document.getElementById('prefillTitle').checked = !!ai.prefill_title;
    document.getElementById('prefillCategory').checked = !!ai.prefill_category;
    document.getElementById('prefillPriority').checked = !!ai.prefill_priority;
    document.getElementById('prefillTags').checked = !!ai.prefill_tags;
    document.getElementById('prefillSummary').checked = !!ai.prefill_summary;
    const prefillTimeEl = document.getElementById('prefillTime');
    if (prefillTimeEl) prefillTimeEl.checked = !!ai.prefill_time;

    updateCheckboxUI();
  } catch (e) {
    showStatus('saveStatus', 'error', 'Failed to load configuration: ' + e.message);
  }
}

async function saveAllConfig() {
  const saveBtn = document.getElementById('saveBtn');
  const original = saveBtn.innerHTML;
  saveBtn.innerHTML = '<span>⏳</span> Saving...';
  saveBtn.disabled = true;
  try {
    const url = document.getElementById('appsScriptUrl').value.trim();
    const mins = Number(document.getElementById('autosync').value);
    if (url && !url.startsWith('https://script.google.com/')) throw new Error('Please enter a valid Google Apps Script URL');
    const opts = currentConfig;
    opts.apps_script_url = url;
    opts.autosync_mins = Math.max(5, mins || 10);
    await setLocal(OPTS_KEY, opts);

    const aiConfig = {
      api_key: document.getElementById('apiKey').value.trim(),
      prefill_title: document.getElementById('prefillTitle').checked,
      prefill_category: document.getElementById('prefillCategory').checked,
      prefill_priority: document.getElementById('prefillPriority').checked,
      prefill_tags: document.getElementById('prefillTags').checked,
      prefill_summary: document.getElementById('prefillSummary').checked,
      prefill_time: (document.getElementById('prefillTime')?.checked) || false,
      tmdb_api_key: (document.getElementById('tmdbKey')?.value || '').trim(),
      jw_country: (document.getElementById('jwCountry')?.value || 'US').trim(),
    };
    await chrome.storage.local.set({ [AI_OPTS_KEY]: aiConfig });

    currentConfig = opts;
    currentAIConfig = aiConfig;
    chrome.alarms.create('autosync', { periodInMinutes: opts.autosync_mins });
    showStatus('saveStatus', 'success', '✅ All settings saved successfully!');
  } catch (e) {
    showStatus('saveStatus', 'error', '❌ Failed to save: ' + e.message);
  } finally {
    saveBtn.innerHTML = original;
    saveBtn.disabled = false;
  }
}

async function resetConfig() {
  if (!confirm('Are you sure you want to reset all settings to defaults?')) return;
  const btn = document.getElementById('resetBtn');
  const original = btn.innerHTML;
  btn.innerHTML = '<span>🔄</span> Resetting...';
  btn.disabled = true;
  try {
    await setLocal(OPTS_KEY, { apps_script_url: '', autosync_mins: 10 });
    await chrome.storage.local.set({ [AI_OPTS_KEY]: { api_key: '', prefill_title: true, prefill_category: true, prefill_priority: true, prefill_tags: true, prefill_summary: true } });
    location.reload();
  } catch (e) {
    showStatus('saveStatus', 'error', '❌ Failed to reset: ' + e.message);
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function testConnection() {
  const btn = document.getElementById('testConnectionBtn');
  const original = btn.innerHTML;
  btn.innerHTML = '<span>⏳</span> Testing...';
  btn.disabled = true;
  try {
    const url = document.getElementById('appsScriptUrl').value.trim();
    if (!url) throw new Error('Please enter an Apps Script URL first');
    if (!url.startsWith('https://script.google.com/')) throw new Error('URL must start with https://script.google.com/');
    if (!url.endsWith('/exec')) throw new Error('URL must end with /exec');
    const resp = await fetch(url + '?action=getStats', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!resp.ok) {
      if (resp.status === 403) throw new Error('Access denied. Make sure your Apps Script is deployed with "Anyone" access.');
      if (resp.status === 404) throw new Error('Not found. Check that your Apps Script is deployed as a Web App.');
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const result = await resp.json();
    alert(`✅ Connection successful!\n\n📊 Current Statistics:\n• Active Items: ${result.active}\n• Archived Items: ${result.archived}\n• Total Items: ${result.total}\n• Archive Sheets: ${result.archiveSheets}\n\n🎉 Your Universal Tracker is ready to use!`);
    btn.innerHTML = '<span>✅</span> Connected';
  } catch (e) {
    alert(`❌ Connection failed: ${e.message}`);
    btn.innerHTML = '<span>❌</span> Failed';
  } finally {
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 2000);
  }
}

async function viewStats() {
  const btn = document.getElementById('viewStatsBtn');
  const original = btn.innerHTML;
  btn.innerHTML = '<span>⏳</span> Loading...';
  btn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
    if (response && response.success) {
      const s = response.stats;
      alert(`📊 Storage Statistics:\n\nActive Items: ${s.active}\nArchived Items: ${s.archived}\nTotal Items: ${s.total}\nArchive Sheets: ${s.archiveSheets}\n\n💡 Tip: Items older than 6 months are automatically archived to keep your active sheet fast.`);
    } else {
      throw new Error((response && response.error) || 'Failed to get stats');
    }
  } catch (e) {
    alert(`Error getting statistics: ${e.message}`);
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

async function triggerArchive() {
  const btn = document.getElementById('triggerArchiveBtn');
  const original = btn.innerHTML;
  if (!confirm('This will archive items older than 6 months to separate sheets. Continue?')) return;
  btn.innerHTML = '<span>⏳</span> Archiving...';
  btn.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TRIGGER_ARCHIVE' });
    if (response && response.success) { alert(`✅ Archive completed!\n\n${response.message}`); btn.innerHTML = '<span>✅</span> Archived'; }
    else { throw new Error((response && response.error) || 'Archive failed'); }
  } catch (e) {
    alert(`❌ Archive failed: ${e.message}`);
    btn.innerHTML = '<span>❌</span> Failed';
  } finally {
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 2000);
  }
}

async function testAI() {
  const testBtn = document.getElementById('testAIBtn');
  const statusDiv = document.getElementById('testAIStatus');
  const original = testBtn.innerHTML;
  testBtn.innerHTML = '<span>⏳</span> Testing...';
  testBtn.disabled = true;
  statusDiv.innerHTML = '';
  try {
    const aiConfig = {
      api_key: document.getElementById('apiKey').value.trim(),
      prefill_title: document.getElementById('prefillTitle').checked,
      prefill_category: document.getElementById('prefillCategory').checked,
      prefill_priority: document.getElementById('prefillPriority').checked,
      prefill_tags: document.getElementById('prefillTags').checked,
      prefill_summary: document.getElementById('prefillSummary').checked,
    };
    await chrome.storage.local.set({ [AI_OPTS_KEY]: aiConfig });

    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test request timed out after 15 seconds')), 15000);
      chrome.runtime.sendMessage({ type: 'TEST_AI' }, (resp) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    });

    if (response && response.success && response.suggestions) {
      const s = response.suggestions;
      const tags = s.tags ? s.tags.join(', ') : 'None';
      const summary = s.summary ? (s.summary.length > 120 ? s.summary.substring(0, 120) + '...' : s.summary) : 'None';
      statusDiv.innerHTML = `
        <div class="status success">
          <span>✅</span>
          <div>
            <strong>AI Test Successful!</strong>
            <div class="test-result">
              <strong>Sample Results:</strong>
              <small>
                <strong>Title:</strong> "${s.title}"<br>
                <strong>Category:</strong> ${s.category}<br>
                <strong>Priority:</strong> ${s.priority}<br>
                <strong>Tags:</strong> ${tags}<br>
                <strong>Summary:</strong> "${summary}"
              </small>
            </div>
          </div>
        </div>`;
    } else {
      throw new Error(response?.error || 'Test failed - invalid response from AI service');
    }
  } catch (e) {
    let helpText = '';
    if (e.message.includes('Missing API key') || e.message.includes('No API key')) helpText = 'Please enter a valid Gemini API key above and save the configuration.';
    else if (e.message.includes('HTTP 400')) helpText = 'Invalid API key. Please check your Gemini API key.';
    else if (e.message.includes('HTTP 403')) helpText = 'API key access denied. Please check your Gemini API key permissions.';
    else if (e.message.includes('timeout')) helpText = 'Request timed out. Please check your internet connection and try again.';
    else if (e.message.includes('No API key configured')) helpText = 'Please enter your Gemini API key above and save the configuration first.';
    statusDiv.innerHTML = `<div class="status error"><span>❌</span><div><strong>AI Test Failed</strong><div style="margin-top: 8px;">${e.message}</div>${helpText ? `<div class="help-text" style=\"margin-top: 12px;\">${helpText}</div>` : ''}</div></div>`;
  } finally {
    testBtn.innerHTML = original;
    testBtn.disabled = false;
  }
}

function showStatus(elementId, type, message) {
  const statusDiv = document.getElementById(elementId);
  const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
  statusDiv.innerHTML = `<div class="status ${type}"><span>${icon}</span> ${message}</div>`;
  if (type === 'success') setTimeout(() => { statusDiv.innerHTML = ''; }, 5000);
}

document.addEventListener('DOMContentLoaded', () => {
  // Attach handlers
  document.getElementById('saveBtn').addEventListener('click', saveAllConfig);
  document.getElementById('resetBtn').addEventListener('click', resetConfig);
  document.getElementById('testAIBtn').addEventListener('click', testAI);
  document.getElementById('testConnectionBtn').addEventListener('click', testConnection);
  document.getElementById('viewStatsBtn').addEventListener('click', viewStats);
  document.getElementById('triggerArchiveBtn').addEventListener('click', triggerArchive);

  // Checkbox wrappers
  document.querySelectorAll('.checkbox-item').forEach(item => {
    item.addEventListener('click', () => {
      const cb = item.querySelector('input[type="checkbox"]');
      if (!cb) return;
      cb.checked = !cb.checked;
      updateCheckboxUI();
    });
  });
  document.querySelectorAll('.checkbox-item input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('click', (e) => { e.stopPropagation(); setTimeout(updateCheckboxUI, 10); });
  });

  loadConfig();
});

const LS_KEY = "items";
const QUEUE_KEY = "outbox";
const OPTS_KEY = "options"; // { apps_script_url, autosync_mins }

function nowISO(){ return new Date().toISOString(); }

async function getLocal(key){ return (await chrome.storage.local.get([key]))[key]; }
async function setLocal(key, val){ return chrome.storage.local.set({[key]: val}); }

// Basic queue for pending upserts
const queueAdapter = {
  async enqueue(item) {
    const q = (await getLocal(QUEUE_KEY)) || [];
    q.push(item);
    await setLocal(QUEUE_KEY, q);
  },
  async takeBatch(n=25) {
    const q = (await getLocal(QUEUE_KEY)) || [];
    const batch = q.splice(0, n);
    await setLocal(QUEUE_KEY, q);
    return batch;
  },
  async size(){ const q = (await getLocal(QUEUE_KEY)) || []; return q.length; }
};

// Local adapter storing canonical list
const localAdapter = {
  async getAll(){
    return (await getLocal(LS_KEY)) || [];
  },
  async upsert(incoming){
    const items = (await getLocal(LS_KEY)) || [];
    const i = items.findIndex(x => x.id === incoming.id);
    if (i === -1) items.push(incoming);
    else if (!items[i].updated_at || items[i].updated_at <= incoming.updated_at) items[i] = incoming;
    await setLocal(LS_KEY, items);
  },
  async remove(id){
    const items = (await getLocal(LS_KEY)) || [];
    const next = items.filter(x => x.id !== id);
    await setLocal(LS_KEY, next);
  }
};

async function flushOnce(){
  const opts = (await getLocal(OPTS_KEY)) || {};
  const base = opts.apps_script_url;
  console.log('flushOnce: base URL:', base);
  
  if (!base) {
    console.log('flushOnce: No Apps Script URL configured');
    return;
  }
  
  const batch = await queueAdapter.takeBatch(100); // Increased batch size
  console.log('flushOnce: batch size:', batch.length);
  
  if (!batch.length) {
    console.log('flushOnce: No items in queue to sync');
    return;
  }

  try {
    // Split batch into deletes and upserts
    const deletes = batch.filter(x => x && x.op === 'delete' && x.id);
    const upserts = batch.filter(x => !x || x.op !== 'delete');

    if (deletes.length) {
      console.log('flushOnce: Sending deletes:', deletes.length);
      const delResp = await fetch(base + "?action=bulkDelete", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ ids: deletes.map(d => d.id) })
      });
      if (!delResp.ok) {
        const errorText = await delResp.text();
        console.log('flushOnce: Delete error response:', errorText);
        throw new Error("Delete HTTP " + delResp.status + ": " + errorText.substring(0, 200));
      }
      const delText = await delResp.text();
      console.log('flushOnce: Delete response text:', delText);
      try {
        JSON.parse(delText);
      } catch (e) {
        throw new Error("Invalid JSON response from bulkDelete");
      }
    }

    if (upserts.length) {
      console.log('flushOnce: Sending upserts:', upserts.length, 'to', base + "?action=bulkUpsert");
      const resp = await fetch(base + "?action=bulkUpsert", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ items: upserts })
      });
      console.log('flushOnce: Upsert response status:', resp.status);
      if (!resp.ok) {
        const errorText = await resp.text();
        console.log('flushOnce: Upsert error response:', errorText);
        throw new Error("HTTP " + resp.status + ": " + errorText.substring(0, 200));
      }
      const responseText = await resp.text();
      console.log('flushOnce: Upsert response text:', responseText);
      let result;
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        console.error('flushOnce: Failed to parse JSON:', responseText);
        console.error('flushOnce: Full response:', responseText);
        throw new Error("Invalid JSON response. Apps Script returned HTML instead of JSON. Check your deployment.");
      }
      console.log(`Synced ${result.upserted} items (${result.updated} updated, ${result.inserted} inserted)`);
    }
  } catch (e) {
    console.error("Sync failed:", e);
    // put items back if failed
    const q = (await getLocal(QUEUE_KEY)) || [];
    await setLocal(QUEUE_KEY, batch.concat(q));
    throw e;
  }
}

let syncing = false;
async function syncLoop(){
  if (syncing) return;
  syncing = true;
  try {
    for (let i=0; i<5; i++) { // up to 5 batches per run
      const size = await queueAdapter.size();
      if (!size) break;
      await flushOnce();
    }
  } finally { syncing = false; }
}

// Reminder notification handler
async function handleReminderAlarm(alarmName) {
  if (!alarmName.startsWith('reminder_')) return;
  
  const itemId = alarmName.replace('reminder_', '');
  const items = await localAdapter.getAll();
  const item = items.find(x => x.id === itemId);
  
  if (!item) {
    console.log('Reminder alarm fired but item not found:', itemId);
    return;
  }
  
  // Create notification
  const notificationOptions = {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: '📚 Universal Tracker Reminder',
    message: `Don't forget: ${item.title}`,
    contextMessage: `${item.category}${item.priority === 'high' ? ' • High Priority' : ''}`,
    buttons: [
      { title: 'Mark as Done' },
      { title: 'Snooze (1 hour)' }
    ],
    requireInteraction: true
  };
  
  chrome.notifications.create(`reminder_${itemId}`, notificationOptions);
  
  console.log('Reminder notification created for:', item.title);
}

// Handle notification button clicks
chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  if (!notificationId.startsWith('reminder_')) return;
  
  const itemId = notificationId.replace('reminder_', '');
  const items = await localAdapter.getAll();
  const item = items.find(x => x.id === itemId);
  
  if (!item) return;
  
  if (buttonIndex === 0) { // Mark as Done
    item.status = 'done';
    item.completed_at = nowISO();
    item.updated_at = nowISO();
    item.reminder_time = null; // Clear reminder
    
    await localAdapter.upsert(item);
    await queueAdapter.enqueue(item);
    
    chrome.notifications.clear(notificationId);
    
    // Show success notification
    chrome.notifications.create(`done_${itemId}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '✅ Item Completed',
      message: `"${item.title}" marked as done!`,
    });
    
    // Clear the success notification after 3 seconds
    setTimeout(() => {
      chrome.notifications.clear(`done_${itemId}`);
    }, 3000);
    
  } else if (buttonIndex === 1) { // Snooze
    const snoozeTime = new Date();
    snoozeTime.setHours(snoozeTime.getHours() + 1); // Snooze for 1 hour
    
    item.reminder_time = snoozeTime.toISOString();
    item.updated_at = nowISO();
    
    await localAdapter.upsert(item);
    await queueAdapter.enqueue(item);
    
    // Schedule new reminder
    chrome.alarms.create(`reminder_${itemId}`, {
      when: snoozeTime.getTime()
    });
    
    chrome.notifications.clear(notificationId);
    
    // Show snooze notification
    chrome.notifications.create(`snooze_${itemId}`, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '⏰ Reminder Snoozed',
      message: `"${item.title}" reminder set for 1 hour`,
    });
    
    // Clear the snooze notification after 3 seconds
    setTimeout(() => {
      chrome.notifications.clear(`snooze_${itemId}`);
    }, 3000);
  }
});

// Clear notification on click
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
});

// messages from popup - FIXED: Return true and use async sendResponse properly
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('Background received message:', msg);
  
  if (msg?.type === "TEST") {
    console.log('TEST: Sending test response');
    sendResponse({success: true, message: "Test successful"});
  } else if (msg?.type === "SYNC_NOW") {
    (async () => {
      try { 
        console.log('SYNC_NOW: Starting sync...');
        await syncLoop(); 
        console.log('SYNC_NOW: Sync completed successfully');
        sendResponse({success: true});
      } catch(e) {
        console.log('SYNC_NOW: Sync failed:', e.message);
        sendResponse({success: false, error: e.message});
      }
    })();
  } else if (msg?.type === "TRIGGER_ARCHIVE") {
    (async () => {
      try {
        const opts = (await getLocal(OPTS_KEY)) || {};
        const base = opts.apps_script_url;
        if (!base) {
          sendResponse({success: false, error: "No Apps Script URL configured"});
          return;
        }
        
        const resp = await fetch(base + "?action=triggerArchive", {
          method: "POST",
          headers: {"Content-Type":"application/json"}
        });
        
        if (!resp.ok) {
          const errorText = await resp.text();
        console.log('TRIGGER_ARCHIVE: Error response:', errorText);
        throw new Error("HTTP " + resp.status + ": " + errorText.substring(0, 200));
        }
        
        const responseText = await resp.text();
        console.log('TRIGGER_ARCHIVE: Response text:', responseText);
        
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (e) {
          console.error('TRIGGER_ARCHIVE: Failed to parse JSON:', responseText);
          console.error('TRIGGER_ARCHIVE: Full response:', responseText);
          throw new Error("Invalid JSON response. Apps Script returned HTML instead of JSON. Check your deployment.");
        }
        
        sendResponse({success: true, message: result.message});
      } catch(e) {
        sendResponse({success: false, error: e.message});
      }
    })();
  } else if (msg?.type === "GET_STATS") {
    (async () => {
      try {
        console.log('GET_STATS: Starting request...');
        const opts = (await getLocal(OPTS_KEY)) || {};
        const base = opts.apps_script_url;
        if (!base) {
          console.log('GET_STATS: No Apps Script URL configured');
          sendResponse({success: false, error: "No Apps Script URL configured"});
          return;
        }
        
        console.log('GET_STATS: Fetching from:', base + "?action=getStats");
        const resp = await fetch(base + "?action=getStats", {
          method: "GET"
        });
        
        if (!resp.ok) {
          const errorText = await resp.text();
          console.log('GET_STATS: Error response:', errorText);
          throw new Error("HTTP " + resp.status + ": " + errorText.substring(0, 200));
        }
        
        const responseText = await resp.text();
        console.log('GET_STATS: Response text:', responseText);
        
        let result;
        try {
          result = JSON.parse(responseText);
        } catch (e) {
          console.error('GET_STATS: Failed to parse JSON:', responseText);
          console.error('GET_STATS: Full response:', responseText);
          throw new Error("Invalid JSON response. Apps Script returned HTML instead of JSON. Check your deployment.");
        }
        
        console.log('GET_STATS: Sending response:', {success: true, stats: result});
        sendResponse({success: true, stats: result});
      } catch(e) {
        console.log('GET_STATS: Error occurred:', e.message);
        sendResponse({success: false, error: e.message});
      }
    })();
  } else if (msg?.type === "UPSERT_ITEM") {
    // not used in this scaffold (popup writes to local + queue directly)
  } else if (msg?.type === "PULL_ALL") {
    (async () => {
      try {
        const opts = (await getLocal(OPTS_KEY)) || {};
        const base = opts.apps_script_url;
        if (!base) { sendResponse({success:false, error:"No Apps Script URL configured"}); return; }
        let offset = 0; const limit = 1000; let all = [];
        for (let i=0; i<10; i++) {
          const resp = await fetch(`${base}?limit=${limit}&offset=${offset}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const txt = await resp.text();
          let data; try { data = JSON.parse(txt); } catch { throw new Error('Invalid JSON from getItems'); }
          const items = Array.isArray(data.items) ? data.items : [];
          all = all.concat(items);
          if (items.length < limit) break;
          offset += limit;
        }
        await setLocal(LS_KEY, all);
        sendResponse({success: true, count: all.length});
      } catch(e) {
        sendResponse({success:false, error:e.message});
      }
    })();
  } else if (msg?.type === 'AI_SUGGEST') {
    (async()=>{
      try {
        console.log('AI_SUGGEST: Processing request with meta:', msg.meta);
        const opts = (await getLocal(AI_OPTS_KEY)) || {};
        if (!opts.api_key) { 
          console.log('AI_SUGGEST: No API key configured');
          sendResponse({ success:false, error:'No API key configured' }); 
          return; 
        }
        const suggestions = await fetchAISuggestions(msg.meta||{});
        console.log('AI_SUGGEST: Generated suggestions:', suggestions);
        sendResponse({ success:true, suggestions });
      } catch(e){ 
        console.log('AI_SUGGEST: Error occurred:', e.message);
        sendResponse({ success:false, error: e.message }); 
      }
    })();
  } else if (msg?.type === 'TEST_AI') {
    (async()=>{
      try {
        console.log('TEST_AI: Testing AI functionality');
        const suggestions = await fetchAISuggestions({ 
          title:'Example: The Pragmatic Programmer book', 
          siteName:'example.com', 
          rawUrl:'https://example.com', 
          description:'A classic software engineering book.' 
        });
        console.log('TEST_AI: Test suggestions:', suggestions);
        sendResponse({ success:true, suggestions });
      } catch(e){ 
        console.log('TEST_AI: Error occurred:', e.message);
        sendResponse({ success:false, error:e.message }); 
      }
    })();
  }
  
  return true; // Keep message channel open for async response
});

// Deferred enrichment using external providers (TMDb) when configured
async function enrichWithTMDb(item) {
  try {
    const ai = (await chrome.storage.local.get(['ai_options'])).ai_options || {};
    const tmdbKey = ai.tmdb_api_key || '';
    const country = (ai.jw_country || 'US').toUpperCase();
    if (!tmdbKey) return { genre: null, streamingAvailability: null };

    const title = item.title || '';
    if (!title) return { genre: null, streamingAvailability: null };

    const q = encodeURIComponent(title.replace(/\s+\([^\)]*\)$/,''));
    const searchUrl = `https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&query=${q}&include_adult=false`;
    const sResp = await fetch(searchUrl);
    if (!sResp.ok) return { genre: null, streamingAvailability: null };
    const sJson = await sResp.json();
    const first = (sJson && Array.isArray(sJson.results) && sJson.results[0]) || null;
    if (!first) return { genre: null, streamingAvailability: null };
    const mediaType = first.media_type === 'tv' ? 'tv' : (first.media_type === 'movie' ? 'movie' : null);
    const id = first.id;
    if (!mediaType || !id) return { genre: null, streamingAvailability: null };

    const detailUrl = `https://api.themoviedb.org/3/${mediaType}/${id}?api_key=${tmdbKey}&append_to_response=watch/providers`;
    const dResp = await fetch(detailUrl);
    if (!dResp.ok) return { genre: null, streamingAvailability: null };
    const dJson = await dResp.json();

    const genres = Array.isArray(dJson.genres) ? dJson.genres.map(g=>g.name).filter(Boolean) : [];
    let providers = [];
    try {
      const prov = dJson["watch/providers"]?.results?.[country];
      const lists = [prov?.flatrate, prov?.ads, prov?.free, prov?.rent, prov?.buy].filter(Array.isArray);
      providers = lists.flat().map(p=>p.provider_name).filter(Boolean);
    } catch {}

    return {
      genre: genres.join(', ') || null,
      streamingAvailability: providers.length ? providers.join(', ') : null
    };
  } catch {
    return { genre: null, streamingAvailability: null };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ENRICH_ITEM') {
    (async()=>{
      try{
        const items = await localAdapter.getAll();
        const it = items.find(x => x.id === msg.id);
        if (!it) { sendResponse({success:false, error:'Item not found'}); return; }
        const tmdb = await enrichWithTMDb(it);
        sendResponse({success:true, suggestions:{ genre: tmdb.genre, streaming_availability: tmdb.streamingAvailability }});
      }catch(e){ sendResponse({success:false, error:e.message}); }
    })();
    return true;
  } else if (msg?.type === 'APPLY_ENRICHMENT') {
    (async()=>{
      try{
        const items = await localAdapter.getAll();
        const idx = items.findIndex(x => x.id === msg.id);
        if (idx === -1) { sendResponse({success:false, error:'Item not found'}); return; }
        const it = items[idx];
        const updates = {};
        if (typeof msg.fields?.genre === 'string' && msg.fields.genre.trim()) updates.genre = msg.fields.genre.trim();
        if (typeof msg.fields?.streaming_availability === 'string' && msg.fields.streaming_availability.trim()) updates.streaming_availability = msg.fields.streaming_availability.trim();
        const merged = { ...it, ...updates, updated_at: nowISO() };
        await localAdapter.upsert(merged);
        await queueAdapter.enqueue(merged);
        sendResponse({success:true});
      }catch(e){ sendResponse({success:false, error:e.message}); }
    })();
    return true;
  }
});

// FIXED: Auto-sync alarm handling with proper error handling and config check
chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('Alarm triggered:', alarm.name);
  
  // Handle reminder alarms
  if (alarm.name.startsWith('reminder_')) {
    await handleReminderAlarm(alarm.name);
    return;
  }
  
  // Handle auto-sync alarm
  if (alarm.name === "autosync") {
    try { 
      console.log('Auto-sync triggered by alarm');
      
      // Check if Apps Script URL is configured before trying to sync
      const opts = (await getLocal(OPTS_KEY)) || {};
      if (!opts.apps_script_url) {
        console.log('Auto-sync skipped: No Apps Script URL configured');
        return;
      }
      
      await syncLoop(); 
      console.log('Auto-sync completed');
    } catch(e) {
      console.log('Auto-sync failed:', e.message);
    }
  }
});

// FIXED: Proper alarm setup on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed/updated');
  await setupAutoSync();
  await rescheduleReminders(); // Reschedule existing reminders
  try { await chrome.action.setBadgeText({ text: 'AI' }); await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' }); } catch {}
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('Extension started');
  await setupAutoSync();
  await rescheduleReminders(); // Reschedule existing reminders
  try { await chrome.action.setBadgeText({ text: 'AI' }); await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' }); } catch {}
});

async function setupAutoSync() {
  const opts = (await getLocal(OPTS_KEY)) || { autosync_mins: 10 };
  await setLocal(OPTS_KEY, opts);
  
  // Clear existing alarm first
  await chrome.alarms.clear("autosync");
  
  const interval = Math.max(5, Number(opts.autosync_mins||10));
  console.log('Setting up autosync alarm with interval:', interval, 'minutes');
  
  // Create alarm with proper periodInMinutes
  await chrome.alarms.create("autosync", { 
    periodInMinutes: interval,
    delayInMinutes: interval // Start first sync after interval
  });
  
  // Verify alarm was created
  const alarm = await chrome.alarms.get("autosync");
  if (alarm) {
    console.log('Autosync alarm created successfully:', alarm);
  } else {
    console.error('Failed to create autosync alarm');
  }
}

// Reschedule reminders after browser restart
async function rescheduleReminders() {
  console.log('Rescheduling reminders...');
  const items = await localAdapter.getAll();
  let rescheduledCount = 0;
  
  for (const item of items) {
    if (item.reminder_time) {
      const reminderTime = new Date(item.reminder_time);
      const now = new Date();
      
      // Only reschedule future reminders
      if (reminderTime > now) {
        chrome.alarms.create(`reminder_${item.id}`, {
          when: reminderTime.getTime()
        });
        rescheduledCount++;
      }
    }
  }
  
  console.log(`Rescheduled ${rescheduledCount} reminders`);
}

// ===== AI integration (improved) =====
const AI_OPTS_KEY = "ai_options"; // { api_key, prefill_title, prefill_category, prefill_priority, prefill_tags, prefill_summary }
const AI_CATEGORY_OPTIONS = ["Movie","TV","Trailer","Video","Blog","Podcast","Book","Course","Game","Other"];
const AI_PRIORITY_OPTIONS = ["low","medium","high"];

function withTimeout(promise, ms){
  return new Promise((resolve, reject) => {
    const t = setTimeout(()=>reject(new Error('AI timeout')), ms);
    promise.then(v=>{clearTimeout(t); resolve(v)}).catch(e=>{clearTimeout(t); reject(e)});
  });
}

function cleanAITitle(title, meta) {
  if (!title || typeof title !== 'string') {
    return meta?.title || '';
  }
  
  // Remove common prefixes like (21), [HD], etc.
  let cleaned = title.replace(/^\(?\d+\)?\s*/, '').trim();
  cleaned = cleaned.replace(/^\[([^\]]+)\]\s*/, '').trim();
  
  // Remove platform suffixes
  const platformSuffixes = [
    '- YouTube', '- Netflix', '- Prime Video', '- Disney+', 
    '- Hulu', '- HBO Max', '- Apple TV+', '- Paramount+',
    '| IMDb', '| Amazon', '| Hotstar'
  ];
  
  for (const suffix of platformSuffixes) {
    if (cleaned.endsWith(suffix)) {
      cleaned = cleaned.slice(0, -suffix.length).trim();
      break;
    }
  }
  
  return cleaned || meta?.title || '';
}

function inferCategoryFromContent(meta) {
  const { title = '', siteName = '', rawUrl = '', description = '' } = meta;
  const content = `${title} ${siteName} ${rawUrl} ${description}`.toLowerCase();
  
  // Movie/TV patterns
  if (content.includes('imdb') || content.includes('movie') || content.includes('film')) {
    if (content.includes('series') || content.includes('episode') || content.includes('season')) {
      return 'TV';
    }
    return 'Movie';
  }
  
  // Video platforms
  if (content.includes('youtube') || content.includes('vimeo') || content.includes('twitch')) {
    if (content.includes('trailer')) return 'Trailer';
    return 'Video';
  }
  
  // Streaming platforms for TV/Movies
  if (content.includes('netflix') || content.includes('hulu') || content.includes('disney') || 
      content.includes('prime') || content.includes('hbo')) {
    if (content.includes('movie') || content.includes('film')) return 'Movie';
    if (content.includes('series') || content.includes('show') || content.includes('episode')) return 'TV';
    return 'Video';
  }
  
  // Blog platforms
  if (content.includes('medium') || content.includes('blog') || content.includes('substack') ||
      content.includes('wordpress') || content.includes('dev.to')) {
    return 'Blog';
  }
  
  // Course platforms
  if (content.includes('udemy') || content.includes('coursera') || content.includes('edx') ||
      content.includes('course') || content.includes('tutorial') || content.includes('learn')) {
    return 'Course';
  }
  
  // Podcast platforms
  if (content.includes('spotify') || content.includes('podcast') || content.includes('apple podcast')) {
    return 'Podcast';
  }
  
  // Book platforms
  if (content.includes('amazon') && (content.includes('book') || content.includes('kindle')) ||
      content.includes('goodreads') || content.includes('audible')) {
    return 'Book';
  }
  
  // Game platforms
  if (content.includes('steam') || content.includes('epic games') || content.includes('game')) {
    return 'Game';
  }
  
  return 'Other';
}

function inferPriorityFromContent(meta) {
  const { title = '', description = '', rawUrl = '' } = meta;
  const content = `${title} ${description} ${rawUrl}`.toLowerCase();
  
  // High priority indicators
  const highPriorityKeywords = [
    'urgent', 'important', 'deadline', 'breaking', 'trending', 'hot', 
    'must watch', 'must read', 'limited time', 'exclusive', 'new release',
    'just released', 'premiere', 'launch'
  ];
  
  // Low priority indicators  
  const lowPriorityKeywords = [
    'archive', 'reference', 'documentation', 'old', 'classic', 
    'maybe', 'someday', 'when free', 'leisure', 'optional'
  ];
  
  if (highPriorityKeywords.some(keyword => content.includes(keyword))) {
    return 'high';
  }
  
  if (lowPriorityKeywords.some(keyword => content.includes(keyword))) {
    return 'low';
  }
  
  return 'medium';
}

function extractTagsFromContent(meta) {
  const { title = '', description = '', siteName = '' } = meta;
  const content = `${title} ${description}`.toLowerCase();
  
  const commonTags = [];
  
  // Platform tags
  if (siteName.includes('youtube')) commonTags.push('youtube');
  if (siteName.includes('netflix')) commonTags.push('netflix');
  if (siteName.includes('amazon')) commonTags.push('amazon');
  if (siteName.includes('medium')) commonTags.push('blog');
  
  // Genre/type tags from content
  const genreKeywords = {
    'action': ['action', 'fight', 'adventure'],
    'comedy': ['comedy', 'funny', 'humor'],
    'drama': ['drama', 'emotional'],
    'horror': ['horror', 'scary', 'thriller'],
    'documentary': ['documentary', 'real story', 'true story'],
    'tutorial': ['tutorial', 'how to', 'guide', 'learn'],
    'review': ['review', 'opinion', 'thoughts'],
    'tech': ['technology', 'programming', 'coding', 'software'],
    'business': ['business', 'startup', 'entrepreneur'],
    'science': ['science', 'research', 'study']
  };
  
  for (const [tag, keywords] of Object.entries(genreKeywords)) {
    if (keywords.some(keyword => content.includes(keyword))) {
      commonTags.push(tag);
      if (commonTags.length >= 3) break; // Limit to 3 tags
    }
  }
  
  return commonTags.slice(0, 3);
}

async function fetchAISuggestions(meta){
  console.log('fetchAISuggestions called with meta:', meta);
  
  const opts = (await getLocal(AI_OPTS_KEY)) || {};
  if (!opts.api_key) {
    console.log('No API key found');
    throw new Error('Missing API key');
  }
  
  // Enhanced prompt with better instructions
  const prompt = `Analyze this webpage and return ONLY a valid JSON object with these exact keys:
{
  "title": "cleaned title without counters or platform names",
  "category": "one of: Movie, TV, Trailer, Video, Blog, Podcast, Book, Course, Game, Other",
  "priority": "one of: low, medium, high",
  "tags": ["up to 3 relevant lowercase tags"],
  "summary": "concise 1-2 sentence summary under 280 characters"
}

Webpage data:
Title: ${meta.title || ''}
Website: ${meta.siteName || ''}
URL: ${meta.rawUrl || ''}
Description: ${meta.description || ''}

Rules:
- Clean title: remove "(21)" style counters, platform suffixes like "- YouTube"  
- Category: choose based on content type, prefer Movie/TV for entertainment content
- Priority: high for new/trending/urgent content, low for reference/archive, medium otherwise
- Tags: relevant keywords, no duplicates, lowercase only
- Summary: complete sentences with proper punctuation, never cut mid-sentence`;

  const payload = {
    contents: [{
      role: 'user',
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.1, // Lower temperature for more consistent results
      responseMimeType: 'application/json'
    }
  };
  
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=' + encodeURIComponent(opts.api_key);
  
  try {
    console.log('Making API request to Gemini...');
    const resp = await withTimeout(fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }), 10000); // Increased timeout
    
    if (!resp.ok) {
      const errorText = await resp.text();
      console.log('API error response:', errorText);
      throw new Error(`HTTP ${resp.status}: ${errorText}`);
    }
    
    const data = await resp.json();
    console.log('API response data:', data);
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content || !data.candidates[0].content.parts || !data.candidates[0].content.parts[0]) {
      console.log('Invalid API response structure:', data);
      throw new Error('Invalid API response structure');
    }
    
    const textResp = data.candidates[0].content.parts[0].text || '';
    console.log('Raw AI response:', textResp);
    
    if (!textResp) {
      throw new Error('Empty AI response');
    }
    
    let parsed;
    try { 
      parsed = JSON.parse(textResp); 
      console.log('Parsed AI response:', parsed);
    } catch (parseError) { 
      console.log('JSON parse error:', parseError, 'Raw text:', textResp);
      // Fallback to rule-based suggestions
      return createFallbackSuggestions(meta);
    }
    
    // Validate and clean the response
    const result = {
      title: cleanAITitle(parsed.title, meta),
      category: AI_CATEGORY_OPTIONS.includes(parsed.category) ? parsed.category : inferCategoryFromContent(meta),
      priority: AI_PRIORITY_OPTIONS.includes(parsed.priority) ? parsed.priority : inferPriorityFromContent(meta),
      tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 3).map(t => String(t).toLowerCase().trim()).filter(Boolean) : extractTagsFromContent(meta),
      summary: cleanSummary(parsed.summary) || generateFallbackSummary(meta)
    };
    
    console.log('Final processed suggestions:', result);
    return result;
    
  } catch (error) {
    console.log('API request failed:', error);
    // Return rule-based fallback
    return createFallbackSuggestions(meta);
  }
}

function cleanSummary(summary) {
  if (!summary || typeof summary !== 'string') return '';
  
  let cleaned = summary.replace(/\s+/g, ' ').trim();
  
  // Ensure it's under 280 characters
  if (cleaned.length > 280) {
    const sentences = cleaned.split(/[.!?]+/);
    let result = '';
    
    for (const sentence of sentences) {
      const potential = result + sentence.trim() + '.';
      if (potential.length <= 280) {
        result = potential;
      } else {
        break;
      }
    }
    
    if (result.length < 50 && cleaned.length > 50) {
      // If we got too short, just truncate
      result = cleaned.substring(0, 277) + '...';
    }
    
    cleaned = result;
  }
  
  // Ensure proper punctuation
  if (cleaned && !/[.!?]$/.test(cleaned)) {
    cleaned += '.';
  }
  
  return cleaned;
}

function generateFallbackSummary(meta) {
  const { title, description, siteName } = meta;
  
  if (description && description.length > 10) {
    return cleanSummary(description);
  }
  
  if (title && siteName) {
    return `${title} from ${siteName}.`;
  }
  
  if (title) {
    return `Content: ${title}.`;
  }
  
  return 'Saved content for later review.';
}

function createFallbackSuggestions(meta) {
  console.log('Creating fallback suggestions for meta:', meta);
  
  const result = {
    title: cleanAITitle(meta.title, meta),
    category: inferCategoryFromContent(meta),
    priority: inferPriorityFromContent(meta),
    tags: extractTagsFromContent(meta),
    summary: generateFallbackSummary(meta)
  };
  
  console.log('Fallback suggestions created:', result);
  return result;
}

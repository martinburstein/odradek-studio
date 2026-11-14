// Navigation only. The original Manual and Sync modules own every control.
for(const link of document.querySelectorAll('[data-studio-tab]'))link.addEventListener('click',event=>{event.preventDefault();parent.postMessage({studioTab:link.dataset.studioTab},'http://127.0.0.1:8790');});

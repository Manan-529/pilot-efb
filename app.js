(function () {
    const SIZES = [1, 2, 4, 6];
    const THEMES = {
        dark: { bg: '#1a2332', grid: '#2a3a4a', label: '#8899aa', helper: '#556677', ink: '#ffffff' },
        light: { bg: '#ffffff', grid: '#cccccc', label: '#555555', helper: '#999999', ink: '#000000' }
    };

    let activeMode = 'atis';
    let scratchpadTheme = 'dark';
    let currentAirport = null; // null = showing airport list, string = inside a folder

    let atisState = { pages: [], activePageId: null, settings: { penSize: 2, activeTool: 'pen' } };
    let scratchpadState = { pages: [], activePageId: null, settings: { penSize: 2, activeTool: 'pen' } };

    let strokes = [];
    let redoStack = [];
    let isDrawing = false;
    let currentStroke = null;
    let activePointerId = null;
    let penPointerActive = false;
    let saveTimeout = null;
    let db = null;

    const templateCanvas = document.getElementById('template-canvas');
    const drawingCanvas = document.getElementById('drawing-canvas');
    const templateCtx = templateCanvas.getContext('2d');
    const drawCtx = drawingCanvas.getContext('2d');
    const container = document.getElementById('canvas-container');

    let currentAircraft = null;

    // ===== Bundled Assets =====
    let bundledAssets = null;

    async function loadBundledAssets() {
        if (bundledAssets) return bundledAssets;
        try {
            const resp = await fetch('./assets/manifest.json', { cache: 'no-store' });
            if (!resp.ok) throw new Error('No manifest');
            bundledAssets = await resp.json();
        } catch (e) {
            bundledAssets = { diagrams: {}, documents: [], checklists: {} };
        }
        return bundledAssets;
    }

    function getBundledFileUrl(category, folder, filename) {
        if (folder) return './assets/' + category + '/' + folder + '/' + filename;
        return './assets/' + category + '/' + filename;
    }

    // ===== IndexedDB =====
    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('pilot-efb-v3', 1);
            req.onupgradeneeded = (e) => {
                const database = e.target.result;
                if (!database.objectStoreNames.contains('diagrams')) {
                    const store = database.createObjectStore('diagrams', { keyPath: 'id' });
                    store.createIndex('airport', 'airport', { unique: false });
                }
                if (!database.objectStoreNames.contains('documents')) {
                    database.createObjectStore('documents', { keyPath: 'id' });
                }
                if (!database.objectStoreNames.contains('checklists')) {
                    const store = database.createObjectStore('checklists', { keyPath: 'id' });
                    store.createIndex('aircraft', 'aircraft', { unique: false });
                }
            };
            req.onsuccess = (e) => { db = e.target.result; resolve(db); };
            req.onerror = (e) => { console.error('DB open error:', e.target.error); reject(e.target.error); };
            req.onblocked = () => { console.warn('DB blocked - close other tabs'); };
        });
    }

    let dbReady = null;

    function ensureDB() {
        if (db) return Promise.resolve(db);
        if (!dbReady) dbReady = openDB();
        return dbReady;
    }

    function dbGetAll(storeName) {
        return ensureDB().then(() => new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readonly');
                const req = tx.objectStore(storeName).getAll();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            } catch (e) { resolve([]); }
        })).catch(() => []);
    }

    function dbPut(storeName, item) {
        return ensureDB().then(() => new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                const req = tx.objectStore(storeName).put(item);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        }));
    }

    function dbDelete(storeName, id) {
        return ensureDB().then(() => new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(storeName, 'readwrite');
                const req = tx.objectStore(storeName).delete(id);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            } catch (e) { reject(e); }
        }));
    }

    function fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
    }

    // ===== Diagrams (airport folders) =====
    async function getAirports() {
        const all = await dbGetAll('diagrams');
        const airports = {};
        all.forEach(d => {
            if (!airports[d.airport]) airports[d.airport] = [];
            airports[d.airport].push(d);
        });
        return airports;
    }

    function addAirport() {
        const name = prompt('Enter airport ICAO code (e.g. KJFK):');
        if (!name || !name.trim()) return;
        const code = name.trim().toUpperCase();
        localStorage.setItem('pilot-efb-airports', JSON.stringify(
            [...new Set([...(JSON.parse(localStorage.getItem('pilot-efb-airports') || '[]')), code])]
        ));
        renderDiagramsView();
    }

    async function deleteAirport(code) {
        if (!confirm('Delete airport "' + code + '" and all its diagrams?')) return;
        const all = await dbGetAll('diagrams');
        const toDelete = all.filter(d => d.airport === code);
        for (const d of toDelete) await dbDelete('diagrams', d.id);
        const airports = JSON.parse(localStorage.getItem('pilot-efb-airports') || '[]').filter(a => a !== code);
        localStorage.setItem('pilot-efb-airports', JSON.stringify(airports));
        renderDiagramsView();
    }

    async function uploadDiagram(files) {
        if (!currentAirport) {
            const name = prompt('Enter airport ICAO code for these diagrams:');
            if (!name || !name.trim()) return;
            currentAirport = name.trim().toUpperCase();
            const airports = JSON.parse(localStorage.getItem('pilot-efb-airports') || '[]');
            if (!airports.includes(currentAirport)) {
                airports.push(currentAirport);
                localStorage.setItem('pilot-efb-airports', JSON.stringify(airports));
            }
        }
        for (const file of files) {
            if (!file.type.startsWith('image/') && file.type !== 'application/pdf') continue;
            const dataUrl = await fileToDataURL(file);
            await dbPut('diagrams', {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                airport: currentAirport,
                name: file.name,
                type: file.type,
                dataUrl: dataUrl,
                addedAt: Date.now()
            });
        }
        renderDiagramsView();
    }

    async function renderDiagramsView() {
        const grid = document.getElementById('diagrams-grid');
        const title = document.getElementById('diagrams-title');
        const backBtn = document.getElementById('btn-back-airports');
        const uploadBtn = document.getElementById('btn-upload-diagram');
        const addBtn = document.getElementById('btn-add-airport');
        const assets = await loadBundledAssets();

        if (!currentAirport) {
            backBtn.style.display = 'none';
            uploadBtn.style.display = 'none';
            addBtn.style.display = 'flex';
            title.textContent = 'Airports';

            const userAirports = JSON.parse(localStorage.getItem('pilot-efb-airports') || '[]');
            const bundledAirports = Object.keys(assets.diagrams || {});
            const allAirportCodes = [...new Set([...bundledAirports, ...userAirports])];
            const allDiagrams = await dbGetAll('diagrams');
            const counts = {};
            allDiagrams.forEach(d => { counts[d.airport] = (counts[d.airport] || 0) + 1; });
            bundledAirports.forEach(code => {
                counts[code] = (counts[code] || 0) + (assets.diagrams[code] || []).length;
            });

            grid.innerHTML = '';
            if (allAirportCodes.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#556677; padding:40px;">No airports added yet. Tap "Add Airport" to create a folder.</div>';
                return;
            }

            allAirportCodes.sort().forEach(code => {
                const isBundled = bundledAirports.includes(code) && !userAirports.includes(code);
                const folder = document.createElement('div');
                folder.className = 'airport-folder';

                const nameEl = document.createElement('div');
                nameEl.className = 'airport-folder-name';
                nameEl.textContent = code;

                const countEl = document.createElement('div');
                countEl.className = 'airport-folder-count';
                countEl.textContent = (counts[code] || 0) + ' diagram' + ((counts[code] || 0) !== 1 ? 's' : '');

                folder.appendChild(nameEl);
                folder.appendChild(countEl);

                if (!isBundled) {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'airport-folder-delete';
                    delBtn.innerHTML = '&times;';
                    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteAirport(code); });
                    folder.appendChild(delBtn);
                }

                folder.addEventListener('click', () => { currentAirport = code; renderDiagramsView(); });
                grid.appendChild(folder);
            });
        } else {
            backBtn.style.display = 'flex';
            uploadBtn.style.display = 'flex';
            addBtn.style.display = 'none';
            title.textContent = currentAirport;

            const all = await dbGetAll('diagrams');
            const userDiagrams = all.filter(d => d.airport === currentAirport).sort((a, b) => b.addedAt - a.addedAt);
            const bundledFiles = (assets.diagrams[currentAirport] || []).map(f => ({
                name: f,
                url: getBundledFileUrl('diagrams', currentAirport, f),
                type: f.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image',
                bundled: true
            }));

            grid.innerHTML = '';
            const allItems = [...bundledFiles, ...userDiagrams];
            if (allItems.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#556677; padding:40px;">No diagrams yet. Tap Upload to add.</div>';
                return;
            }

            allItems.forEach(d => {
                const card = document.createElement('div');
                card.className = 'file-card';
                const isPDF = d.bundled
                    ? d.type === 'application/pdf'
                    : (d.type === 'application/pdf' || d.name.toLowerCase().endsWith('.pdf'));

                if (isPDF) {
                    const thumb = document.createElement('div');
                    thumb.style.cssText = 'width:100%; aspect-ratio:3/4; display:flex; align-items:center; justify-content:center; background:#1e2d3d;';
                    thumb.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cc4444" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="7" y="17" font-size="5" fill="#cc4444" stroke="none" font-weight="bold">PDF</text></svg>';
                    card.appendChild(thumb);
                } else {
                    const img = document.createElement('img');
                    img.src = d.bundled ? d.url : d.dataUrl;
                    img.alt = d.name;
                    card.appendChild(img);
                }

                const label = document.createElement('div');
                label.className = 'file-card-label';
                label.textContent = d.name + (d.bundled ? ' \u{1F4CC}' : '');

                card.appendChild(label);

                if (!d.bundled) {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'file-card-delete';
                    delBtn.innerHTML = '&times;';
                    delBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (confirm('Delete "' + d.name + '"?')) {
                            await dbDelete('diagrams', d.id);
                            renderDiagramsView();
                        }
                    });
                    card.appendChild(delBtn);
                }

                card.addEventListener('click', () => openViewer(d.bundled ? d.url : d.dataUrl, d.name, isPDF));
                grid.appendChild(card);
            });
        }
    }

    // ===== Documents (flat list) =====
    async function uploadDoc(files) {
        for (const file of files) {
            if (!file.type.startsWith('image/') && file.type !== 'application/pdf') continue;
            const dataUrl = await fileToDataURL(file);
            await dbPut('documents', {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                name: file.name,
                type: file.type,
                dataUrl: dataUrl,
                addedAt: Date.now()
            });
        }
        renderDocsGrid();
    }

    async function renderDocsGrid() {
        const grid = document.getElementById('documents-grid');
        const assets = await loadBundledAssets();
        const docs = await dbGetAll('documents');
        docs.sort((a, b) => b.addedAt - a.addedAt);

        const bundledDocs = (assets.documents || []).map(f => ({
            name: f,
            url: getBundledFileUrl('documents', null, f),
            type: f.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image',
            bundled: true
        }));

        const allDocs = [...bundledDocs, ...docs];

        grid.innerHTML = '';
        if (allDocs.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#556677; padding:40px;">No documents uploaded yet. Tap Upload to add PDFs or images.</div>';
            return;
        }

        allDocs.forEach(d => {
            const card = document.createElement('div');
            card.className = 'file-card';
            const isPDF = d.bundled
                ? d.type === 'application/pdf'
                : (d.type === 'application/pdf' || d.name.toLowerCase().endsWith('.pdf'));

            if (isPDF) {
                const thumb = document.createElement('div');
                thumb.style.cssText = 'width:100%; aspect-ratio:3/4; display:flex; align-items:center; justify-content:center; background:#1e2d3d;';
                thumb.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cc4444" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="7" y="17" font-size="5" fill="#cc4444" stroke="none" font-weight="bold">PDF</text></svg>';
                card.appendChild(thumb);
            } else {
                const img = document.createElement('img');
                img.src = d.bundled ? d.url : d.dataUrl;
                img.alt = d.name;
                card.appendChild(img);
            }

            const label = document.createElement('div');
            label.className = 'file-card-label';
            label.textContent = d.name + (d.bundled ? ' \u{1F4CC}' : '');

            card.appendChild(label);

            if (!d.bundled) {
                const delBtn = document.createElement('button');
                delBtn.className = 'file-card-delete';
                delBtn.innerHTML = '&times;';
                delBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (confirm('Delete "' + d.name + '"?')) {
                        await dbDelete('documents', d.id);
                        renderDocsGrid();
                    }
                });
                card.appendChild(delBtn);
            }

            card.addEventListener('click', () => openViewer(d.bundled ? d.url : d.dataUrl, d.name, isPDF));
            grid.appendChild(card);
        });
    }

    // ===== Checklists (aircraft folders) =====
    function addAircraft() {
        const name = prompt('Enter aircraft type/tail (e.g. C172 N12345):');
        if (!name || !name.trim()) return;
        const id = name.trim().toUpperCase();
        const list = JSON.parse(localStorage.getItem('pilot-efb-aircraft') || '[]');
        if (!list.includes(id)) { list.push(id); localStorage.setItem('pilot-efb-aircraft', JSON.stringify(list)); }
        renderChecklistsView();
    }

    async function deleteAircraft(code) {
        if (!confirm('Delete aircraft "' + code + '" and all its checklists?')) return;
        const all = await dbGetAll('checklists');
        for (const d of all.filter(c => c.aircraft === code)) await dbDelete('checklists', d.id);
        const list = JSON.parse(localStorage.getItem('pilot-efb-aircraft') || '[]').filter(a => a !== code);
        localStorage.setItem('pilot-efb-aircraft', JSON.stringify(list));
        renderChecklistsView();
    }

    async function uploadChecklist(files) {
        if (!currentAircraft) {
            const name = prompt('Enter aircraft type/tail for these checklists:');
            if (!name || !name.trim()) return;
            currentAircraft = name.trim().toUpperCase();
            const list = JSON.parse(localStorage.getItem('pilot-efb-aircraft') || '[]');
            if (!list.includes(currentAircraft)) { list.push(currentAircraft); localStorage.setItem('pilot-efb-aircraft', JSON.stringify(list)); }
        }
        for (const file of files) {
            if (!file.type.startsWith('image/') && file.type !== 'application/pdf') continue;
            const dataUrl = await fileToDataURL(file);
            await dbPut('checklists', {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                aircraft: currentAircraft,
                name: file.name,
                type: file.type,
                dataUrl: dataUrl,
                addedAt: Date.now()
            });
        }
        renderChecklistsView();
    }

    async function renderChecklistsView() {
        const grid = document.getElementById('checklists-grid');
        const title = document.getElementById('checklists-title');
        const backBtn = document.getElementById('btn-back-aircraft');
        const uploadBtn = document.getElementById('btn-upload-checklist');
        const addBtn = document.getElementById('btn-add-aircraft');
        const assets = await loadBundledAssets();

        if (!currentAircraft) {
            backBtn.style.display = 'none';
            uploadBtn.style.display = 'none';
            addBtn.style.display = 'flex';
            title.textContent = 'Aircraft';

            const userAircraft = JSON.parse(localStorage.getItem('pilot-efb-aircraft') || '[]');
            const bundledAircraft = Object.keys(assets.checklists || {});
            const allAircraftCodes = [...new Set([...bundledAircraft, ...userAircraft])];
            const allChecklists = await dbGetAll('checklists');
            const counts = {};
            allChecklists.forEach(c => { counts[c.aircraft] = (counts[c.aircraft] || 0) + 1; });
            bundledAircraft.forEach(code => {
                counts[code] = (counts[code] || 0) + (assets.checklists[code] || []).length;
            });

            grid.innerHTML = '';
            if (allAircraftCodes.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#556677; padding:40px;">No aircraft added yet. Tap "Add Aircraft" to create a folder.</div>';
                return;
            }

            allAircraftCodes.sort().forEach(code => {
                const isBundled = bundledAircraft.includes(code) && !userAircraft.includes(code);
                const folder = document.createElement('div');
                folder.className = 'airport-folder';

                const nameEl = document.createElement('div');
                nameEl.className = 'airport-folder-name';
                nameEl.textContent = code;

                const countEl = document.createElement('div');
                countEl.className = 'airport-folder-count';
                countEl.textContent = (counts[code] || 0) + ' checklist' + ((counts[code] || 0) !== 1 ? 's' : '');

                folder.appendChild(nameEl);
                folder.appendChild(countEl);

                if (!isBundled) {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'airport-folder-delete';
                    delBtn.innerHTML = '&times;';
                    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteAircraft(code); });
                    folder.appendChild(delBtn);
                }

                folder.addEventListener('click', () => { currentAircraft = code; renderChecklistsView(); });
                grid.appendChild(folder);
            });
        } else {
            backBtn.style.display = 'flex';
            uploadBtn.style.display = 'flex';
            addBtn.style.display = 'none';
            title.textContent = currentAircraft;

            const all = await dbGetAll('checklists');
            const userItems = all.filter(c => c.aircraft === currentAircraft).sort((a, b) => b.addedAt - a.addedAt);
            const bundledFiles = (assets.checklists[currentAircraft] || []).map(f => ({
                name: f,
                url: getBundledFileUrl('checklists', currentAircraft, f),
                type: f.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image',
                bundled: true
            }));

            const allItems = [...bundledFiles, ...userItems];
            grid.innerHTML = '';
            if (allItems.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#556677; padding:40px;">No checklists yet. Tap Upload to add.</div>';
                return;
            }

            allItems.forEach(d => {
                const card = document.createElement('div');
                card.className = 'file-card';
                const isPDF = d.bundled
                    ? d.type === 'application/pdf'
                    : (d.type === 'application/pdf' || d.name.toLowerCase().endsWith('.pdf'));

                if (isPDF) {
                    const thumb = document.createElement('div');
                    thumb.style.cssText = 'width:100%; aspect-ratio:3/4; display:flex; align-items:center; justify-content:center; background:#1e2d3d;';
                    thumb.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#cc4444" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><text x="7" y="17" font-size="5" fill="#cc4444" stroke="none" font-weight="bold">PDF</text></svg>';
                    card.appendChild(thumb);
                } else {
                    const img = document.createElement('img');
                    img.src = d.bundled ? d.url : d.dataUrl;
                    img.alt = d.name;
                    card.appendChild(img);
                }

                const label = document.createElement('div');
                label.className = 'file-card-label';
                label.textContent = d.name + (d.bundled ? ' \u{1F4CC}' : '');

                card.appendChild(label);

                if (!d.bundled) {
                    const delBtn = document.createElement('button');
                    delBtn.className = 'file-card-delete';
                    delBtn.innerHTML = '&times;';
                    delBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (confirm('Delete "' + d.name + '"?')) {
                            await dbDelete('checklists', d.id);
                            renderChecklistsView();
                        }
                    });
                    card.appendChild(delBtn);
                }

                card.addEventListener('click', () => openViewer(d.bundled ? d.url : d.dataUrl, d.name, isPDF));
                grid.appendChild(card);
            });
        }
    }

    // ===== Viewer with pan & zoom =====
    let viewerState = { scale: 1, x: 0, y: 0, img: null };
    let viewerPointers = new Map();
    let viewerPinchStartDist = 0;
    let viewerPinchStartScale = 1;
    let viewerPanStart = { x: 0, y: 0, vx: 0, vy: 0 };

    function openViewer(dataUrl, name, isPDF) {
        const viewer = document.getElementById('file-viewer');
        const content = document.getElementById('viewer-content');
        content.innerHTML = '';

        if (isPDF) {
            content.style.touchAction = '';
            const iframe = document.createElement('iframe');
            iframe.src = dataUrl;
            iframe.style.cssText = 'width:100%; height:100%; border:none; background:#fff;';
            content.appendChild(iframe);
            viewer.style.display = 'flex';
            return;
        }

        content.style.touchAction = 'none';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.alt = name;
        img.addEventListener('load', () => {
            const cw = content.clientWidth;
            const ch = content.clientHeight;
            const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
            viewerState.scale = scale;
            viewerState.x = (cw - img.naturalWidth * scale) / 2;
            viewerState.y = (ch - img.naturalHeight * scale) / 2;
            viewerState.img = img;
            applyViewerTransform();
        });
        content.appendChild(img);
        viewer.style.display = 'flex';

        content.addEventListener('pointerdown', viewerPointerDown);
        content.addEventListener('pointermove', viewerPointerMove);
        content.addEventListener('pointerup', viewerPointerUp);
        content.addEventListener('pointercancel', viewerPointerUp);
        content.addEventListener('wheel', viewerWheel, { passive: false });
    }

    function closeViewer() {
        const viewer = document.getElementById('file-viewer');
        const content = document.getElementById('viewer-content');
        content.removeEventListener('pointerdown', viewerPointerDown);
        content.removeEventListener('pointermove', viewerPointerMove);
        content.removeEventListener('pointerup', viewerPointerUp);
        content.removeEventListener('pointercancel', viewerPointerUp);
        content.removeEventListener('wheel', viewerWheel);
        viewer.style.display = 'none';
        content.innerHTML = '';
        viewerPointers.clear();
        viewerState = { scale: 1, x: 0, y: 0, img: null };
    }

    function applyViewerTransform() {
        if (!viewerState.img) return;
        viewerState.img.style.transform = 'translate(' + viewerState.x + 'px,' + viewerState.y + 'px) scale(' + viewerState.scale + ')';
    }

    function viewerPointerDown(e) {
        e.preventDefault();
        viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        e.currentTarget.setPointerCapture(e.pointerId);
        if (viewerPointers.size === 1) {
            viewerPanStart = { x: e.clientX, y: e.clientY, vx: viewerState.x, vy: viewerState.y };
        } else if (viewerPointers.size === 2) {
            const pts = [...viewerPointers.values()];
            viewerPinchStartDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            viewerPinchStartScale = viewerState.scale;
        }
    }

    function viewerPointerMove(e) {
        if (!viewerPointers.has(e.pointerId)) return;
        e.preventDefault();
        viewerPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (viewerPointers.size === 1) {
            viewerState.x = viewerPanStart.vx + (e.clientX - viewerPanStart.x);
            viewerState.y = viewerPanStart.vy + (e.clientY - viewerPanStart.y);
            applyViewerTransform();
        } else if (viewerPointers.size === 2) {
            const pts = [...viewerPointers.values()];
            const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            const midX = (pts[0].x + pts[1].x) / 2;
            const midY = (pts[0].y + pts[1].y) / 2;
            const content = document.getElementById('viewer-content');
            const rect = content.getBoundingClientRect();
            const cx = midX - rect.left;
            const cy = midY - rect.top;
            const newScale = Math.max(0.5, Math.min(10, viewerPinchStartScale * (dist / viewerPinchStartDist)));
            const ratio = newScale / viewerState.scale;
            viewerState.x = cx - ratio * (cx - viewerState.x);
            viewerState.y = cy - ratio * (cy - viewerState.y);
            viewerState.scale = newScale;
            applyViewerTransform();
        }
    }

    function viewerPointerUp(e) {
        viewerPointers.delete(e.pointerId);
        if (viewerPointers.size === 1) {
            const pt = [...viewerPointers.values()][0];
            viewerPanStart = { x: pt.x, y: pt.y, vx: viewerState.x, vy: viewerState.y };
        }
    }

    function viewerWheel(e) {
        e.preventDefault();
        const content = document.getElementById('viewer-content');
        const rect = content.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const newScale = Math.max(0.5, Math.min(10, viewerState.scale * factor));
        const ratio = newScale / viewerState.scale;
        viewerState.x = cx - ratio * (cx - viewerState.x);
        viewerState.y = cy - ratio * (cy - viewerState.y);
        viewerState.scale = newScale;
        applyViewerTransform();
    }

    // ===== Drawing state =====
    function getCurrentState() {
        return activeMode === 'atis' ? atisState : scratchpadState;
    }

    function getColors() {
        if (activeMode === 'atis') return THEMES.dark;
        return THEMES[scratchpadTheme];
    }

    function resizeCanvases() {
        const dpr = window.devicePixelRatio || 1;
        const w = container.clientWidth;
        const h = container.clientHeight;
        templateCanvas.width = w * dpr;
        templateCanvas.height = h * dpr;
        templateCanvas.style.width = w + 'px';
        templateCanvas.style.height = h + 'px';
        templateCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawingCanvas.width = w * dpr;
        drawingCanvas.height = h * dpr;
        drawingCanvas.style.width = w + 'px';
        drawingCanvas.style.height = h + 'px';
        drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        renderTemplate();
        redrawStrokes();
    }

    function renderTemplate() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        const ctx = templateCtx;
        const colors = getColors();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, w, h);
        if (activeMode === 'scratchpad') return;

        const rows = [
            { y: 0, h: 0.12 }, { y: 0.12, h: 0.10 },
            { y: 0.22, h: 0.12 }, { y: 0.34, h: 0.12 }, { y: 0.46, h: 0.12 },
            { y: 0.58, h: 0.12 }, { y: 0.70, h: 0.12 }, { y: 0.82, h: 0.18 }
        ];
        ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;

        drawCell(ctx, 0, rows[0].y * h, w * 0.33, rows[0].h * h, 'AIRPORT', colors);
        drawCell(ctx, w * 0.33, rows[0].y * h, w * 0.34, rows[0].h * h, 'INFORMATION', colors);
        drawCell(ctx, w * 0.67, rows[0].y * h, w * 0.33, rows[0].h * h, 'TIME', colors);

        const r2y = rows[1].y * h, r2h = rows[1].h * h;
        ctx.strokeStyle = colors.grid;
        ctx.strokeRect(0, r2y, w * 0.65, r2h);
        ctx.strokeRect(w * 0.65, r2y, w * 0.35, r2h);
        ctx.fillStyle = colors.label; ctx.font = 'bold 14px -apple-system, sans-serif';
        ctx.fillText('WIND', 8, r2y + 18);
        ctx.fillStyle = colors.helper; ctx.font = '16px -apple-system, sans-serif';
        ctx.fillText('@', w * 0.20, r2y + r2h / 2 + 6);
        ctx.fillText('G', w * 0.38, r2y + r2h / 2 + 6);
        ctx.fillStyle = colors.label; ctx.font = 'bold 14px -apple-system, sans-serif';
        ctx.fillText('VISIBILITY', w * 0.65 + 8, r2y + 18);

        ctx.fillStyle = colors.label; ctx.font = 'bold 14px -apple-system, sans-serif';
        ctx.fillText('SKY', 8, rows[2].y * h + 18);
        for (let i = 0; i < 3; i++) {
            const ry = rows[2 + i].y * h, rh = rows[2 + i].h * h;
            ctx.strokeStyle = colors.grid;
            ctx.strokeRect(0, ry, w * 0.65, rh);
            ctx.strokeRect(w * 0.65, ry, w * 0.35, rh);
            const mid = ry + rh / 2 + 5;
            ctx.fillStyle = colors.helper; ctx.font = '13px -apple-system, sans-serif';
            ['OVC', 'BKN', 'SCT', 'FEW'].forEach((l, j) => ctx.fillText(l, 20 + j * w * 0.12, mid));
            ctx.fillText('@', 20 + 4 * w * 0.12, mid);
            ctx.fillText('CLR', w * 0.70, mid);
            ctx.fillText('SKC', w * 0.85, mid);
        }

        const r6y = rows[5].y * h, r6h = rows[5].h * h;
        drawCell(ctx, 0, r6y, w * 0.33, r6h, 'TEMP', colors);
        drawCell(ctx, w * 0.33, r6y, w * 0.34, r6h, 'DEWPOINT', colors);
        drawCell(ctx, w * 0.67, r6y, w * 0.33, r6h, 'ALTIMETER', colors);

        const r7y = rows[6].y * h, r7h = (rows[6].h + rows[7].h) * h;
        ctx.strokeStyle = colors.grid;
        ctx.strokeRect(0, r7y, w * 0.45, r7h);
        ctx.strokeRect(w * 0.45, r7y, w * 0.55, r7h);
        ctx.fillStyle = colors.label; ctx.font = 'bold 14px -apple-system, sans-serif';
        ctx.fillText('EXPECT RWY', 8, r7y + 18);
        ctx.fillText('REMARKS', w * 0.45 + 8, r7y + 18);
    }

    function drawCell(ctx, x, y, w, h, label, colors) {
        ctx.strokeStyle = colors.grid;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = colors.label; ctx.font = 'bold 14px -apple-system, sans-serif';
        ctx.fillText(label, x + 8, y + 18);
    }

    // ===== Drawing engine =====
    function getPointerPos(e) {
        const rect = drawingCanvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) * (container.clientWidth / rect.width),
            y: (e.clientY - rect.top) * (container.clientHeight / rect.height),
            pressure: e.pressure || 0.5
        };
    }

    function distToSegment(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - ax, py - ay);
        let t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    }

    function findStrokeAtPoint(x, y) {
        for (let i = strokes.length - 1; i >= 0; i--) {
            const s = strokes[i];
            for (let j = 1; j < s.points.length; j++) {
                if (distToSegment(x, y, s.points[j-1].x, s.points[j-1].y, s.points[j].x, s.points[j].y) < 10 + s.lineWidth) return i;
            }
        }
        return -1;
    }

    function eraseAtPoint(x, y) {
        const idx = findStrokeAtPoint(x, y);
        if (idx >= 0) {
            redoStack.push(strokes.splice(idx, 1)[0]);
            redrawStrokes();
            scheduleSave();
        }
    }

    function startStroke(e) {
        if (e.pointerType === 'touch' && penPointerActive) return;
        if (isDrawing) return;
        e.preventDefault();
        if (e.pointerType === 'pen') penPointerActive = true;
        activePointerId = e.pointerId;
        drawingCanvas.setPointerCapture(e.pointerId);
        isDrawing = true;
        const pos = getPointerPos(e);
        if (getCurrentState().settings.activeTool === 'eraser') { eraseAtPoint(pos.x, pos.y); return; }
        currentStroke = { tool: 'pen', lineWidth: getCurrentState().settings.penSize, points: [pos] };
        drawCtx.beginPath(); drawCtx.moveTo(pos.x, pos.y);
    }

    function continueStroke(e) {
        if (!isDrawing || e.pointerId !== activePointerId) return;
        e.preventDefault();
        const pos = getPointerPos(e);
        if (getCurrentState().settings.activeTool === 'eraser') { eraseAtPoint(pos.x, pos.y); return; }
        currentStroke.points.push(pos);
        const prev = currentStroke.points[currentStroke.points.length - 2];
        const colors = getColors();
        drawCtx.strokeStyle = colors.ink;
        drawCtx.lineWidth = currentStroke.lineWidth * (0.5 + pos.pressure);
        drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
        drawCtx.beginPath(); drawCtx.moveTo(prev.x, prev.y); drawCtx.lineTo(pos.x, pos.y); drawCtx.stroke();
    }

    function endStroke(e) {
        if (!isDrawing || e.pointerId !== activePointerId) return;
        e.preventDefault();
        if (e.pointerType === 'pen') penPointerActive = false;
        isDrawing = false; activePointerId = null;
        if (getCurrentState().settings.activeTool === 'eraser') { currentStroke = null; return; }
        if (currentStroke && currentStroke.points.length > 1) { strokes.push(currentStroke); redoStack = []; scheduleSave(); }
        currentStroke = null;
    }

    function redrawStrokes() {
        const w = container.clientWidth, h = container.clientHeight;
        const colors = getColors();
        drawCtx.clearRect(0, 0, w, h);
        for (const stroke of strokes) {
            if (stroke.points.length < 2) continue;
            drawCtx.strokeStyle = colors.ink; drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
            for (let i = 1; i < stroke.points.length; i++) {
                const prev = stroke.points[i-1], curr = stroke.points[i];
                drawCtx.lineWidth = stroke.lineWidth * (0.5 + curr.pressure);
                drawCtx.beginPath(); drawCtx.moveTo(prev.x, prev.y); drawCtx.lineTo(curr.x, curr.y); drawCtx.stroke();
            }
        }
    }

    // ===== Tools =====
    function undo() { if (!strokes.length) return; redoStack.push(strokes.pop()); redrawStrokes(); scheduleSave(); }
    function redo() { if (!redoStack.length) return; strokes.push(redoStack.pop()); redrawStrokes(); scheduleSave(); }
    function clearAll() {
        if (!strokes.length) return;
        if (!confirm('Clear all drawings on this page?')) return;
        strokes = []; redoStack = []; redrawStrokes(); scheduleSave();
    }

    function saveAsImage() {
        const w = templateCanvas.width, h = templateCanvas.height;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.drawImage(templateCanvas, 0, 0); cx.drawImage(drawingCanvas, 0, 0);
        const state = getCurrentState();
        const page = state.pages.find(p => p.id === state.activePageId);
        const filename = (page ? page.label : activeMode).replace(/\s+/g, '_') + '.png';
        c.toBlob(blob => {
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(a.href);
        }, 'image/png');
    }

    function setTool(tool) {
        getCurrentState().settings.activeTool = tool;
        document.getElementById('btn-pen').classList.toggle('active', tool === 'pen');
        document.getElementById('btn-eraser').classList.toggle('active', tool === 'eraser');
        scheduleSave();
    }

    function cycleSize() {
        const s = getCurrentState();
        s.settings.penSize = SIZES[(SIZES.indexOf(s.settings.penSize) + 1) % SIZES.length];
        document.getElementById('btn-size').textContent = s.settings.penSize + ' px';
        scheduleSave();
    }

    function toggleTheme() {
        scratchpadTheme = scratchpadTheme === 'dark' ? 'light' : 'dark';
        container.classList.toggle('light', scratchpadTheme === 'light');
        renderTemplate(); redrawStrokes(); scheduleSave();
    }

    // ===== Mode switching =====
    function switchMode(mode) {
        if (mode === activeMode) return;
        if (activeMode === 'atis' || activeMode === 'scratchpad') saveCurrentPage();
        activeMode = mode;

        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));

        const isCanvas = mode === 'atis' || mode === 'scratchpad';
        document.getElementById('toolbar').style.display = isCanvas ? 'flex' : 'none';
        container.style.display = isCanvas ? 'block' : 'none';
        document.getElementById('page-bar').style.display = isCanvas ? 'flex' : 'none';
        document.getElementById('diagrams-container').style.display = mode === 'diagrams' ? 'block' : 'none';
        document.getElementById('documents-container').style.display = mode === 'documents' ? 'block' : 'none';
        document.getElementById('checklists-container').style.display = mode === 'checklists' ? 'block' : 'none';
        document.getElementById('theme-group').style.display = mode === 'scratchpad' ? 'flex' : 'none';
        container.classList.toggle('light', mode === 'scratchpad' && scratchpadTheme === 'light');

        if (mode === 'diagrams') { currentAirport = null; renderDiagramsView(); return; }
        if (mode === 'documents') { renderDocsGrid(); return; }
        if (mode === 'checklists') { currentAircraft = null; renderChecklistsView(); return; }

        const state = getCurrentState();
        if (!state.pages.length) { createPage(); return; }
        const page = state.pages.find(p => p.id === state.activePageId) || state.pages[0];
        state.activePageId = page.id;
        strokes = JSON.parse(JSON.stringify(page.strokes)); redoStack = [];
        document.getElementById('btn-size').textContent = state.settings.penSize + ' px';
        setTool(state.settings.activeTool);
        renderPageTabs(); resizeCanvases();
    }

    // ===== Page management =====
    function createPage() {
        const state = getCurrentState();
        if (state.pages.length >= 20) { alert('Maximum 20 pages reached.'); return; }
        const prefix = activeMode === 'atis' ? 'ATIS' : 'Pad';
        const page = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), label: prefix + ' ' + (state.pages.length + 1), strokes: [] };
        saveCurrentPage(); state.pages.push(page); state.activePageId = page.id;
        strokes = []; redoStack = []; redrawStrokes(); renderPageTabs(); scheduleSave();
    }

    function switchPage(pageId) {
        const state = getCurrentState();
        if (pageId === state.activePageId) return;
        saveCurrentPage(); state.activePageId = pageId;
        const page = state.pages.find(p => p.id === pageId);
        strokes = page ? JSON.parse(JSON.stringify(page.strokes)) : []; redoStack = [];
        redrawStrokes(); renderPageTabs();
    }

    function deletePage(pageId) {
        const state = getCurrentState();
        if (state.pages.length <= 1) return;
        const page = state.pages.find(p => p.id === pageId);
        if (page && page.strokes.length > 0 && !confirm('Delete "' + page.label + '"?')) return;
        const idx = state.pages.findIndex(p => p.id === pageId);
        state.pages.splice(idx, 1);
        if (state.activePageId === pageId) {
            const ni = Math.min(idx, state.pages.length - 1);
            state.activePageId = state.pages[ni].id;
            strokes = JSON.parse(JSON.stringify(state.pages[ni].strokes)); redoStack = []; redrawStrokes();
        }
        renderPageTabs(); scheduleSave();
    }

    function saveCurrentPage() {
        const state = getCurrentState();
        const page = state.pages.find(p => p.id === state.activePageId);
        if (page) page.strokes = JSON.parse(JSON.stringify(strokes));
    }

    function renderPageTabs() {
        const state = getCurrentState();
        const tabsEl = document.getElementById('page-tabs');
        tabsEl.innerHTML = '';
        state.pages.forEach(page => {
            const btn = document.createElement('button');
            btn.className = 'page-tab' + (page.id === state.activePageId ? ' active' : '');
            btn.textContent = page.label;
            btn.addEventListener('click', () => switchPage(page.id));
            let t = null;
            btn.addEventListener('pointerdown', () => { if (state.pages.length > 1) t = setTimeout(() => deletePage(page.id), 600); });
            btn.addEventListener('pointerup', () => clearTimeout(t));
            btn.addEventListener('pointercancel', () => clearTimeout(t));
            btn.addEventListener('pointermove', () => clearTimeout(t));
            btn.addEventListener('contextmenu', e => { e.preventDefault(); if (state.pages.length > 1) deletePage(page.id); });
            tabsEl.appendChild(btn);
        });
    }

    // ===== Persistence =====
    function scheduleSave() { clearTimeout(saveTimeout); saveTimeout = setTimeout(save, 500); }

    function save() {
        saveCurrentPage();
        const data = {
            version: 3, activeMode, scratchpadTheme,
            atis: { pages: atisState.pages, activePageId: atisState.activePageId, settings: atisState.settings },
            scratchpad: { pages: scratchpadState.pages, activePageId: scratchpadState.activePageId, settings: scratchpadState.settings }
        };
        try { localStorage.setItem('pilot-efb-data', JSON.stringify(data)); } catch (e) {}
    }

    function load() {
        try {
            const raw = localStorage.getItem('pilot-efb-data');
            if (raw) {
                const data = JSON.parse(raw);
                if (data.version >= 2) {
                    activeMode = data.activeMode || 'atis';
                    if (activeMode === 'diagrams' || activeMode === 'documents' || activeMode === 'checklists') activeMode = 'atis';
                    scratchpadTheme = data.scratchpadTheme || 'dark';
                    atisState = data.atis || atisState;
                    scratchpadState = data.scratchpad || scratchpadState;
                }
            }
        } catch (e) {}

        document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === activeMode));
        document.getElementById('theme-group').style.display = activeMode === 'scratchpad' ? 'flex' : 'none';
        container.classList.toggle('light', activeMode === 'scratchpad' && scratchpadTheme === 'light');

        const state = getCurrentState();
        if (!state.pages.length) { createPage(); return; }
        const page = state.pages.find(p => p.id === state.activePageId) || state.pages[0];
        state.activePageId = page.id;
        strokes = JSON.parse(JSON.stringify(page.strokes)); redoStack = [];
        document.getElementById('btn-size').textContent = state.settings.penSize + ' px';
        setTool(state.settings.activeTool);
        renderPageTabs();
    }

    // ===== Event listeners =====
    drawingCanvas.addEventListener('pointerdown', startStroke);
    drawingCanvas.addEventListener('pointermove', continueStroke);
    drawingCanvas.addEventListener('pointerup', endStroke);
    drawingCanvas.addEventListener('pointercancel', endStroke);

    document.getElementById('btn-pen').addEventListener('click', () => setTool('pen'));
    document.getElementById('btn-eraser').addEventListener('click', () => setTool('eraser'));
    document.getElementById('btn-size').addEventListener('click', cycleSize);
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-redo').addEventListener('click', redo);
    document.getElementById('btn-clear').addEventListener('click', clearAll);
    document.getElementById('btn-save').addEventListener('click', saveAsImage);
    document.getElementById('btn-add-page').addEventListener('click', createPage);
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);
    document.getElementById('btn-close-viewer').addEventListener('click', closeViewer);

    // Diagrams
    document.getElementById('btn-add-airport').addEventListener('click', addAirport);
    document.getElementById('btn-back-airports').addEventListener('click', () => { currentAirport = null; renderDiagramsView(); });
    document.getElementById('btn-upload-diagram').addEventListener('click', () => document.getElementById('diagram-file-input').click());
    document.getElementById('diagram-file-input').addEventListener('change', (e) => {
        if (e.target.files.length) { uploadDiagram(e.target.files); e.target.value = ''; }
    });

    // Documents
    document.getElementById('btn-upload-doc').addEventListener('click', () => document.getElementById('doc-file-input').click());
    document.getElementById('doc-file-input').addEventListener('change', (e) => {
        if (e.target.files.length) { uploadDoc(e.target.files); e.target.value = ''; }
    });

    // Checklists
    document.getElementById('btn-add-aircraft').addEventListener('click', addAircraft);
    document.getElementById('btn-back-aircraft').addEventListener('click', () => { currentAircraft = null; renderChecklistsView(); });
    document.getElementById('btn-upload-checklist').addEventListener('click', () => document.getElementById('checklist-file-input').click());
    document.getElementById('checklist-file-input').addEventListener('change', (e) => {
        if (e.target.files.length) { uploadChecklist(e.target.files); e.target.value = ''; }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchMode(btn.dataset.mode)));
    window.addEventListener('resize', () => { if (activeMode === 'atis' || activeMode === 'scratchpad') resizeCanvases(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
    window.addEventListener('beforeunload', save);
    document.addEventListener('touchmove', (e) => { if (e.target === drawingCanvas) e.preventDefault(); }, { passive: false });

    // Init
    openDB().then(() => {
        resizeCanvases();
        load();
    }).catch((err) => {
        console.error('Failed to open database:', err);
        resizeCanvases();
        load();
    });
})();

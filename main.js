import JSZip from 'jszip';
import { getAllUserProjectsGenerator } from './api_user.js';
import { getProjectHtml } from './api_html.js';
import { getAssets, processAssets } from './api_assets.js';
import { getAllProjectRevisions, getProjectById, getProjectBySlug } from './api_project.js';
import { addToCatalog, isArchived, getCatalogAsArray, clearCatalog } from './catalog.js';

// --- State ---
const SETTINGS_KEY = 'websim_archiver_settings';
let isRunning = false;
let stopRequested = false;
let foundProjects = [];
let processedCount = 0;
const projectSignals = {}; // Map<projectId, { skip: Function }>

// Limits
const CONCURRENCY_LIMIT = 3; // Number of simultaneous project fetches
const PROJECT_TIMEOUT_MS = 1000 * 60 * 10; // 10 Minutes max per project (Increased)
const REVISION_TIMEOUT_MS = 1000 * 45; // 45 Seconds max per revision attempt
const BATCH_SIZE_LIMIT = 450 * 1024 * 1024; // 450MB
const PROJECT_SPLIT_LIMIT = 300 * 1024 * 1024; // 300MB

// --- Batch Management ---
// Handles thread-safe access to the shared zip for Batch Mode
const batchManager = {
    zip: null,
    currentSize: 0,
    part: 1,
    locked: false,
    username: 'backup',
    btnRef: null,

    init(username, btnElement) {
        this.zip = new JSZip();
        this.currentSize = 0;
        this.part = 1;
        this.locked = false;
        this.username = username;
        this.btnRef = btnElement;
    },

    async addFiles(pathPrefix, files) {
        // Simple Mutex to prevent race conditions during size checks/splitting
        while(this.locked) await new Promise(r => setTimeout(r, 100));
        this.locked = true;

        try {
            let addedSize = 0;
            for(const c of Object.values(files)) addedSize += c.byteLength;

            // Check Split
            if (this.currentSize + addedSize > BATCH_SIZE_LIMIT) {
                await this.flush();
            }

            // Write
            const folder = this.zip.folder(pathPrefix);
            for(const [path, content] of Object.entries(files)) {
                folder.file(path, content);
            }
            this.currentSize += addedSize;
        } finally {
            this.locked = false;
        }
    },

    async flush() {
        console.log(`[Batch] 📦 Splitting Batch Part ${this.part}...`);
        if (this.btnRef) this.btnRef.textContent = `Saving Part ${this.part}...`;
        
        try {
            const content = await this.zip.generateAsync({ type: "blob" });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = `${this.username}_part${this.part}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch(e) {
            console.error("[Batch] Flush failed:", e);
        }

        this.part++;
        this.zip = new JSZip();
        this.currentSize = 0;
        
        // Brief pause to let UI/Browser catch up
        await new Promise(r => setTimeout(r, 1000));
    },

    async finish(statElement) {
        if (this.currentSize === 0) return;
        while(this.locked) await new Promise(r => setTimeout(r, 100));
        this.locked = true;
        
        if (this.btnRef) this.btnRef.textContent = "Saving Final Zip...";
        try {
            const content = await this.zip.generateAsync({ type: "blob" }, (meta) => {
                if (statElement) statElement.textContent = `Zipping: ${meta.percent.toFixed(1)}%`;
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(content);
            a.download = `${this.username}_final_part${this.part}.zip`;
            a.click();
            URL.revokeObjectURL(a.href);
        } finally {
            this.locked = false;
        }
    }
};

// --- Zip Queue (Background Processing for Individual Mode) ---
const zipQueue = {
    queue: [],
    processing: false,
    add: function(task, uiId) {
        this.queue.push({ task, uiId });
        this.process();
    },
    process: async function() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        const { task, uiId } = this.queue.shift();
        
        try {
            if (uiId) updateStatus(uiId, 'loading', 'Zipping (BG)...');
            await task();
            if (uiId) updateStatus(uiId, 'done', 'Saved');
        } catch (e) {
            console.error("Background zip task failed", e);
            if (uiId) updateStatus(uiId, 'error', 'Zip Error');
        } finally {
            this.processing = false;
            setTimeout(() => this.process(), 200);
        }
    }
};

// --- DOM Elements ---
const usernameInput = document.getElementById('username');
const startBtn = document.getElementById('start-btn');
const resumeBtn = document.getElementById('resume-btn');
const stopBtn = document.getElementById('stop-btn');
const projectListEl = document.getElementById('project-list');
const statTotal = document.getElementById('stat-total');
const statProcessed = document.getElementById('stat-processed');
const statSize = document.getElementById('stat-size');

// Settings Elements
const dateStartInput = document.getElementById('date-start');
const dateEndInput = document.getElementById('date-end');
const downloadModeInput = document.getElementById('download-mode');
const delayInput = document.getElementById('delay-ms');
const skipForksInput = document.getElementById('skip-forks');
const includeHistoryInput = document.getElementById('include-history');
const skipArchivedInput = document.getElementById('skip-archived');

// History UI
const historyBtn = document.getElementById('history-btn');
const historyPanel = document.getElementById('history-panel');
const closeHistoryBtn = document.getElementById('close-history-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const historyListEl = document.getElementById('history-list');
const historyStatsEl = document.getElementById('history-stats');

// --- History Logic ---
const renderHistory = () => {
    const items = getCatalogAsArray();
    historyStatsEl.textContent = `${items.length} projects archived`;
    historyListEl.innerHTML = items.length === 0 
        ? '<div style="padding:2rem; text-align:center; color:var(--text-dim)">No history found.</div>' 
        : '';
    
    items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const dateStr = new Date(item.timestamp).toLocaleString();
        div.innerHTML = `
            <div class="history-item-info">
                <strong>${item.title}</strong>
                <span class="history-item-date">${item.username} / ${item.slug} • ${dateStr}</span>
            </div>
            <div class="status-icon done" style="width:20px; height:20px; font-size:0.7rem;">✓</div>
        `;
        historyListEl.appendChild(div);
    });
};

historyBtn.addEventListener('click', () => {
    renderHistory();
    historyPanel.classList.remove('hidden');
});

closeHistoryBtn.addEventListener('click', () => {
    historyPanel.classList.add('hidden');
});

clearHistoryBtn.addEventListener('click', () => {
    if(confirm('Clear all local download history? Processing will restart from scratch.')) {
        clearCatalog();
        renderHistory();
    }
});

// --- Resume Helper ---
const getResumeKey = (user) => `websim_archiver_resume_${user}`;

const checkResumeState = () => {
    const user = usernameInput.value.trim().replace('@', '');
    if (!user) {
        resumeBtn.style.display = 'none';
        return;
    }
    const raw = localStorage.getItem(getResumeKey(user));
    if (raw) {
        try {
            const data = JSON.parse(raw);
            if (data.cursor) {
                resumeBtn.style.display = 'inline-block';
                resumeBtn.textContent = `Resume (${data.processedCount || '?'} Done)`;
                return;
            }
        } catch(e) {}
    }
    resumeBtn.style.display = 'none';
};

const saveResumeState = (user, cursor, count) => {
    if (!user || !cursor) return;
    localStorage.setItem(getResumeKey(user), JSON.stringify({
        cursor,
        processedCount: count,
        timestamp: Date.now()
    }));
};

const clearResumeState = (user) => {
    localStorage.removeItem(getResumeKey(user));
    checkResumeState();
};

usernameInput.addEventListener('input', checkResumeState);
usernameInput.addEventListener('change', checkResumeState);

// --- Helpers ---
const generateGitRestoreScript = () => {
    return `#!/bin/bash
set -e

# WebSim Project Restoration Script
# Generated by WebSim Archiver

if [ -d ".git" ]; then
    echo "Error: .git directory already exists. Please run this in an empty folder or clean it first."
    exit 1
fi

echo "Initializing Git Repository..."
git init -b main

# Check for commit log
if [ ! -f "commit_log.txt" ]; then
    echo "Error: commit_log.txt not found."
    exit 1
fi

TOTAL_VERSIONS=$(wc -l < commit_log.txt)
CURRENT=0

echo "Found $TOTAL_VERSIONS versions to restore."

while IFS="|" read -r ver date author msg; do
    CURRENT=$((CURRENT+1))
    echo "[git-restore] Processing Version \${ver} (\${CURRENT}/\${TOTAL_VERSIONS})..."
    
    # 1. Clean working directory safely
    # Removes everything except .git, revisions, scripts, and logs
    find . -maxdepth 1 -not -name '.git' -not -name 'revisions' -not -name 'restore_git.sh' -not -name 'commit_log.txt' -not -name '.' -not -name '..' -exec rm -rf {} +
    
    # 2. Copy files from revision snapshot
    if [ -d "revisions/\${ver}" ]; then
        # Copy hidden files too if they exist, suppress error if empty
        cp -a "revisions/\${ver}/." . 2>/dev/null || true
    else
        echo "Warning: Revision \${ver} data not found, skipping files..."
    fi
    
    # 3. Git Commit
    git add .
    
    # Check for changes
    if git diff --cached --quiet; then
        echo "  - No changes detected (empty commit)."
        GIT_AUTHOR_DATE="\${date}" GIT_COMMITTER_DATE="\${date}" git commit --allow-empty -m "Version \${ver}: \${msg} (No Changes)" --author="\${author} <\${author}@websim.ai>" --quiet
    else
        GIT_AUTHOR_DATE="\${date}" GIT_COMMITTER_DATE="\${date}" git commit -m "Version \${ver}: \${msg}" --author="\${author} <\${author}@websim.ai>" --quiet
    fi
    
done < commit_log.txt

echo "----------------------------------------"
echo "Restoration Complete!"
echo "You can now delete the 'revisions' folder, 'commit_log.txt', and 'restore_git.sh'."
`;
};

const formatBytes = (bytes, decimals = 2) => {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

const createProjectElement = (project) => {
    // Robust fallback for project properties
    const safeTitle = project.title || project.name || project.slug || project.id || 'Untitled';
    const safeSlug = project.slug || project.id;
    const safeId = project.id;

    const el = document.createElement('div');
    el.className = 'project-item';
    el.id = `proj-${safeId}`;
    el.innerHTML = `
        <div class="status-icon pending" id="icon-${safeId}">●</div>
        <div class="project-info">
            <span class="project-name">${safeTitle}</span>
            <div class="project-meta">
                <span>/${safeSlug}</span>
                <span id="log-${safeId}" class="log-msg">Waiting...</span>
            </div>
        </div>
        <div class="project-actions">
            <button id="skip-rev-${safeId}" class="skip-btn" style="display:none;">Skip Rev</button>
        </div>
    `;
    return el;
};

const updateStatus = (projectId, status, msg) => {
    const icon = document.getElementById(`icon-${projectId}`);
    const log = document.getElementById(`log-${projectId}`);
    if (!icon || !log) return;

    // Reset classes
    icon.className = 'status-icon';
    if (status === 'loading') icon.classList.add('loading');
    else if (status === 'done') icon.classList.add('done');
    else if (status === 'error') icon.classList.add('error');
    else if (status === 'warning') icon.classList.add('warning');
    else icon.classList.add('pending');

    icon.textContent = status === 'done' ? '✓' : (status === 'error' ? '!' : (status === 'warning' ? '⚠' : '●'));
    log.textContent = msg;
};

// --- Core Logic ---

// Helper: Timeout Wrapper
const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms))
]);

async function processProject(project, username, options) {
    if (stopRequested) return;
    
    const { mode, includeHistory, promptMode } = options;
    const uiId = project.id; 

    const skipAssets = (promptMode === 'only');
    const savePrompts = (promptMode !== 'none');

    // Define a Writer Interface
    // Abstracts away whether we are writing to a local zip (Individual) or shared batch (Batch)
    let writer;

    if (mode === 'batch') {
        writer = {
            add: async (pathPrefix, files) => {
                await batchManager.addFiles(`${username}/${pathPrefix}`, files);
            },
            savePart: async (data, suffix) => { /* Managed by batchManager internally */ }
        };
    } else {
        // Individual Mode Writer
        let localZip = new JSZip();
        let localSize = 0;
        let localPart = 1;
        
        writer = {
            add: async (pathPrefix, files) => {
                const folder = localZip.folder(pathPrefix);
                let addedSize = 0;
                for (const [p, c] of Object.entries(files)) {
                    folder.file(p, c);
                    addedSize += c.byteLength;
                }
                localSize += addedSize;
                
                // History Split Check (Only for Individual Mode)
                if (localSize > PROJECT_SPLIT_LIMIT) {
                    await writer.flushPart(false);
                }
            },
            flushPart: async (isFinal, commitLogData) => {
                if (commitLogData) localZip.file("commit_log_part.txt", commitLogData);
                
                const suffix = (localPart === 1 && isFinal) ? '' : `_part${localPart}`;
                const zipToSave = localZip; // Capture current
                const pNum = localPart;

                zipQueue.add(async () => {
                    const blob = await zipToSave.generateAsync({ type: "blob" });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${username}_${project.slug || project.id}${suffix}.zip`;
                    a.click();
                    URL.revokeObjectURL(a.href);
                }, isFinal ? uiId : null);

                if (!isFinal) {
                    localPart++;
                    localZip = new JSZip(); // Reset
                    localSize = 0;
                }
            },
            finalize: async (commitLogData, restoreScript) => {
                if (commitLogData) localZip.file("commit_log.txt", commitLogData);
                if (restoreScript) localZip.file("restore_git.sh", restoreScript, { unixPermissions: "755" });
                await writer.flushPart(true);
            }
        };
    }

    console.log(`[Main] Processing project: ${project.id} (slug: ${project.slug})`);
    
    try {
        const projectFolderName = project.slug || project.id || `project_${project.id}`;
        
        // --- PATH 1: Full History ---
        if (includeHistory) {
            updateStatus(uiId, 'loading', 'Fetching revisions...');
            
            // Setup Skip Button
            const skipBtn = document.getElementById(`skip-rev-${uiId}`);
            if (skipBtn) {
                skipBtn.style.display = 'inline-block';
                skipBtn.onclick = () => {
                    if (projectSignals[uiId]?.skip) projectSignals[uiId].skip();
                };
            }

            // 1. Get All Revisions
            let revisions = await getAllProjectRevisions(project.id);
            if (!revisions || revisions.length === 0) {
                const fallbackVer = project.current_version || project.latest_version?.version || 1;
                revisions = [{
                    id: project.current_revision?.id, version: fallbackVer,
                    created_at: project.created_at, created_by: project.created_by
                }];
            }
            revisions.sort((a, b) => (a.version || 0) - (b.version || 0));
            
            // Dedupe
            const uniqueRevisions = [];
            const seenVersions = new Set();
            for (const r of revisions) {
                if (!seenVersions.has(r.version)) {
                    seenVersions.add(r.version);
                    uniqueRevisions.push(r);
                }
            }
            revisions = uniqueRevisions;

            console.log(`[History] Found ${revisions.length} revs for ${project.slug}`);
            
            // Save Prompt History (JSON)
            if (savePrompts) {
                const historyJson = JSON.stringify(revisions, null, 2);
                await writer.add(`${projectFolderName}`, { 
                    'project_history.json': new TextEncoder().encode(historyJson) 
                });
            }

            if (skipAssets) {
                updateStatus(uiId, 'done', 'History Saved (JSON)');
                if (mode === 'individual') await writer.finalize();
                processedCount++;
                statProcessed.textContent = processedCount;
                addToCatalog(project);
                return;
            }

            let commitLog = "";
            
            // 3. Loop Revisions
            for (let i = 0; i < revisions.length; i++) {
                if (stopRequested) throw new Error("Stopped by user");
                
                const rev = revisions[i];
                let vNum = rev.version ?? rev.revision_number ?? (i + 1);
                
                updateStatus(uiId, 'loading', `Rev ${vNum} (${i+1}/${revisions.length})`);
                
                let success = false;
                let attempts = 0;
                
                while (!success && attempts < 3) {
                    attempts++;
                    
                    // Create Skip Signal
                    let skipPromiseReject;
                    const skipPromise = new Promise((_, reject) => {
                        projectSignals[uiId] = { skip: () => reject(new Error("USER_SKIP")) };
                        skipPromiseReject = reject;
                    });
                    
                    // Create Timeout Signal
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error("REV_TIMEOUT")), REVISION_TIMEOUT_MS)
                    );

                    try {
                        // Work Task
                        const taskPromise = (async () => {
                            const [assetList, htmlContent] = await Promise.all([
                                getAssets(project.id, vNum),
                                getProjectHtml(project.id, vNum)
                            ]);
                            const files = await processAssets(assetList, project.id, vNum);
                            
                            if (htmlContent) files['index.html'] = new TextEncoder().encode(htmlContent);
                            else if (!files['index.html']) files['index.html'] = new TextEncoder().encode(`<!-- Version ${vNum}: Missing -->`);
                            
                            await writer.add(`${projectFolderName}/revisions/${vNum}`, files);
                        })();

                        // RACE: Task vs Skip vs Timeout
                        await Promise.race([taskPromise, skipPromise, timeoutPromise]);

                        // Success Logic
                        const date = rev.created_at || new Date().toISOString();
                        const author = rev.created_by?.username || username || 'unknown';
                        const msg = (rev.title || rev.note || rev.description || `Version ${vNum}`).replace(/[\r\n|]+/g, ' ');
                        commitLog += `${vNum}|${date}|${author}|${msg}\n`;
                        success = true;

                    } catch (revError) {
                        const isSkip = revError.message === "USER_SKIP";
                        const isTimeout = revError.message === "REV_TIMEOUT";
                        
                        if (isSkip) {
                            console.warn(`[History] Skipped Rev ${vNum} by user.`);
                            commitLog += `${vNum}|${new Date().toISOString()}|system|SKIPPED_BY_USER\n`;
                            success = true; // Treat as handled so we move to next rev
                        } else {
                            console.error(`[History] ⚠️ Rev ${vNum} attempt ${attempts} failed:`, revError);
                            
                            if (attempts >= 3 || isTimeout) {
                                const reason = isTimeout ? "TIMEOUT" : "FAILED";
                                commitLog += `${vNum}|${new Date().toISOString()}|system|${reason}\n`;
                            }
                            
                            if (!success && attempts < 3 && !isSkip) {
                                updateStatus(uiId, 'warning', `Retrying Rev ${vNum}...`);
                                await new Promise(r => setTimeout(r, 2000));
                            }
                        }
                    } finally {
                        delete projectSignals[uiId];
                    }
                }
            }
            
            if (skipBtn) skipBtn.style.display = 'none';

            // Finalize
            if (mode === 'individual') {
                await writer.finalize(commitLog, generateGitRestoreScript());
            } else {
                 // For Batch, we just dump the scripts as "files"
                 const metaFiles = {};
                 metaFiles['commit_log.txt'] = new TextEncoder().encode(commitLog);
                 metaFiles['restore_git.sh'] = new TextEncoder().encode(generateGitRestoreScript());
                 await writer.add(projectFolderName, metaFiles);
                 updateStatus(uiId, 'done', 'Packaged');
            }

        } else {
            // --- PATH 2: Latest Only ---
            updateStatus(uiId, 'loading', 'Fetching latest...');

            // Save Metadata (JSON) for Single Version
            if (savePrompts) {
                try {
                    const fullMeta = await getProjectById(project.id);
                    await writer.add(`${projectFolderName}`, { 
                        'project_meta.json': new TextEncoder().encode(JSON.stringify(fullMeta || project, null, 2)) 
                    });
                } catch(e) { console.warn("Failed to fetch full meta for prompt history", e); }
            }
            
            if (skipAssets) {
                updateStatus(uiId, 'done', 'Meta Saved (JSON)');
                if (mode === 'individual') await writer.finalize();
                processedCount++;
                statProcessed.textContent = processedCount;
                addToCatalog(project);
                return;
            }
            
            let versionId = project.current_version ?? project.latest_revision?.version ?? project.revision?.version;
            if (versionId == null) {
                 try {
                     const full = await getProjectById(project.id);
                     versionId = full?.current_version;
                     if (versionId == null) versionId = (await getAllProjectRevisions(project.id))?.[0]?.version;
                 } catch(e){}
            }
            if (versionId == null) throw new Error('No numeric version found');

            const [assetList, htmlContent] = await Promise.all([
                getAssets(project.id, versionId),
                getProjectHtml(project.id, versionId)
            ]);

            const files = await processAssets(assetList, project.id, versionId);
            const htmlBuffer = htmlContent ? new TextEncoder().encode(htmlContent) : new TextEncoder().encode(`<!-- Source missing -->`);
            files['index.html'] = htmlBuffer;

            // Write
            await writer.add(projectFolderName, files);

            if (mode === 'individual') {
                await writer.finalize();
            } else {
                updateStatus(uiId, 'done', 'Packaged');
            }
        }

        processedCount++;
        statProcessed.textContent = processedCount;
        addToCatalog(project);

    } catch (e) {
        console.error(`[Main] Error processing ${project.slug}:`, e);
        updateStatus(uiId, 'error', e.message.includes("Timeout") ? "Timed Out" : "Failed");
        throw e; // Propagate for concurrency pool
    } finally {
        const skipBtn = document.getElementById(`skip-rev-${uiId}`);
        if (skipBtn) skipBtn.style.display = 'none';
        delete projectSignals[uiId];
    }
}

function saveSettings() {
    const settings = {
        username: usernameInput.value,
        dateStart: dateStartInput.value,
        dateEnd: dateEndInput.value,
        downloadMode: downloadModeInput.value,
        promptMode: document.getElementById('prompt-mode').value,
        delay: delayInput.value,
        skipForks: skipForksInput.checked,
        includeHistory: includeHistoryInput.checked,
        skipArchived: skipArchivedInput.checked
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch(e){}
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);
        if (s.username) usernameInput.value = s.username;
        if (s.dateStart) dateStartInput.value = s.dateStart;
        if (s.dateEnd) dateEndInput.value = s.dateEnd;
        if (s.downloadMode) downloadModeInput.value = s.downloadMode;
        if (s.promptMode) document.getElementById('prompt-mode').value = s.promptMode;
        if (s.delay) delayInput.value = s.delay;
        if (s.skipForks !== undefined) skipForksInput.checked = s.skipForks;
        if (s.includeHistory !== undefined) includeHistoryInput.checked = s.includeHistory;
        if (s.skipArchived !== undefined) skipArchivedInput.checked = s.skipArchived;
    } catch(e) {
        console.warn("Failed to load settings", e);
    }
}

async function startBackup(isResume = false) {
    saveSettings();
    const username = usernameInput.value.trim().replace('@', '');
    if (!username) return alert('Please enter a username');

    // Read Settings
    const mode = downloadModeInput.value;
    const skipForks = skipForksInput.checked;
    const promptMode = document.getElementById('prompt-mode').value;
    // Force history if "Only Prompt History" is selected
    const includeHistory = includeHistoryInput.checked || promptMode === 'only'; 
    const skipArchived = skipArchivedInput.checked;
    
    const startDate = dateStartInput.value ? new Date(dateStartInput.value) : null;
    const endDate = dateEndInput.value ? new Date(dateEndInput.value) : null;

    console.log(`[Main] Backup config: User=${username}, Mode=${mode}, Concurrency=${CONCURRENCY_LIMIT}`);

    // Reset UI & Resume Logic
    isRunning = true;
    stopRequested = false;
    foundProjects = [];
    
    let startCursor = null;

    if (isResume) {
        const resumeData = JSON.parse(localStorage.getItem(getResumeKey(username)) || '{}');
        if (resumeData.cursor) {
            startCursor = resumeData.cursor;
            processedCount = resumeData.processedCount || 0;
            console.log(`[Main] Resuming from cursor: ${startCursor} (Previously processed: ${processedCount})`);
        }
    } else {
        processedCount = 0;
        clearResumeState(username);
        projectListEl.innerHTML = '';
        statTotal.textContent = '0';
        statProcessed.textContent = '0';
        statSize.textContent = '0 Bytes';
    }

    if (mode === 'batch') {
        batchManager.init(username, startBtn);
    }

    startBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = (mode === 'batch') ? "Stop & Save" : "Stop";
    usernameInput.disabled = true;

    // Concurrency Pool
    const activeTasks = new Set();
    
    try {
        const onCursorSaved = (nextCursor) => {
            saveResumeState(username, nextCursor, processedCount);
        };

        const generator = getAllUserProjectsGenerator(username, startCursor, onCursorSaved);
        
        for await (const project of generator) {
            if (stopRequested) break;

            // --- FILTERING ---
            if (startDate || endDate) {
                const pDate = new Date(project.created_at);
                if (startDate && pDate < startDate) continue;
                if (endDate && pDate > endDate) continue;
            }

            if (skipForks && project.parent_id) {
                continue;
            }

            foundProjects.push(project);
            statTotal.textContent = foundProjects.length;
            
            const el = createProjectElement(project);
            projectListEl.appendChild(el);

            if (!project.id) {
                updateStatus('unknown', 'error', 'Missing ID');
                continue;
            }

            if (skipArchived && isArchived(project.id)) {
                updateStatus(project.id, 'done', 'Skipped (Archived)');
                continue;
            }

            // --- CONCURRENCY CONTROL ---
            while (activeTasks.size >= CONCURRENCY_LIMIT) {
                // Wait for at least one task to finish
                await Promise.race(activeTasks);
            }
            
            // Start Task
            const taskPromise = withTimeout(
                processProject(project, username, { mode, includeHistory, promptMode }), 
                PROJECT_TIMEOUT_MS
            ).then(() => {
                activeTasks.delete(taskPromise);
            }).catch(err => {
                console.error(`Task failed for ${project.slug}:`, err);
                activeTasks.delete(taskPromise);
                // Already handled in processProject, but ensure removal from set
            });

            activeTasks.add(taskPromise);
            
            // Small jitter so we don't hammer API instantly with 3 requests
            await new Promise(r => setTimeout(r, 200));
        }

        // Wait for remaining
        if (activeTasks.size > 0) {
            statTotal.textContent = `${foundProjects.length} (Finishing...)`;
            await Promise.allSettled(activeTasks);
        }

    } catch (e) {
        console.error("[Main] Loop error:", e);
        const errDiv = document.createElement('div');
        errDiv.className = 'project-item';
        errDiv.style.borderColor = 'var(--error)';
        errDiv.innerHTML = `<div class="status-icon error">!</div> <div><strong>Scan Stopped</strong><br>Error: ${e.message}</div>`;
        projectListEl.prepend(errDiv);
    } finally {
        finishBackup(mode);
    }
}

resumeBtn.addEventListener('click', () => startBackup(true));

async function finishBackup(mode) {
    isRunning = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    stopBtn.textContent = "Stop";
    usernameInput.disabled = false;

    if (mode === 'individual') {
        alert(`Done! Processed ${processedCount} projects.`);
        return;
    }

    // Batch Mode Finalization
    if (mode === 'batch') {
        startBtn.textContent = "Finalizing...";
        startBtn.disabled = true;
        await batchManager.finish(statSize);
        startBtn.textContent = "Start Backup";
        startBtn.disabled = false;
    }
}

startBtn.addEventListener('click', startBackup);
stopBtn.addEventListener('click', () => {
    if (isRunning) {
        stopRequested = true;
        stopBtn.textContent = "Stopping...";
        stopBtn.disabled = true;
    }
});

loadSettings();
checkResumeState();
const DB_KEY = 'websim_archiver_catalog';

export function getCatalog() {
    try {
        const raw = localStorage.getItem(DB_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        console.error("Failed to load catalog:", e);
        return {};
    }
}

export function addToCatalog(project) {
    const db = getCatalog();
    // Handle different project shapes safely
    const username = project.created_by?.username || 
                     project.username || 
                     'unknown';
                     
    db[project.id] = {
        id: project.id,
        slug: project.slug,
        title: project.title || project.name || 'Untitled',
        username: username,
        timestamp: Date.now(),
        status: 'done'
    };
    try {
        localStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch(e) {
        console.warn("Catalog storage failed (quota?):", e);
    }
}

export function isArchived(projectId) {
    const db = getCatalog();
    return db[projectId] && db[projectId].status === 'done';
}

export function clearCatalog() {
    localStorage.removeItem(DB_KEY);
}

export function getCatalogAsArray() {
    const db = getCatalog();
    return Object.values(db).sort((a,b) => b.timestamp - a.timestamp);
}
import { makeRequest } from './core.js';

export async function getUserProjects(username, cursor = null) {
    const params = new URLSearchParams();
    params.set('first', '20'); // Fetch in batches
    if (cursor) params.set('after', cursor);
    
    // Note: The endpoint might return { projects: { data: [], meta: {} } } or just { data: [], meta: {} }
    // We handle this variation in the processor
    return makeRequest(`/users/${username}/projects?${params.toString()}`);
}

export async function* getAllUserProjectsGenerator(username, startCursor = null, onCursorSaved = null) {
    let hasNext = true;
    let cursor = startCursor;
    let pageCount = 0;
    const MAX_PAGES = 2000; // Increased safety cap
    
    console.log(`[API-User] Generator started for ${username}. Start Cursor: ${cursor || 'INITIAL'}`);

    while(hasNext && pageCount < MAX_PAGES) {
        console.log(`[API-User] Fetching page ${pageCount}, cursor: ${cursor}`);
        try {
            const response = await getUserProjects(username, cursor);
            
            let projects = [];
            let meta = null;

            // Handle various API return shapes
            if (response.projects) {
                projects = response.projects.data || [];
                meta = response.projects.meta;
            } else if (response.data) {
                projects = response.data;
                meta = response.meta;
            }

            console.log(`[API-User] Page ${pageCount} returned ${projects.length} projects.`);

            if (projects.length > 0) {
                // Debug log structure
                console.log('[API-User] First item keys:', Object.keys(projects[0]));
                if (projects[0].project) console.log('[API-User] First item has .project property');
                
                // Unwrapping logic if the API returns wrapped objects
                if (!projects[0].id && projects[0].project) {
                    console.log('[API-User] Unwrap: Mapping data.project to data...');
                    projects = projects.map(p => p.project);
                }
            }

            // Yield found projects individually
            for (const p of projects) {
                if (p) yield p;
            }

            if (meta && meta.has_next_page && meta.end_cursor) {
                cursor = meta.end_cursor;
                // Notify main app to save this cursor for resume capability
                if (onCursorSaved) onCursorSaved(cursor);
            } else {
                console.log(`[API-User] No more pages available (meta.has_next_page=${meta?.has_next_page}).`);
                hasNext = false;
            }

        } catch (e) {
            console.error("[API-User] Error fetching user projects page:", e);
            // If a page fails, we try to wait and retry once before throwing?
            // For now, we throw to let main loop handle retry or stop.
            throw e;
        }
        pageCount++;
    }
}
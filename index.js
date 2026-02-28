export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'POST' && url.pathname === '/process-group') {
            return await handleProcessGroup(request, env);
        }

        if (request.method === 'GET' && url.pathname === '/get-final-vtt') {
            return await handleGetFinalVtt(request, env);
        }

        return new Response('Not Found', { status: 404 });
    }
};

async function handleProcessGroup(request, env) {
    try {
        const { jobId, groupIndex, startTime, tsUrls } = await request.json();

        if (!jobId || groupIndex === undefined || startTime === undefined || !tsUrls) {
            return new Response('Missing parameters', { status: 400 });
        }

        const chunks = [];
        for (const tsUrl of tsUrls) {
            try {
                const response = await fetch(tsUrl);
                if (response.ok) {
                    const arrayBuffer = await response.arrayBuffer();
                    chunks.push(new Uint8Array(arrayBuffer));
                } else {
                    console.error(`Failed to fetch ${tsUrl}: ${response.statusText}`);
                }
            } catch (e) {
                console.error(`Error fetching ${tsUrl}: ${e.message}`);
            }
        }

        if (chunks.length === 0) {
            return new Response('No valid TS files found', { status: 400 });
        }

        // Merge chunks
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
        }

        // AI Whisper Inference
        const aiResponse = await env.AI.run('@cf/openai/whisper', {
            audio: [...merged],
        });

        if (!aiResponse) {
            return new Response('AI Model failed to return any response', { status: 500 });
        }

        // Whisper sometimes returns segments, sometimes just text. 
        // If segments is missing, we create a single segment from text if available.
        let segments = aiResponse.segments;

        if (!segments && aiResponse.text) {
            segments = [{
                start: 0,
                end: 30, // Default duration if unknown
                text: aiResponse.text
            }];
        }

        if (!segments || !Array.isArray(segments)) {
            return new Response('AI Model failed to return translatable segments or text', { status: 500 });
        }

        // Adjust timestamps in segments
        const adjustedSegments = segments.map(segment => ({
            ...segment,
            start: (segment.start || 0) + startTime,
            end: (segment.end || 0) + startTime
        }));

        // Store adjusted segments in KV
        const kvKey = `sub:${jobId}:${groupIndex}`;
        await env.SUBTITLE_KV.put(kvKey, JSON.stringify(adjustedSegments));

        return new Response(JSON.stringify({ success: true, key: kvKey }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(error.message, { status: 500 });
    }
}

async function handleGetFinalVtt(request, env) {
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
        return new Response('Missing jobId', { status: 400 });
    }

    // List all keys for this jobId
    const prefix = `sub:${jobId}:`;
    const list = await env.SUBTITLE_KV.list({ prefix });

    // Sort keys by groupIndex
    const sortedKeys = list.keys.sort((a, b) => {
        const indexA = parseInt(a.name.split(':').pop());
        const indexB = parseInt(b.name.split(':').pop());
        return indexA - indexB;
    });

    let vttContent = "WEBVTT\n\n";

    for (const key of sortedKeys) {
        const data = await env.SUBTITLE_KV.get(key.name);
        if (data) {
            const segments = JSON.parse(data);
            segments.forEach(segment => {
                vttContent += `${formatVttTime(segment.start)} --> ${formatVttTime(segment.end)}\n`;
                vttContent += `${segment.text.trim()}\n\n`;
            });
        }
    }

    return new Response(vttContent, {
        headers: {
            'Content-Type': 'text/vtt',
            'Content-Disposition': `attachment; filename="subtitles_${jobId}.vtt"`
        }
    });
}

function formatVttTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

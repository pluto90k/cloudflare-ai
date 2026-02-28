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

        if (!aiResponse || !aiResponse.vtt) {
            // If vtt is not available, we might need to handle JSON or other formats
            // Whisper usually returns { text: "...", vtt: "...", segments: [...] }
            return new Response('AI Model failed to return VTT', { status: 500 });
        }

        // Adjust timestamps in segments if VTT format is not easy to parse directly
        // Usually, whisper returns segments: [ { start: 0, end: 1.5, text: "..." }, ... ]
        const adjustedSegments = aiResponse.segments.map(segment => ({
            ...segment,
            start: segment.start + startTime,
            end: segment.end + startTime
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

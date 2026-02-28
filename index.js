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
        const body = await request.json();
        const { jobId, groupIndex, startTime, tsUrls, language } = body;

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
                }
            } catch (e) {
                console.error(`Error fetching ${tsUrl}: ${e.message}`);
            }
        }

        if (chunks.length === 0) {
            return new Response('No valid audio data found', { status: 400 });
        }

        // Merge audio segments for better context
        // Whisper works significantly better with longer audio chunks (up to 30s)
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const mergedAudio = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            mergedAudio.set(chunk, offset);
            offset += chunk.length;
        }

        // Use the much more powerful Large V3 Turbo model
        // Passing Uint8Array directly is the standard way to send binary data to Workers AI
        const aiResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
            audio: mergedAudio,
            task: 'transcribe',
            language: language || 'ko',
            temperature: 0.0,
            vad_filter: true
        });

        if (!aiResponse || (!aiResponse.segments && !aiResponse.text)) {
            return new Response('AI Model failed to produce results', { status: 500 });
        }

        let segments = aiResponse.segments;
        if (!segments && aiResponse.text) {
            segments = [{ start: 0, end: 10, text: aiResponse.text }];
        }

        // Adjust timestamps and filter empty results
        const adjustedSegments = segments
            .filter(seg => seg.text && seg.text.trim().length > 0)
            .map(seg => ({
                ...seg,
                start: (seg.start || 0) + startTime,
                end: (seg.end || 0) + startTime
            }));

        if (adjustedSegments.length === 0) {
            return new Response(JSON.stringify({ success: true, message: 'Silence detected' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

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

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
                const res = await fetch(tsUrl);
                if (res.ok) {
                    chunks.push(new Uint8Array(await res.arrayBuffer()));
                }
            } catch (e) {
                console.error(`Fetch error for ${tsUrl}:`, e);
            }
        }

        if (chunks.length === 0) {
            return new Response('No audio chunks fetched', { status: 400 });
        }

        // Merge all chunks into one
        const totalSize = chunks.reduce((acc, c) => acc + c.length, 0);
        const mergedAudio = new Uint8Array(totalSize);
        let offset = 0;
        for (const chunk of chunks) {
            mergedAudio.set(chunk, offset);
            offset += chunk.length;
        }

        const aiOptions = {
            audio: Array.from(mergedAudio),
            task: 'transcribe',
            temperature: 0.0,
            vad_filter: false
        };
        if (language) aiOptions.language = language;

        const aiResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', aiOptions);

        if (!aiResponse) {
            return new Response('AI processing failed', { status: 500 });
        }

        const detectedLanguage = aiResponse.language ||
            (aiResponse.transcription_info && aiResponse.transcription_info.language) ||
            "unknown";

        const segments = (aiResponse.segments || []).map(seg => ({
            ...seg,
            start: seg.start + startTime,
            end: seg.end + startTime
        }));

        const kvKey = `sub:${jobId}:${groupIndex}`;
        await env.SUBTITLE_KV.put(kvKey, JSON.stringify(segments));

        return new Response(JSON.stringify({
            success: true,
            key: kvKey,
            detectedLanguage: detectedLanguage
        }), {
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

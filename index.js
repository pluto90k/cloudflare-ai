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

        const allSegments = [];
        let currentOffset = startTime;
        let detectedLanguage = "";

        for (const tsUrl of tsUrls) {
            try {
                const response = await fetch(tsUrl);
                if (!response.ok) {
                    currentOffset += 10;
                    continue;
                }

                const arrayBuffer = await response.arrayBuffer();
                const audioData = new Uint8Array(arrayBuffer);

                const aiOptions = {
                    audio: Array.from(audioData),
                    task: 'transcribe',
                    temperature: 0.0,
                    vad_filter: false
                };
                if (language) aiOptions.language = language;

                const aiResponse = await env.AI.run('@cf/openai/whisper', aiOptions);
                const rawResponse = aiResponse; // For debug

                if (aiResponse) {
                    // Try to find detected language in various possible fields
                    const lang = aiResponse.language ||
                        (aiResponse.transcription_info && aiResponse.transcription_info.language);

                    if (!detectedLanguage && lang) {
                        detectedLanguage = lang;
                    }

                    const segments = aiResponse.segments || [];
                    const text = aiResponse.text || "";

                    if (segments.length > 0) {
                        segments.forEach(seg => {
                            if (!seg.text || seg.text.trim().length < 2) return;
                            allSegments.push({
                                ...seg,
                                start: (seg.start || 0) + currentOffset,
                                end: (seg.end || 0) + currentOffset
                            });
                        });
                    } else if (text.trim().length > 1) {
                        allSegments.push({
                            start: currentOffset,
                            end: currentOffset + 10,
                            text: text.trim()
                        });
                    }
                    allSegments.debugInfo = rawResponse; // Save last one
                }
            } catch (e) {
                console.error(`AI Error for ${tsUrl}:`, e);
            }
            currentOffset += 10;
        }

        if (allSegments.length === 0) {
            return new Response(JSON.stringify({
                success: true,
                message: 'No speech detected in this group',
                debug: allSegments.debugInfo || null
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const kvKey = `sub:${jobId}:${groupIndex}`;
        await env.SUBTITLE_KV.put(kvKey, JSON.stringify(allSegments));

        return new Response(JSON.stringify({
            success: true,
            key: kvKey,
            detectedLanguage: detectedLanguage || language || "unknown",
            rawAiResponse: allSegments.debugInfo || null
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

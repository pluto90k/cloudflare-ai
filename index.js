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
        let previousText = "";

        for (const tsUrl of tsUrls) {
            try {
                const response = await fetch(tsUrl);
                if (!response.ok) continue;

                const arrayBuffer = await response.arrayBuffer();
                const audioData = new Uint8Array(arrayBuffer);

                // Use the standard whisper model for better stability across diverse TS inputs
                // vad_filter is disabled to avoid over-aggressive silence detection
                const aiResponse = await env.AI.run('@cf/openai/whisper', {
                    audio: [...audioData],
                    task: 'transcribe',
                    language: language || 'ko',
                    initial_prompt: previousText,
                    temperature: 0.0,
                    vad_filter: false
                });

                if (!aiResponse) {
                    console.error(`AI returned no response for ${tsUrl}`);
                    currentOffset += 10;
                    continue;
                }

                const segments = aiResponse.segments;
                const text = aiResponse.text || "";

                if (segments && Array.isArray(segments) && segments.length > 0) {
                    segments.forEach(seg => {
                        allSegments.push({
                            ...seg,
                            start: (seg.start || 0) + currentOffset,
                            end: (seg.end || 0) + currentOffset
                        });
                    });

                    const lastSeg = segments[segments.length - 1];
                    currentOffset += lastSeg.end;
                    previousText = lastSeg.text.slice(-100);
                } else if (text.trim().length > 0) {
                    allSegments.push({
                        start: currentOffset,
                        end: currentOffset + 10,
                        text: text.trim()
                    });
                    currentOffset += 10;
                    previousText = text.trim().slice(-100);
                } else {
                    currentOffset += 10;
                }
            } catch (e) {
                console.error(`Error processing segment ${tsUrl}:`, e);
                currentOffset += 10;
            }
        }

        if (allSegments.length === 0) {
            return new Response(JSON.stringify({ success: true, message: 'No speech detected' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const kvKey = `sub:${jobId}:${groupIndex}`;
        await env.SUBTITLE_KV.put(kvKey, JSON.stringify(allSegments));

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

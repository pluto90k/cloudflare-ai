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
        let currentGroupStartTime = startTime;

        // Fetch all TS chunks first
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
            return new Response(JSON.stringify({ success: true, message: 'No valid audio files' }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Process in batches of 2 segments (~20s) for optimal context vs stability
        const batchSize = 2;
        for (let i = 0; i < chunks.length; i += batchSize) {
            const batch = chunks.slice(i, i + batchSize);
            const batchTotalLength = batch.reduce((acc, chunk) => acc + chunk.length, 0);
            const batchAudio = new Uint8Array(batchTotalLength);
            let offset = 0;
            for (const chunk of batch) {
                batchAudio.set(chunk, offset);
                offset += chunk.length;
            }

            try {
                // Large V3 Turbo with Direct TypedArray transfer
                const aiResponse = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
                    audio: batchAudio,
                    task: 'transcribe',
                    language: language || 'ko',
                    temperature: 0.0,
                    vad_filter: false
                });

                if (aiResponse) {
                    let segments = aiResponse.segments;
                    const text = aiResponse.text || "";

                    if (segments && Array.isArray(segments) && segments.length > 0) {
                        segments.forEach(seg => {
                            if (!seg.text || seg.text.trim().length === 0) return;

                            allSegments.push({
                                ...seg,
                                start: (seg.start || 0) + currentGroupStartTime,
                                end: (seg.end || 0) + currentGroupStartTime
                            });
                        });
                    } else if (text.trim().length > 0) {
                        // Fallback to full text if segments are missing
                        allSegments.push({
                            start: currentGroupStartTime,
                            end: currentGroupStartTime + (10 * batch.length),
                            text: text.trim()
                        });
                    }
                }
            } catch (e) {
                console.error(`Error processing batch starting at index ${i}:`, e);
            }
            // Increment global clock by 10s * number of segments in batch
            currentGroupStartTime += 10 * batch.length;
        }

        if (allSegments.length === 0) {
            return new Response(JSON.stringify({ success: true, message: 'No speech recognized' }), {
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
